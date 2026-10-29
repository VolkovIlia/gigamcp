#!/usr/bin/env node
// Локальный мост для расширения GigaMCP.
// Запускает stdio MCP-серверы (npx/uvx/...) и отдаёт каждый как Streamable HTTP на 127.0.0.1.
// Без зависимостей, Node 18+.
//
//   node gigamcp-bridge.mjs --config servers.json [--port 3939] [--token СЕКРЕТ]
//
// servers.json — в формате Claude Desktop:
//   { "mcpServers": { "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/путь"] } } }

import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

const VERSION = '0.1.0';
const PROTOCOL_VERSION = '2025-06-18';

// ---------- аргументы ----------
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`Мост stdio → HTTP для GigaMCP v${VERSION}

  node gigamcp-bridge.mjs --config servers.json [--port 3939] [--token СЕКРЕТ] [--host 127.0.0.1]

  --config  путь к конфигу (формат Claude Desktop, ключ "mcpServers"); по умолчанию ./servers.json
  --port    порт (по умолчанию 3939)
  --token   токен доступа; по умолчанию создаётся и хранится в ~/.gigamcp-bridge/token`);
  process.exit(0);
}
const PORT = Number(opt('port', process.env.GIGAMCP_PORT || 3939));
const HOST = opt('host', '127.0.0.1');
const CONFIG = resolve(opt('config', process.env.GIGAMCP_CONFIG || 'servers.json'));

function loadToken() {
  const given = opt('token', process.env.GIGAMCP_TOKEN);
  if (given) return given;
  const dir = join(homedir(), '.gigamcp-bridge');
  const file = join(dir, 'token');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(dir, { recursive: true });
  const t = randomBytes(24).toString('base64url');
  writeFileSync(file, t, { mode: 0o600 });
  return t;
}
const TOKEN = loadToken();

function loadConfig() {
  if (!existsSync(CONFIG)) {
    console.error(`Не найден конфиг ${CONFIG}. Скопируйте servers.example.json в servers.json и поправьте.`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(CONFIG, 'utf8'));
  const servers = raw.mcpServers || raw.servers || {};
  const out = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg.disabled) continue;
    if (!cfg.command) { console.error(`[${name}] пропущен: нет "command" (мост запускает только stdio-серверы)`); continue; }
    if (!/^[A-Za-z0-9_-]+$/.test(name)) { console.error(`[${name}] пропущен: имя должно состоять из латиницы, цифр, - и _`); continue; }
    out[name] = cfg;
  }
  return out;
}

// ---------- stdio-сервер ----------
class StdioServer {
  constructor(name, cfg) {
    this.name = name; this.cfg = cfg;
    this.proc = null; this.pending = new Map(); this.nextId = 1;
    this.initResult = null; this.starting = null; this.lastError = null;
  }

  start() {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const { command, args = [], env = {}, cwd } = this.cfg;
      const proc = spawn(command, args, {
        cwd: cwd ? resolve(dirname(CONFIG), cwd) : undefined,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        windowsHide: true,
      });
      this.proc = proc;
      let buf = '';
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (line) this.onLine(line);
        }
      });
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (d) => { for (const l of String(d).split('\n')) if (l.trim()) console.error(`[${this.name}] ${l}`); });
      proc.on('error', (e) => { this.lastError = e.message; console.error(`[${this.name}] не запустился: ${e.message}`); });
      proc.on('exit', (code, sig) => {
        console.error(`[${this.name}] процесс завершился (${sig || code})`);
        for (const p of this.pending.values()) p.reject(new Error(`Процесс сервера ${this.name} завершился`));
        this.pending.clear();
        this.proc = null; this.starting = null; this.initResult = null;
      });
      const res = await this.rawRequest('initialize', {
        protocolVersion: PROTOCOL_VERSION, capabilities: { roots: { listChanged: false } },
        clientInfo: { name: 'gigamcp-bridge', version: VERSION },
      }, 60000);
      this.initResult = res;
      this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      console.error(`[${this.name}] готов: ${res.serverInfo?.name || '?'} ${res.serverInfo?.version || ''}`);
      return res;
    })().catch((e) => { this.starting = null; this.lastError = e.message; try { this.proc?.kill(); } catch {} throw e; });
    return this.starting;
  }

  send(msg) {
    if (!this.proc?.stdin?.writable) throw new Error(`Сервер ${this.name} не запущен`);
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  onLine(line) {
    let msg; try { msg = JSON.parse(line); } catch { console.error(`[${this.name}] не JSON в stdout: ${line.slice(0, 200)}`); return; }
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      if (m.id !== undefined && ('result' in m || 'error' in m)) {
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); p.resolve(m); }
      } else if (m.method && m.id !== undefined) {
        // запрос сервера к клиенту — отвечаем сами
        const reply = m.method === 'ping' ? { result: {} }
          : m.method === 'roots/list' ? { result: { roots: [] } }
          : { error: { code: -32601, message: `Мост не поддерживает ${m.method}` } };
        try { this.send({ jsonrpc: '2.0', id: m.id, ...reply }); } catch {}
      }
    }
  }

  rawRequest(method, params, timeout = 300000) {
    return new Promise((resolveP, rejectP) => {
      const id = this.nextId++;
      const t = setTimeout(() => { this.pending.delete(id); rejectP(new Error(`Таймаут ${method}`)); }, timeout);
      this.pending.set(id, {
        resolve: (m) => { clearTimeout(t); m.error ? rejectP(Object.assign(new Error(m.error.message), { rpc: m.error })) : resolveP(m.result); },
        reject: (e) => { clearTimeout(t); rejectP(e); },
      });
      try { this.send({ jsonrpc: '2.0', id, method, params }); } catch (e) { clearTimeout(t); this.pending.delete(id); rejectP(e); }
    });
  }

  /** Обработка одного сообщения от клиента; возвращает ответ или null (для уведомлений). */
  async handle(msg) {
    const isRequest = msg.id !== undefined && msg.method;
    if (!msg.method) return null; // ответы клиента нам не нужны
    if (!isRequest) {
      if (msg.method === 'notifications/initialized') return null;
      try { await this.start(); this.send(msg); } catch {}
      return null;
    }
    try {
      const init = await this.start();
      if (msg.method === 'initialize') return { jsonrpc: '2.0', id: msg.id, result: init };
      const result = await this.rawRequest(msg.method, msg.params);
      return { jsonrpc: '2.0', id: msg.id, result };
    } catch (e) {
      return { jsonrpc: '2.0', id: msg.id, error: e.rpc || { code: -32603, message: e.message } };
    }
  }

  stop() { try { this.proc?.kill(); } catch {} }
}

// ---------- HTTP ----------
const config = loadConfig();
const servers = new Map(Object.entries(config).map(([n, c]) => [n, new StdioServer(n, c)]));
const tokenBuf = Buffer.from(TOKEN);

function authorized(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const b = Buffer.from(m[1].trim());
  return b.length === tokenBuf.length && timingSafeEqual(b, tokenBuf);
}

function send(res, status, body, headers = {}) {
  const data = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
const baseUrl = `http://127.0.0.1:${PORT}`;

const server = http.createServer(async (req, res) => {
  // защита от DNS-rebinding и запросов со сторонних сайтов
  if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) return send(res, 403, { error: 'host not allowed' });
  const origin = req.headers.origin;
  if (origin && !/^chrome-extension:\/\//.test(origin)) return send(res, 403, { error: 'origin not allowed' });
  if (req.method === 'OPTIONS') return send(res, 204);
  if (!authorized(req)) return send(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer realm="gigamcp-bridge"' });

  const url = new URL(req.url, baseUrl);
  if (req.method === 'GET' && url.pathname === '/servers') {
    return send(res, 200, {
      version: VERSION,
      servers: [...servers.values()].map((s) => ({ name: s.name, url: `${baseUrl}/${s.name}/mcp`, running: !!s.initResult, error: s.lastError })),
    });
  }
  const m = url.pathname.match(/^\/([A-Za-z0-9_-]+)\/mcp\/?$/);
  const srv = m && servers.get(m[1]);
  if (!srv) return send(res, 404, { error: 'not found' });
  if (req.method === 'GET') return send(res, 405, { error: 'SSE stream not supported' }, { Allow: 'POST, DELETE' });
  if (req.method === 'DELETE') return send(res, 200, {});
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 20 * 1024 * 1024) return send(res, 413, { error: 'too large' }); }
  let body;
  try { body = JSON.parse(raw); } catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  const batch = Array.isArray(body);
  const replies = (await Promise.all((batch ? body : [body]).map((msg) => srv.handle(msg)))).filter(Boolean);
  if (!replies.length) return send(res, 202);
  send(res, 200, batch ? replies : replies[0], { 'Mcp-Session-Id': 'bridge' });
});

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Порт ${PORT} занят. Запустите с другим: --port 3940` : e.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`\nМост GigaMCP запущен.`);
  console.log(`  Адрес:  ${baseUrl}`);
  console.log(`  Токен:  ${TOKEN}`);
  console.log(`  Конфиг: ${CONFIG}`);
  console.log(`\nВ giga.chat: MCP → «Локальные серверы (stdio) через мост» → вставьте адрес и токен.\n`);
  if (!servers.size) console.log('В конфиге нет stdio-серверов.');
  for (const s of servers.values()) {
    console.log(`  • ${s.name}: ${baseUrl}/${s.name}/mcp`);
    s.start().catch((e) => console.error(`[${s.name}] ошибка запуска: ${e.message}`));
  }
});

const shutdown = () => { for (const s of servers.values()) s.stop(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

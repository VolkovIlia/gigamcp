// Проверка MCP-клиента, OAuth, моста и протокола в Node.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startStreamable, startLegacySse, startOAuth } from './servers.mjs';
import { McpClient, resultToText } from '../extension/lib/mcp-client.js';
import { runOAuthFlow, refreshAccessToken, discoverAuth } from '../extension/lib/oauth.js';

const here = dirname(fileURLToPath(import.meta.url));
const P = createRequire(import.meta.url)('../extension/content/protocol.js');
let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.log('  ✗', name, '\n   ', e.stack || e); process.exitCode = 1; }
};

const servers = [];
servers.push((await startStreamable(4201)).srv);
servers.push((await startStreamable(4202, { json: true })).srv);
servers.push((await startLegacySse(4203)).srv);
const oauth = await startOAuth(4204);
servers.push(oauth.srv);

async function basicFlow(url, transportExpected) {
  const c = new McpClient({ url });
  const tools = await c.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['add', 'echo', 'fail']);
  assert.equal(c.transport, transportExpected);
  const r = await c.callTool('add', { a: 2, b: 40 });
  assert.equal(resultToText(r), '42');
  const f = await c.callTool('fail', {});
  assert.equal(f.isError, true);
  // неизвестный инструмент: новые SDK отвечают isError, старые — ошибкой JSON-RPC
  const nope = await c.callTool('nope', {}).catch((e) => ({ isError: true, content: [{ type: 'text', text: e.message }] }));
  assert.equal(nope.isError, true);
  assert.match(resultToText(nope), /nope/);
  await c.close();
}

console.log('MCP-клиент');
await test('Streamable HTTP, ответы потоком SSE', () => basicFlow('http://127.0.0.1:4201/mcp', 'http'));
await test('Streamable HTTP, ответы JSON', () => basicFlow('http://127.0.0.1:4202/mcp', 'http'));
await test('Откат на legacy SSE (POST → 405)', () => basicFlow('http://127.0.0.1:4203/sse', 'sse'));
await test('Переподключение после потери сессии (404)', async () => {
  const { srv, transports } = await startStreamable(4205);
  const c = new McpClient({ url: 'http://127.0.0.1:4205/mcp' });
  await c.listTools();
  for (const k of Object.keys(transports)) delete transports[k]; // сервер «забыл» сессию
  const r = await c.callTool('echo', { text: 'жив' });
  assert.equal(resultToText(r), 'жив');
  srv.close();
});
await test('401 без токена даёт authRequired и WWW-Authenticate', async () => {
  const c = new McpClient({ url: 'http://127.0.0.1:4204/mcp' });
  const e = await c.listTools().catch((x) => x);
  assert.equal(e.authRequired, true);
  assert.match(e.wwwAuthenticate, /resource_metadata=/);
});

console.log('OAuth');
let oauthState;
await test('Обнаружение, DCR, PKCE, обмен кода', async () => {
  const c = new McpClient({ url: 'http://127.0.0.1:4204/mcp' });
  const e = await c.listTools().catch((x) => x);
  const d = await discoverAuth('http://127.0.0.1:4204/mcp', e.wwwAuthenticate);
  assert.equal(d.asMeta.token_endpoint, 'http://127.0.0.1:4204/auth/token');
  const redirectUri = 'https://mmjnppnijhblimofghdejjdhfgdjgcol.chromiumapp.org/oauth';
  oauthState = await runOAuthFlow({
    serverUrl: 'http://127.0.0.1:4204/mcp', wwwAuthenticate: e.wwwAuthenticate, redirectUri,
    launch: async (url) => { const r = await fetch(url, { redirect: 'manual' }); return r.headers.get('location'); },
  });
  assert.ok(oauthState.tokens.accessToken);
  const authLog = oauth.log.find((l) => l[0] === 'authorize');
  assert.equal(authLog[1], 'http://127.0.0.1:4204/mcp', 'resource передан');
  assert.equal(authLog[2], 'tools', 'scope передан');
  const c2 = new McpClient({ url: 'http://127.0.0.1:4204/mcp', getHeaders: () => ({ Authorization: `Bearer ${oauthState.tokens.accessToken}` }) });
  assert.equal(resultToText(await c2.callTool('add', { a: 1, b: 1 })), '2');
});
await test('Обновление токена по refresh_token', async () => {
  const t = await refreshAccessToken(oauthState);
  assert.ok(t.accessToken && t.accessToken !== oauthState.tokens.accessToken);
});

console.log('Мост stdio → HTTP');
await test('Импорт списка, вызовы, токен, защита Host/Origin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gmcp-'));
  const cfg = join(dir, 'servers.json');
  writeFileSync(cfg, JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: [join(here, 'stdio-server.mjs')] }, 'bad name': { command: 'x' } } }));
  const proc = spawn(process.execPath, [join(here, '../bridge/gigamcp-bridge.mjs'), '--config', cfg, '--port', '4210', '--token', 'secret123'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; proc.stdout.on('data', (d) => (out += d)); proc.stderr.on('data', (d) => (out += d));
  try {
    for (let i = 0; i < 50 && !out.includes('готов'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(out, /Токен:\s+secret123/);
    const unauth = await fetch('http://127.0.0.1:4210/servers');
    assert.equal(unauth.status, 401);
    const evil = await fetch('http://127.0.0.1:4210/servers', { headers: { Authorization: 'Bearer secret123', Origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    const list = await (await fetch('http://127.0.0.1:4210/servers', { headers: { Authorization: 'Bearer secret123' } })).json();
    assert.deepEqual(list.servers.map((s) => s.name), ['demo']);
    const c = new McpClient({ url: list.servers[0].url, getHeaders: () => ({ Authorization: 'Bearer secret123' }) });
    const tools = await c.listTools();
    assert.equal(tools.length, 3);
    assert.equal(resultToText(await c.callTool('add', { a: 20, b: 22 })), '42');
    // второй клиент переиспользует уже инициализированный процесс
    const c2 = new McpClient({ url: list.servers[0].url, getHeaders: () => ({ Authorization: 'Bearer secret123' }) });
    assert.equal(resultToText(await c2.callTool('echo', { text: 'ok', upper: true })), 'OK');
  } finally { proc.kill(); }
});

console.log('Протокол');
const fakeServers = [{ id: 'test', name: 'Тест', tools: [
  { name: 'add', description: 'Сложить два числа. Подробнее…', inputSchema: { type: 'object', properties: { a: { type: 'number', description: 'первое' }, b: { type: 'number' }, mode: { enum: ['fast', 'slow'] }, tags: { type: 'array', items: { type: 'string' } }, opts: { type: 'object', properties: { x: { type: ['string', 'null'] } }, required: ['x'] } }, required: ['a', 'b'] } },
  { name: 'ping', description: '', inputSchema: { type: 'object' } },
] }];
await test('Контекст: полный и сжатый', () => {
  const full = P.buildContext(fakeServers);
  assert.match(full.text, /^\[MCP-КОНТЕКСТ v1 #[a-z0-9]+\]/);
  assert.match(full.text, /a: number — первое/);
  assert.match(full.text, /mode\?: "fast" \| "slow"/);
  assert.match(full.text, /tags\?: string\[\]/);
  assert.match(full.text, /opts\?: \{x: string\}/);
  assert.equal(full.compact, false);
  const small = P.buildContext(fakeServers, { maxChars: 500 });
  assert.equal(small.compact, true);
  assert.match(small.text, /mcp\/describe/);
  assert.equal(P.contextSignatureIn(full.text), full.signature);
  // шаблон из инструкции не должен распознаваться как вызов
  assert.deepEqual(P.extractCallsFromText(full.text), []);
});
await test('Разбор вызовов в разных видах', () => {
  assert.deepEqual(P.parseCallText('{"call": "test/add", "arguments": {"a": 1, "b": 2}}'), { name: 'test/add', arguments: { a: 1, b: 2 } });
  assert.deepEqual(P.parseCallText('{“call”: “test/add”, “arguments”: {“a”: 1,},}'), { name: 'test/add', arguments: { a: 1 } });
  assert.deepEqual(P.parseCallText('{"server":"test","tool":"add","arguments":"{\\"a\\":1}"}'), { name: 'test/add', arguments: { a: 1 } });
  assert.equal(P.parseCallText('{"call": "test/ad'), null);
  const md = 'Сейчас посчитаю.\n```mcp\n{"call": "test/add", "arguments": {"a": 2, "b": 3}}\n```\n```json\n{"call":"test/ping"}\n```';
  assert.equal(P.extractCallsFromText(md).length, 2);
  assert.equal(P.resolveName(fakeServers, 'add').tool.name, 'add');
  assert.equal(P.resolveName(fakeServers, 'test.add').tool.name, 'add');
  assert.equal(P.resolveName(fakeServers, 'x/zzz'), null);
});
await test('Результаты и mcp/describe', () => {
  const t = P.formatResults([{ name: 'test/add', ok: true, text: '5' }, { name: 'test/x', ok: false, text: 'x'.repeat(5000) }], { maxChars: 3000 });
  assert.match(t, /^\[MCP-РЕЗУЛЬТАТ\]/);
  assert.match(t, /▶ test\/add — успешно\n5/);
  assert.match(t, /обрезано/);
  assert.match(P.describeTools(fakeServers, ['test/add', 'no/pe']), /a: number — первое[\s\S]*no\/pe — не найден/);
});

for (const s of servers) s.close();
console.log(`\nУспешно: ${passed}`);
process.exit(process.exitCode || 0);

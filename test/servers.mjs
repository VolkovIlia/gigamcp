// Тестовые MCP-серверы на официальном SDK: Streamable HTTP (SSE- и JSON-ответы), legacy SSE, OAuth-защищённый.
import express from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

export function makeServer(label = 'test') {
  const s = new McpServer({ name: `test-${label}`, version: '1.0.0' }, { instructions: `Тестовый сервер ${label}.` });
  s.tool('add', 'Сложить два числа.', { a: z.number().describe('первое'), b: z.number().describe('второе') },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }));
  s.tool('echo', 'Вернуть текст.', { text: z.string(), upper: z.boolean().optional() },
    async ({ text, upper }) => ({ content: [{ type: 'text', text: upper ? text.toUpperCase() : text }] }));
  s.tool('fail', 'Всегда ошибка.', {}, async () => ({ isError: true, content: [{ type: 'text', text: 'Сломалось нарочно' }] }));
  return s;
}

function mountStreamable(app, path, { json = false, label, guard } = {}) {
  const transports = {};
  app.all(path, async (req, res) => {
    if (guard && !guard(req, res)) return;
    const sid = req.headers['mcp-session-id'];
    let t = sid && transports[sid];
    if (!t) {
      if (req.method !== 'POST' || req.body?.method !== 'initialize') {
        return res.status(sid ? 404 : 400).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'No session' } });
      }
      t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: json, onsessioninitialized: (id) => { transports[id] = t; } });
      t.onclose = () => { if (t.sessionId) delete transports[t.sessionId]; };
      await makeServer(label).connect(t);
    }
    await t.handleRequest(req, res, req.body);
  });
  return transports;
}

export function startStreamable(port, opts = {}) {
  const app = express();
  app.use(express.json());
  const transports = mountStreamable(app, '/mcp', { label: opts.json ? 'json' : 'http', ...opts });
  return new Promise((r) => { const srv = app.listen(port, () => r({ srv, transports })); });
}

export function startLegacySse(port) {
  const app = express();
  const transports = {};
  app.get('/sse', async (req, res) => {
    const t = new SSEServerTransport('/messages', res);
    transports[t.sessionId] = t;
    res.on('close', () => delete transports[t.sessionId]);
    await makeServer('sse').connect(t);
  });
  app.post('/messages', express.json(), async (req, res) => {
    const t = transports[req.query.sessionId];
    if (!t) return res.status(400).send('no session');
    await t.handlePostMessage(req, res, req.body);
  });
  // На /mcp отвечаем 405 на POST, чтобы проверить откат на SSE по тому же адресу
  app.post('/sse', (req, res) => res.status(405).end());
  return new Promise((r) => { const srv = app.listen(port, () => r({ srv })); });
}

// OAuth: PRM + AS metadata + DCR + authorize (автоподтверждение) + token; MCP требует Bearer.
export function startOAuth(port, { consent = false } = {}) {
  const base = `http://127.0.0.1:${port}`;
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  const clients = new Map(), codes = new Map(), tokens = new Map();
  const log = [];
  app.get('/.well-known/oauth-protected-resource/mcp', (req, res) => res.json({ resource: `${base}/mcp`, authorization_servers: [`${base}/auth`], scopes_supported: ['tools'] }));
  app.get('/.well-known/oauth-authorization-server/auth', (req, res) => res.json({
    issuer: `${base}/auth`, authorization_endpoint: `${base}/auth/authorize`, token_endpoint: `${base}/auth/token`, registration_endpoint: `${base}/auth/register`,
    code_challenge_methods_supported: ['S256'], response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
  }));
  app.post('/auth/register', (req, res) => {
    const id = 'cl_' + randomUUID().slice(0, 8);
    clients.set(id, req.body);
    log.push(['register', req.body.redirect_uris]);
    res.status(201).json({ client_id: id, ...req.body });
  });
  app.get('/auth/authorize', (req, res) => {
    const q = req.query;
    log.push(['authorize', q.resource, q.scope]);
    if (!clients.has(q.client_id)) return res.status(400).send('unknown client');
    if (!clients.get(q.client_id).redirect_uris.includes(q.redirect_uri)) return res.status(400).send('bad redirect');
    if (consent) {
      // как у Taska: страница согласия с кодом подтверждения
      const art = Buffer.from(JSON.stringify(q)).toString('base64url');
      return res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Согласие</title><form method="post" action="/auth/consent">
        <input type="hidden" name="art" value="${art}"><label>Код подтверждения <input name="code" id="code"></label>
        <button name="decision" value="allow">Разрешить</button></form>`);
    }
    issue(q, res);
  });
  function issue(q, res) {
    const code = 'code_' + randomUUID().slice(0, 8);
    codes.set(code, { challenge: q.code_challenge, clientId: q.client_id, redirect: q.redirect_uri, resource: q.resource });
    const u = new URL(q.redirect_uri); u.searchParams.set('code', code); u.searchParams.set('state', q.state);
    res.redirect(302, u.toString());
  }
  app.post('/auth/consent', (req, res) => {
    log.push(['consent', req.body.code]);
    if (req.body.code !== '123456') {
      return res.status(400).type('html').send('<!doctype html><meta charset="utf-8"><title>Ошибка</title><p id="err">Неверный код подтверждения</p>');
    }
    issue(JSON.parse(Buffer.from(req.body.art, 'base64url').toString()), res);
  });
  app.post('/auth/token', (req, res) => {
    const b = req.body;
    log.push(['token', b.grant_type, b.resource]);
    if (b.grant_type === 'authorization_code') {
      const c = codes.get(b.code);
      if (!c) return res.status(400).json({ error: 'invalid_grant' });
      const ch = createHash('sha256').update(b.code_verifier).digest('base64url');
      if (ch !== c.challenge) return res.status(400).json({ error: 'invalid_grant', error_description: 'pkce' });
      codes.delete(b.code);
    } else if (b.grant_type === 'refresh_token') {
      if (!tokens.has('r:' + b.refresh_token)) return res.status(400).json({ error: 'invalid_grant' });
    } else return res.status(400).json({ error: 'unsupported_grant_type' });
    const at = 'at_' + randomUUID().slice(0, 8), rt = 'rt_' + randomUUID().slice(0, 8);
    tokens.set(at, true); tokens.set('r:' + rt, true);
    res.json({ access_token: at, refresh_token: rt, token_type: 'Bearer', expires_in: 3600 });
  });
  const guard = (req, res) => {
    const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
    if (!m || !tokens.has(m[1])) {
      res.status(401).set('WWW-Authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`).json({ error: 'unauthorized' });
      return false;
    }
    return true;
  };
  mountStreamable(app, '/mcp', { label: 'oauth', guard });
  return new Promise((r) => { const srv = app.listen(port, () => r({ srv, log, tokens })); });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startStreamable(4101);
  await startStreamable(4102, { json: true });
  await startLegacySse(4103);
  await startOAuth(4104);
  console.log('test servers: 4101 http(sse), 4102 http(json), 4103 legacy sse, 4104 oauth');
}

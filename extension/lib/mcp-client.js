// Минимальный MCP-клиент без зависимостей.
// Транспорты: Streamable HTTP (2025-03-26 / 2025-06-18) с откатом на старый HTTP+SSE (2024-11-05),
// а также локальные stdio-программы через помощник Native Messaging (extension/host/).
// Работает и в service worker расширения, и в Node 18+ (для тестов).

export const PROTOCOL_VERSION = '2025-06-18';
export const CLIENT_INFO = { name: 'gigamcp', version: '0.1.0' };

export class McpError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'McpError';
    Object.assign(this, extra); // status, code, authRequired, wwwAuthenticate, data
  }
}

// ---------- SSE ----------

/** Читает text/event-stream и отдаёт события {event, data, id}. */
export async function* readSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let ev = { event: 'message', data: [], id: undefined };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.search(/\r\n|\r|\n/)) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + (buf[nl] === '\r' && buf[nl + 1] === '\n' ? 2 : 1));
        if (line === '') {
          if (ev.data.length) yield { event: ev.event, data: ev.data.join('\n'), id: ev.id };
          ev = { event: 'message', data: [], id: undefined };
          continue;
        }
        if (line.startsWith(':')) continue;
        const i = line.indexOf(':');
        const field = i < 0 ? line : line.slice(0, i);
        let val = i < 0 ? '' : line.slice(i + 1);
        if (val.startsWith(' ')) val = val.slice(1);
        if (field === 'event') ev.event = val;
        else if (field === 'data') ev.data.push(val);
        else if (field === 'id') ev.id = val;
      }
    }
    if (ev.data.length) yield { event: ev.event, data: ev.data.join('\n'), id: ev.id };
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

// ---------- клиент ----------

export class McpClient {
  /**
   * @param {object} o
   * @param {string} o.url              адрес MCP-сервера
   * @param {() => Promise<object>|object} [o.getHeaders] доп. заголовки (Authorization и т.п.)
   * @param {'auto'|'http'|'sse'} [o.transport]
   * @param {typeof fetch} [o.fetchImpl]
   * @param {number} [o.timeoutMs]
   */
  constructor({ url, getHeaders = () => ({}), transport = 'auto', fetchImpl, timeoutMs = 120000, stdio = null, nativeConnect = null }) {
    this.url = url;
    this.getHeaders = getHeaders;
    this.transportPref = transport;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.timeoutMs = timeoutMs;
    this.transport = null; // 'http' | 'sse' после connect
    this.sessionId = null;
    this.protocolVersion = null;
    this.serverInfo = null;
    this.capabilities = null;
    this.instructions = null;
    this._id = 1;
    this._sse = null; // состояние legacy SSE
    this.stdio = stdio; // {command, args, env, cwd} — локальная программа через помощник
    this.nativeConnect = nativeConnect; // () => порт Native Messaging
    this._native = null;
  }

  get connected() { return !!this.transport; }

  async connect() {
    if (this.transport) return this;
    const pref = this.transportPref;
    if (pref === 'sse') { await this._connectSSE(); return this; }
    if (pref === 'native') { await this._connectNative(); return this; }
    try {
      await this._initHttp();
    } catch (e) {
      // По спецификации: если POST initialize вернул 4xx (кроме 401) — пробуем старый SSE-транспорт.
      const fallback = pref === 'auto' && !e.authRequired && e.status && [400, 404, 405, 406].includes(e.status);
      if (!fallback) throw e;
      await this._connectSSE();
    }
    return this;
  }

  async listTools() {
    await this.connect();
    const tools = [];
    let cursor;
    for (let page = 0; page < 50; page++) {
      const res = await this.request('tools/list', cursor ? { cursor } : {});
      tools.push(...(res.tools || []));
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    return tools;
  }

  async callTool(name, args = {}) {
    await this.connect();
    return this.request('tools/call', { name, arguments: args });
  }

  async close() {
    if (this.transport === 'http' && this.sessionId) {
      try {
        await this.fetch(this.url, { method: 'DELETE', headers: await this._headers() });
      } catch {}
    }
    if (this._sse) { try { this._sse.abort.abort(); } catch {} }
    if (this._native) { try { this._native.port.disconnect(); } catch {} this._native = null; }
    this.transport = null; this.sessionId = null; this._sse = null;
  }

  // ---------- общая часть ----------

  async request(method, params, { _retried } = {}) {
    if (!this.transport && method !== 'initialize') await this.connect();
    const msg = { jsonrpc: '2.0', id: this._id++, method, params };
    try {
      if (this.transport === 'native') return await this._nativeRequest(msg);
      return this.transport === 'sse' ? await this._sseRequest(msg) : await this._httpRequest(msg);
    } catch (e) {
      // Сессия протухла (404 на Streamable HTTP или упавший SSE-поток) — переподключаемся один раз.
      if (!_retried && method !== 'initialize' && (e.sessionExpired || e.streamClosed)) {
        this.transport = null; this.sessionId = null; this._sse = null; this._native = null;
        await this.connect();
        return this.request(method, params, { _retried: true });
      }
      throw e;
    }
  }

  async _headers(extra = {}) {
    const h = { ...(await this.getHeaders()), ...extra };
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    if (this.protocolVersion && this.transport === 'http') h['MCP-Protocol-Version'] = this.protocolVersion;
    return h;
  }

  _initParams() {
    return { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO };
  }

  _applyInit(result) {
    this.protocolVersion = result.protocolVersion || PROTOCOL_VERSION;
    this.serverInfo = result.serverInfo || null;
    this.capabilities = result.capabilities || {};
    this.instructions = result.instructions || null;
  }

  _withTimeout(ms = this.timeoutMs) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new McpError(`Таймаут ${Math.round(ms / 1000)} с`)), ms);
    return { signal: ac.signal, done: () => clearTimeout(t), ac };
  }

  // Ответ сервера на запрос сервера к клиенту (ping, roots/list и пр.)
  _answerServerRequest(m) {
    if (m.method === 'ping') return { jsonrpc: '2.0', id: m.id, result: {} };
    if (m.method === 'roots/list') return { jsonrpc: '2.0', id: m.id, result: { roots: [] } };
    return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Клиент не поддерживает ${m.method}` } };
  }

  // ---------- Streamable HTTP ----------

  async _initHttp() {
    this.transport = 'http';
    try {
      const msg = { jsonrpc: '2.0', id: this._id++, method: 'initialize', params: this._initParams() };
      const { result, headers } = await this._httpRequest(msg, { wantHeaders: true });
      const sid = headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;
      this._applyInit(result);
      await this._httpNotify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    } catch (e) {
      this.transport = null; this.sessionId = null;
      throw e;
    }
  }

  async _httpPost(body, signal) {
    const res = await this.fetch(this.url, {
      method: 'POST',
      headers: await this._headers({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }),
      body: JSON.stringify(body),
      signal,
    });
    if (res.status === 401 || res.status === 403) {
      const www = res.headers.get('www-authenticate') || '';
      let text = ''; try { text = await res.text(); } catch {}
      const detail = (text.match(/"(?:detail|error_description|message|error)"\s*:\s*"([^"]{1,200})"/) || [])[1] || text.replace(/<[^>]+>/g, ' ').trim().slice(0, 160);
      throw new McpError(res.status === 401 ? 'Требуется авторизация' : `Доступ запрещён (403)${detail ? ': ' + detail : ''}`, {
        status: res.status, authRequired: res.status === 401 || /invalid_token|insufficient_scope/.test(www), wwwAuthenticate: www, data: text.slice(0, 500),
      });
    }
    if (res.status === 404 && this.sessionId && body.method !== 'initialize') {
      throw new McpError('Сессия MCP истекла', { status: 404, sessionExpired: true });
    }
    if (!res.ok && res.status !== 202) {
      let text = ''; try { text = await res.text(); } catch {}
      throw new McpError(`HTTP ${res.status}: ${text.slice(0, 300) || res.statusText}`, { status: res.status });
    }
    return res;
  }

  async _httpNotify(msg) {
    const t = this._withTimeout(30000);
    try {
      const res = await this._httpPost(msg, t.signal);
      try { await res.body?.cancel(); } catch {}
    } finally { t.done(); }
  }

  async _httpRequest(msg, { wantHeaders = false } = {}) {
    const t = this._withTimeout();
    try {
      const res = await this._httpPost(msg, t.signal);
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      let reply = null;
      if (ct.includes('text/event-stream')) {
        for await (const ev of readSSE(res.body)) {
          if (!ev.data) continue;
          let m; try { m = JSON.parse(ev.data); } catch { continue; }
          for (const one of Array.isArray(m) ? m : [m]) {
            if (one.id === msg.id && ('result' in one || 'error' in one)) { reply = one; break; }
            if (one.method && one.id !== undefined) {
              // запрос сервера к клиенту внутри потока — отвечаем отдельным POST
              this._httpNotify(this._answerServerRequest(one)).catch(() => {});
            }
          }
          if (reply) break;
        }
        try { await res.body?.cancel(); } catch {}
      } else if (ct.includes('application/json')) {
        const m = await res.json();
        reply = (Array.isArray(m) ? m : [m]).find((x) => x.id === msg.id) || null;
      } else if (res.status === 202) {
        throw new McpError('Сервер принял запрос, но не прислал ответ (202)');
      }
      if (!reply) throw new McpError('Сервер не вернул ответ на запрос ' + msg.method);
      if (reply.error) throw new McpError(reply.error.message || 'Ошибка MCP', { code: reply.error.code, data: reply.error.data });
      return wantHeaders ? { result: reply.result, headers: res.headers } : reply.result;
    } catch (e) {
      if (e?.name === 'AbortError' || t.ac.signal.aborted) throw new McpError(`Таймаут запроса ${msg.method}`);
      throw e;
    } finally { t.done(); }
  }

  // ---------- локальная программа (stdio) через помощник Native Messaging ----------

  async _connectNative() {
    if (!this.nativeConnect || !this.stdio?.command) throw new McpError('Не указана команда локальной программы');
    let port;
    try { port = this.nativeConnect(); } catch (e) { throw new McpError(e.message || String(e), { hostMissing: true }); }
    const state = { port, pending: new Map(), closed: false, chunks: new Map(), logs: [], exitInfo: null };
    this._native = state;
    let spawnOk, spawnFail;
    const spawned = new Promise((r, j) => { spawnOk = r; spawnFail = j; });
    const fail = (err) => {
      state.closed = true;
      spawnFail(err);
      for (const p of state.pending.values()) p.reject(err);
      state.pending.clear();
      if (this._native === state) { this.transport = null; this._native = null; }
    };
    const onRpc = (m) => {
      for (const one of Array.isArray(m) ? m : [m]) {
        if (one.id !== undefined && ('result' in one || 'error' in one)) {
          const p = state.pending.get(one.id);
          if (p) { state.pending.delete(one.id); p.resolve(one); }
        } else if (one.method && one.id !== undefined) {
          try { port.postMessage({ type: 'msg', data: this._answerServerRequest(one) }); } catch {}
        }
      }
    };
    port.onMessage.addListener((m) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'msg') onRpc(m.data);
      else if (m.type === 'chunk') {
        const buf = state.chunks.get(m.id) || [];
        buf[m.i] = m.part; state.chunks.set(m.id, buf);
        if (buf.filter((x) => x !== undefined).length === m.n) {
          state.chunks.delete(m.id);
          try { onRpc(JSON.parse(buf.join(''))); } catch {}
        }
      } else if (m.type === 'spawned') spawnOk(m);
      else if (m.type === 'log') { state.logs.push(m.line); state.logs.splice(0, state.logs.length - 30); }
      else if (m.type === 'error') fail(new McpError(m.message));
      else if (m.type === 'exit') {
        state.exitInfo = m;
        const tail = (m.stderr || state.logs.slice(-3).join('\n')).trim();
        fail(new McpError(`Программа завершилась (код ${m.code})${tail ? ': ' + tail.slice(-400) : ''}`, { streamClosed: true }));
      }
    });
    port.onDisconnect.addListener(() => {
      const le = (typeof chrome !== 'undefined' && chrome.runtime?.lastError?.message) || '';
      if (!state.closed) {
        const missing = /not found|не найден/i.test(le);
        fail(new McpError(missing
          ? 'Помощник для локальных программ не установлен. Команда для установки — в панели MCP, раздел «Локальная программа (stdio)».'
          : `Соединение с помощником закрыто${le ? ': ' + le : ''}`, { hostMissing: missing, streamClosed: !missing }));
      }
    });
    const { command, args = [], env = {}, cwd = '' } = this.stdio;
    port.postMessage({ type: 'spawn', command, args, env, cwd });
    const t = setTimeout(() => fail(new McpError('Помощник не ответил за 20 с')), 20000);
    try { await spawned; } finally { clearTimeout(t); }
    this.transport = 'native';
    const init = await this._nativeRequest({ jsonrpc: '2.0', id: this._id++, method: 'initialize', params: this._initParams() }, 60000);
    this._applyInit(init);
    port.postMessage({ type: 'msg', data: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  }

  async _nativeRequest(msg, timeoutMs = this.timeoutMs) {
    const s = this._native;
    if (!s || s.closed) throw new McpError('Программа не запущена', { streamClosed: true });
    const reply = await new Promise((resolve, reject) => {
      const t = setTimeout(() => { s.pending.delete(msg.id); reject(new McpError(`Таймаут запроса ${msg.method}`)); }, timeoutMs);
      s.pending.set(msg.id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      try { s.port.postMessage({ type: 'msg', data: msg }); } catch (e) { clearTimeout(t); s.pending.delete(msg.id); reject(new McpError(e.message, { streamClosed: true })); }
    });
    if (reply.error) throw new McpError(reply.error.message || 'Ошибка MCP', { code: reply.error.code, data: reply.error.data });
    return reply.result;
  }

  // ---------- Legacy HTTP+SSE ----------

  async _connectSSE() {
    const abort = new AbortController();
    const res = await this.fetch(this.url, {
      method: 'GET',
      headers: { ...(await this.getHeaders()), Accept: 'text/event-stream' },
      signal: abort.signal,
    });
    if (res.status === 401) {
      throw new McpError('Требуется авторизация', { status: 401, authRequired: true, wwwAuthenticate: res.headers.get('www-authenticate') || '' });
    }
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok || !ct.includes('text/event-stream')) {
      abort.abort();
      throw new McpError(`Не удалось подключиться: сервер не поддерживает ни Streamable HTTP, ни SSE (HTTP ${res.status})`, { status: res.status });
    }
    const state = { abort, endpoint: null, pending: new Map(), closed: false };
    this._sse = state;
    let resolveEndpoint, rejectEndpoint;
    const endpointReady = new Promise((r, j) => { resolveEndpoint = r; rejectEndpoint = j; });
    const epTimer = setTimeout(() => rejectEndpoint(new McpError('SSE: сервер не прислал endpoint')), 15000);

    (async () => {
      try {
        for await (const ev of readSSE(res.body)) {
          if (ev.event === 'endpoint') {
            state.endpoint = new URL(ev.data.trim(), this.url).toString();
            clearTimeout(epTimer); resolveEndpoint();
            continue;
          }
          let m; try { m = JSON.parse(ev.data); } catch { continue; }
          for (const one of Array.isArray(m) ? m : [m]) {
            if (one.id !== undefined && ('result' in one || 'error' in one)) {
              const p = state.pending.get(one.id);
              if (p) { state.pending.delete(one.id); p.resolve(one); }
            } else if (one.method && one.id !== undefined) {
              this._ssePost(this._answerServerRequest(one)).catch(() => {});
            }
          }
        }
      } catch {}
      state.closed = true;
      clearTimeout(epTimer);
      rejectEndpoint(new McpError('SSE-поток закрыт'));
      for (const p of state.pending.values()) p.reject(new McpError('SSE-поток закрыт', { streamClosed: true }));
      state.pending.clear();
      if (this._sse === state) { this.transport = null; this._sse = null; }
    })();

    await endpointReady;
    this.transport = 'sse';
    const init = await this._sseRequest({ jsonrpc: '2.0', id: this._id++, method: 'initialize', params: { ...this._initParams(), protocolVersion: '2024-11-05' } });
    this._applyInit(init);
    await this._ssePost({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async _ssePost(msg) {
    const s = this._sse;
    if (!s || s.closed) throw new McpError('SSE-поток закрыт', { streamClosed: true });
    const res = await this.fetch(s.endpoint, {
      method: 'POST',
      headers: { ...(await this.getHeaders()), 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
    });
    if (res.status === 401) throw new McpError('Требуется авторизация', { status: 401, authRequired: true, wwwAuthenticate: res.headers.get('www-authenticate') || '' });
    if (!res.ok && res.status !== 202) {
      let text = ''; try { text = await res.text(); } catch {}
      throw new McpError(`HTTP ${res.status}: ${text.slice(0, 300)}`, { status: res.status });
    }
    try { await res.body?.cancel(); } catch {}
  }

  async _sseRequest(msg) {
    const s = this._sse;
    if (!s || s.closed) throw new McpError('SSE-поток закрыт', { streamClosed: true });
    const t = this._withTimeout();
    const reply = await new Promise((resolve, reject) => {
      s.pending.set(msg.id, { resolve, reject });
      t.signal.addEventListener('abort', () => { s.pending.delete(msg.id); reject(new McpError(`Таймаут запроса ${msg.method}`)); });
      this._ssePost(msg).catch((e) => { s.pending.delete(msg.id); reject(e); });
    }).finally(() => t.done());
    if (reply.error) throw new McpError(reply.error.message || 'Ошибка MCP', { code: reply.error.code, data: reply.error.data });
    return reply.result;
  }
}

// ---------- форматирование результата для модели ----------

export function resultToText(result) {
  if (!result) return '';
  const parts = [];
  for (const c of result.content || []) {
    if (c.type === 'text') parts.push(c.text);
    else if (c.type === 'image') parts.push(`[изображение ${c.mimeType || ''}, ~${Math.round((c.data || '').length * 0.75 / 1024)} КБ — содержимое не передаётся]`);
    else if (c.type === 'audio') parts.push(`[аудио ${c.mimeType || ''} — содержимое не передаётся]`);
    else if (c.type === 'resource') {
      const r = c.resource || {};
      parts.push(r.text != null ? `[ресурс ${r.uri || ''}]\n${r.text}` : `[ресурс ${r.uri || ''} (${r.mimeType || 'бинарный'})]`);
    } else if (c.type === 'resource_link') parts.push(`[ссылка на ресурс: ${c.name || ''} ${c.uri || ''}]`);
    else parts.push(JSON.stringify(c));
  }
  if (!parts.length && result.structuredContent) parts.push(JSON.stringify(result.structuredContent, null, 1));
  return parts.join('\n\n');
}

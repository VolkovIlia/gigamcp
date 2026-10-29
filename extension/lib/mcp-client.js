// Минимальный MCP-клиент без зависимостей.
// Транспорты: Streamable HTTP (2025-03-26 / 2025-06-18) с откатом на старый HTTP+SSE (2024-11-05).
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
  constructor({ url, getHeaders = () => ({}), transport = 'auto', fetchImpl, timeoutMs = 120000 }) {
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
  }

  get connected() { return !!this.transport; }

  async connect() {
    if (this.transport) return this;
    const pref = this.transportPref;
    if (pref === 'sse') { await this._connectSSE(); return this; }
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
    this.transport = null; this.sessionId = null; this._sse = null;
  }

  // ---------- общая часть ----------

  async request(method, params, { _retried } = {}) {
    if (!this.transport && method !== 'initialize') await this.connect();
    const msg = { jsonrpc: '2.0', id: this._id++, method, params };
    try {
      return this.transport === 'sse' ? await this._sseRequest(msg) : await this._httpRequest(msg);
    } catch (e) {
      // Сессия протухла (404 на Streamable HTTP или упавший SSE-поток) — переподключаемся один раз.
      if (!_retried && method !== 'initialize' && (e.sessionExpired || e.streamClosed)) {
        this.transport = null; this.sessionId = null; this._sse = null;
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
      throw new McpError(res.status === 401 ? 'Требуется авторизация' : 'Доступ запрещён (403)', {
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

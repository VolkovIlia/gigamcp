// Фоновый service worker: хранит серверы, держит MCP-подключения, выполняет вызовы, проводит OAuth.
import { McpClient, McpError, resultToText } from './lib/mcp-client.js';
import { beginOAuthFlow, completeOAuthFlow, refreshAccessToken } from './lib/oauth.js';

// Адрес возврата OAuth. Он же «Redirect URI» для ручной регистрации клиента.
const REDIRECT_URI = `https://${chrome.runtime.id}.chromiumapp.org/oauth`;
// Помощник для локальных программ (stdio), см. extension/host/
const HOST_NAME = 'ru.gigamcp.host';

const DEFAULT_SETTINGS = {
  enabled: true,          // MCP включён в чате
  autoRun: false,         // выполнять вызовы без подтверждения
  autoSend: true,         // отправлять результат в чат автоматически
  maxResultChars: 15000,  // лимит текста результата на один ответ
  contextMaxChars: 14000, // больше — переходим в компактный каталог инструментов
  maxAutoRounds: 12,      // защита от бесконечного цикла в авто-режиме
  toolTimeoutSec: 120,
};

const clients = new Map(); // id -> McpClient

// Запросы фона к MCP-серверам уходят без заголовка Origin — как у настольных клиентов (Claude Desktop, Cursor).
// Иначе серверы с защитой от DNS rebinding (FastMCP и др.) отвечают 403 «Invalid Origin header» на chrome-extension://…
// Правило действует только на запросы без вкладки (фон расширения), страницы сайтов оно не трогает.
const rulesReady = chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [1],
  addRules: [{
    id: 1, priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
    condition: { tabIds: [chrome.tabs.TAB_ID_NONE], resourceTypes: ['xmlhttprequest', 'other'] },
  }],
}).catch((e) => console.warn('GigaMCP: правило для Origin не установлено', e));

// ---------- хранилище ----------

let lock = Promise.resolve();
function mutate(fn) {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

async function load() {
  const { servers = [], secrets = {}, settings = {} } = await chrome.storage.local.get(['servers', 'secrets', 'settings']);
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  if (merged.contextMaxChars === 24000) merged.contextMaxChars = DEFAULT_SETTINGS.contextMaxChars; // прежнее значение по умолчанию (до 0.2.4)
  return { servers, secrets, settings: merged };
}

async function saveServers(servers) { await chrome.storage.local.set({ servers }); }
async function saveSecrets(secrets) { await chrome.storage.local.set({ secrets }); }

async function patchServer(id, patch) {
  return mutate(async () => {
    const { servers } = await load();
    const s = servers.find((x) => x.id === id);
    if (!s) throw new McpError('Сервер не найден');
    Object.assign(s, patch, { updatedAt: Date.now() });
    await saveServers(servers);
    return s;
  });
}

async function patchSecret(id, patch) {
  return mutate(async () => {
    const { secrets } = await load();
    secrets[id] = { ...(secrets[id] || {}), ...patch };
    await saveSecrets(secrets);
    return secrets[id];
  });
}

const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ы: 'y', э: 'e', ю: 'yu', я: 'ya' };
function slugify(name, url) {
  let base = String(name || '').toLowerCase().split('').map((c) => TRANSLIT[c] ?? c).join('');
  base = base.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) { try { base = new URL(url).hostname.split('.').filter((p) => p !== 'www')[0]; } catch { base = 'server'; } base = base.replace(/[^a-z0-9]+/g, '_'); }
  return base.slice(0, 24) || 'server';
}

// ---------- подключение ----------

function publicServer(s) {
  const { ...pub } = s;
  return pub;
}

async function headersFor(id) {
  await rulesReady;
  const { servers, secrets } = await load();
  const s = servers.find((x) => x.id === id);
  const sec = secrets[id] || {};
  const h = { ...(sec.headers || {}) };
  if (s?.authType === 'bearer' && sec.token) h.Authorization = `Bearer ${sec.token}`;
  if (s?.authType === 'oauth' && sec.oauth?.tokens?.accessToken) {
    let tokens = sec.oauth.tokens;
    if (tokens.expiresAt && Date.now() > tokens.expiresAt && tokens.refreshToken) {
      try {
        tokens = await refreshAccessToken(sec.oauth);
        await patchSecret(id, { oauth: { ...sec.oauth, tokens } });
      } catch (e) {
        throw new McpError('Сессия входа истекла — войдите заново', { authRequired: true });
      }
    }
    h.Authorization = `${tokens.tokenType && /^bearer$/i.test(tokens.tokenType) ? 'Bearer' : tokens.tokenType || 'Bearer'} ${tokens.accessToken}`;
  }
  return h;
}

async function getClient(id) {
  let c = clients.get(id);
  if (c) return c;
  const { servers, settings } = await load();
  const s = servers.find((x) => x.id === id);
  if (!s) throw new McpError('Сервер не найден');
  if (s.transport === 'stdio') {
    const { secrets } = await load();
    c = new McpClient({
      transport: 'native', timeoutMs: settings.toolTimeoutSec * 1000,
      stdio: { command: s.command, args: s.args || [], cwd: s.cwd || '', env: secrets[id]?.env || {} },
      nativeConnect: () => chrome.runtime.connectNative(HOST_NAME),
    });
  } else {
    c = new McpClient({ url: s.url, transport: s.transport || 'auto', getHeaders: () => headersFor(id), timeoutMs: settings.toolTimeoutSec * 1000 });
  }
  clients.set(id, c);
  return c;
}

function dropClient(id) {
  const c = clients.get(id);
  clients.delete(id);
  if (c) c.close().catch(() => {});
}

/** Выполняет действие с повтором после обновления OAuth-токена. */
async function withServer(id, fn) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const c = await getClient(id);
    try {
      return await fn(c);
    } catch (e) {
      if (e.authRequired) {
        dropClient(id);
        const { servers, secrets } = await load();
        const s = servers.find((x) => x.id === id);
        const oauth = secrets[id]?.oauth;
        if (attempt === 0 && s?.authType === 'oauth' && oauth?.tokens?.refreshToken) {
          try {
            const tokens = await refreshAccessToken(oauth);
            await patchSecret(id, { oauth: { ...oauth, tokens } });
            continue;
          } catch {}
        }
        await patchSecret(id, { lastWwwAuthenticate: e.wwwAuthenticate || '' });
        const authType = s?.authType === 'bearer' ? 'bearer' : 'oauth';
        await patchServer(id, { status: 'auth', authType, lastError: authType === 'bearer' ? 'Токен не подошёл (401)' : 'Нужен вход' });
      }
      throw e;
    }
  }
}

async function refreshServer(id) {
  try {
    const { tools, client } = await withServer(id, async (c) => ({ tools: await c.listTools(), client: c }));
    return await patchServer(id, {
      status: 'ok', lastError: null, tools: tools.map((t) => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema || {}, annotations: t.annotations || undefined })),
      toolsAt: Date.now(), serverInfo: client.serverInfo, instructions: client.instructions ? String(client.instructions).slice(0, 4000) : null, transportUsed: client.transport, computer: client.computer || null,
    });
  } catch (e) {
    if (!e.authRequired) await patchServer(id, { status: 'error', lastError: e.message });
    throw e;
  }
}

// ---------- команды ----------

const handlers = {
  async state() {
    const { servers, settings } = await load();
    return { servers: servers.map(publicServer), settings, redirectUri: REDIRECT_URI };
  },

  async addServer({ name, url, authType = 'auto', token, headers, clientId, clientSecret, transport = 'auto', source = 'manual', command, args, env, cwd }) {
    const stdio = transport === 'stdio';
    if (stdio) {
      if (!String(command || '').trim()) throw new McpError('Укажите команду, например wordcraft-cli');
    } else {
      try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) throw 0; } catch { throw new McpError('Некорректный адрес. Нужен http(s)://…'); }
    }
    const base = stdio ? (name || String(command).split(/[\\/]/).pop()) : name;
    const id = await mutate(async () => {
      const { servers } = await load();
      let id = slugify(base, url || 'http://local'), n = 2;
      const first = id;
      while (servers.some((s) => s.id === id)) id = `${first}_${n++}`;
      servers.push({
        id, name: name || base || id, transport, source,
        ...(stdio ? { command: String(command).trim(), args: (args || []).map(String), cwd: cwd || '' } : { url }),
        authType: stdio ? 'none' : authType === 'auto' ? (token ? 'bearer' : 'none') : authType,
        enabled: true, disabledTools: [], tools: [], status: 'unknown', lastError: null, createdAt: Date.now(),
      });
      await saveServers(servers);
      return id;
    });
    await patchSecret(id, { token: token || null, headers: headers || {}, env: env || {}, manualClient: clientId ? { clientId, clientSecret: clientSecret || null } : null });
    try { await refreshServer(id); } catch (e) { return { id, error: e.message, needsAuth: !!e.authRequired }; }
    return { id };
  },

  async updateServer({ id, patch }) {
    const allowed = {};
    for (const k of ['name', 'enabled', 'disabledTools', 'url', 'transport']) if (k in patch) allowed[k] = patch[k];
    if ('url' in allowed || 'transport' in allowed) dropClient(id);
    if ('token' in patch) { await patchSecret(id, { token: patch.token || null }); dropClient(id); if (patch.token) allowed.authType = 'bearer'; }
    return patchServer(id, allowed);
  },

  async removeServer({ id }) {
    dropClient(id);
    await mutate(async () => {
      const { servers, secrets } = await load();
      delete secrets[id];
      await saveServers(servers.filter((s) => s.id !== id));
      await saveSecrets(secrets);
    });
    return { ok: true };
  },

  async refreshServer({ id }) {
    dropClient(id);
    try { await refreshServer(id); return { ok: true }; } catch (e) { return { ok: false, error: e.message, needsAuth: !!e.authRequired }; }
  },

  async authorize({ id }) {
    const { servers, secrets } = await load();
    const s = servers.find((x) => x.id === id);
    if (!s) throw new McpError('Сервер не найден');
    const sec = secrets[id] || {};
    const { authUrl, pending } = await beginOAuthFlow({
      serverUrl: s.url,
      wwwAuthenticate: sec.lastWwwAuthenticate || '',
      redirectUri: REDIRECT_URI,
      prev: sec.oauth,
      manualClient: sec.manualClient,
    });
    // Ждём завершения: ответ придёт через tabs.onUpdated (см. finishAuth ниже).
    const done = new Promise((resolve, reject) => waiters.set(pending.state, { resolve, reject }));
    await savePendingAuth(pending.state, { ...pending, serverId: id });
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000); // не даём фону уснуть, пока пользователь входит
    const timeout = setTimeout(() => rejectWaiter(pending.state, new McpError('Вход не завершён за 15 минут')), 15 * 60e3);
    try {
      // Обычное окно браузера, а не launchWebAuthFlow: оно не закрывается на ответах 4xx,
      // поэтому страницу ошибки видно и код подтверждения можно ввести заново.
      const win = await chrome.windows.create({ url: authUrl, type: 'popup', width: 540, height: 760, focused: true });
      await savePendingAuth(pending.state, { windowId: win.id });
      await done;
    } finally {
      clearInterval(keepAlive);
      clearTimeout(timeout);
    }
    return { ok: true };
  },

  async logout({ id }) {
    await patchSecret(id, { oauth: null });
    dropClient(id);
    await patchServer(id, { status: 'auth', lastError: 'Вы вышли' });
    return { ok: true };
  },

  async setClient({ id, clientId, clientSecret }) {
    await patchSecret(id, { manualClient: clientId ? { clientId, clientSecret: clientSecret || null } : null, oauth: null });
    return { ok: true };
  },

  async callTool({ serverId, tool, arguments: args }) {
    const started = Date.now();
    try {
      const result = await withServer(serverId, (c) => c.callTool(tool, args || {}));
      return { ok: !result?.isError, text: resultToText(result), ms: Date.now() - started };
    } catch (e) {
      // ошибка транспорта (не ошибка самого инструмента) — отмечаем сервер красным
      if (!e.authRequired && e.code === undefined) await patchServer(serverId, { status: 'error', lastError: e.message }).catch(() => {});
      return { ok: false, text: `Ошибка вызова: ${e.message}`, needsAuth: !!e.authRequired, ms: Date.now() - started };
    }
  },

  async hostStatus() {
    return new Promise((resolve) => {
      let port;
      const done = (r) => { try { port?.disconnect(); } catch {} resolve(r); };
      try { port = chrome.runtime.connectNative(HOST_NAME); } catch (e) { return done({ ok: false, error: e.message }); }
      const t = setTimeout(() => done({ ok: false, error: 'Помощник не ответил' }), 5000);
      port.onMessage.addListener((m) => { if (m?.type === 'hello') { clearTimeout(t); done({ ok: true, version: m.version, python: m.python }); } });
      port.onDisconnect.addListener(() => { clearTimeout(t); done({ ok: false, error: chrome.runtime.lastError?.message || 'Помощник закрыл соединение' }); });
      port.postMessage({ type: 'hello' });
    });
  },

  /**
   * Установщик помощника из файлов самого расширения — без сети: на рабочих машинах нет curl и закрыт GitHub.
   * Внутри — помощник (HOST_SOURCE) и ID этой копии расширения. Возвращает полный путь к скачанному файлу.
   */
  async downloadHostInstaller() {
    const read = (p) => fetch(chrome.runtime.getURL(p)).then((r) => r.text());
    const [inst, host] = await Promise.all([read('host/install-host.py'), read('host/gigamcp_host.py')]);
    const put = (text, marker, value) => {
      if (text.split(marker).length !== 2) throw new McpError(`install-host.py: не найдено «${marker}»`);
      return text.replace(marker, value);
    };
    // строка и список в JSON — допустимые литералы Python
    let text = put(inst, 'HOST_SOURCE = None', 'HOST_SOURCE = ' + JSON.stringify(host));
    text = put(text, "EXTENSION_IDS = ['mmjnppnijhblimofghdejjdhfgdjgcol']",
      'EXTENSION_IDS = ' + JSON.stringify([...new Set(['mmjnppnijhblimofghdejjdhfgdjgcol', chrome.runtime.id])]));
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const id = await chrome.downloads.download({
      // .txt, а не .py: Chrome держит загрузку .py без клика пользователя как «опасную», а Python запустит файл с любым расширением
      url: 'data:text/plain;base64,' + btoa(bin), filename: 'gigamcp-install-host.txt', conflictAction: 'overwrite', saveAs: false,
    });
    return new Promise((resolve, reject) => {
      const check = async () => {
        const [d] = await chrome.downloads.search({ id });
        if (d?.state === 'complete') { chrome.downloads.onChanged.removeListener(onChange); resolve({ path: d.filename }); }
        else if (d?.state === 'interrupted') { chrome.downloads.onChanged.removeListener(onChange); reject(new McpError(`Скачивание прервано: ${d.error}`)); }
      };
      const onChange = (delta) => { if (delta.id === id) check(); };
      chrome.downloads.onChanged.addListener(onChange);
      check();
    });
  },

  /** Импорт конфига в формате Claude Desktop / Cursor / VS Code: { "mcpServers": { name: {command,args,env} | {url,headers} } }. */
  async importConfig({ text }) {
    let cfg;
    try { cfg = JSON.parse(text); } catch (e) { throw new McpError('Это не JSON: ' + e.message); }
    const map = cfg.mcpServers || cfg.servers || (cfg.mcp && cfg.mcp.servers) || cfg;
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new McpError('Не нашёл раздел mcpServers');
    const { servers } = await load();
    const added = [], skipped = [], failed = [];
    for (const [name, it] of Object.entries(map)) {
      if (!it || typeof it !== 'object' || it.disabled) { skipped.push(name); continue; }
      try {
        let r;
        if (it.command) {
          if (servers.some((s) => s.transport === 'stdio' && s.command === it.command && JSON.stringify(s.args || []) === JSON.stringify(it.args || []))) { skipped.push(name); continue; }
          r = await handlers.addServer({ name, transport: 'stdio', command: it.command, args: it.args || [], env: it.env || {}, cwd: it.cwd || '', source: 'import' });
        } else if (it.url || it.serverUrl) {
          const url = it.url || it.serverUrl;
          if (servers.some((s) => s.url === url)) { skipped.push(name); continue; }
          const headers = { ...(it.headers || {}) };
          let token = '';
          const auth = Object.keys(headers).find((k) => k.toLowerCase() === 'authorization');
          if (auth && /^Bearer\s+/i.test(headers[auth])) { token = headers[auth].replace(/^Bearer\s+/i, ''); delete headers[auth]; }
          r = await handlers.addServer({ name, url, authType: token ? 'bearer' : 'auto', token, headers, transport: /sse/i.test(it.type || '') ? 'sse' : 'auto', source: 'import' });
        } else { skipped.push(name); continue; }
        (r.error && !r.needsAuth ? failed : added).push(name + (r.error ? ` (${r.needsAuth ? 'нужен вход' : r.error})` : ''));
      } catch (e) { failed.push(`${name}: ${e.message}`); }
    }
    return { added, skipped, failed };
  },

  async saveSettings({ patch }) {
    return mutate(async () => {
      const { settings } = await load();
      const next = { ...settings, ...patch };
      await chrome.storage.local.set({ settings: next });
      return next;
    });
  },
};

// ---------- завершение OAuth-входа ----------

const waiters = new Map(); // state -> {resolve, reject} — пока жив этот экземпляр фона

function rejectWaiter(state, err) {
  const w = waiters.get(state);
  waiters.delete(state);
  w?.reject(err);
}

async function savePendingAuth(state, patch) {
  return mutate(async () => {
    const { pendingAuth = {} } = await chrome.storage.session.get('pendingAuth');
    pendingAuth[state] = { ...(pendingAuth[state] || {}), ...patch };
    await chrome.storage.session.set({ pendingAuth });
  });
}

async function takePendingAuth(match) {
  return mutate(async () => {
    const { pendingAuth = {} } = await chrome.storage.session.get('pendingAuth');
    const found = Object.entries(pendingAuth).find(([state, p]) => match(state, p));
    if (!found) return null;
    delete pendingAuth[found[0]];
    // заодно чистим брошенные попытки старше часа
    for (const [k, p] of Object.entries(pendingAuth)) if (Date.now() - (p.createdAt || 0) > 3600e3) delete pendingAuth[k];
    await chrome.storage.session.set({ pendingAuth });
    return found[1];
  });
}

async function finishAuth(redirectedUrl) {
  const state = new URL(redirectedUrl).searchParams.get('state');
  const p = await takePendingAuth((st) => st === state);
  if (!p) return;
  if (p.windowId) chrome.windows.remove(p.windowId).catch(() => {});
  try {
    const oauth = await completeOAuthFlow(p, redirectedUrl);
    await patchSecret(p.serverId, { oauth });
    await patchServer(p.serverId, { authType: 'oauth', status: 'unknown', lastError: null });
    dropClient(p.serverId);
    await refreshServer(p.serverId);
    const w = waiters.get(p.state); waiters.delete(p.state); w?.resolve();
  } catch (e) {
    await patchServer(p.serverId, { status: 'auth', lastError: `Вход не выполнен: ${e.message}` }).catch(() => {});
    rejectWaiter(p.state, e);
  }
}

// Код авторизации ловим прямо из заголовка Location ответа сервера. Некоторые серверы (например, Taska)
// отдают страницу согласия с CSP form-action 'self', и Chrome блокирует переход на адрес возврата после
// отправки формы, — но заголовок ответа к этому моменту уже получен.
chrome.webRequest.onHeadersReceived.addListener((d) => {
  if (d.statusCode < 300 || d.statusCode >= 400) return;
  const loc = (d.responseHeaders || []).find((h) => h.name.toLowerCase() === 'location')?.value;
  if (!loc) return;
  let abs; try { abs = new URL(loc, d.url).toString(); } catch { return; }
  if (abs.startsWith(REDIRECT_URI)) finishAuth(abs);
}, { urls: ['<all_urls>'], types: ['main_frame'] }, ['responseHeaders']);

// Слушатели зарегистрированы на верхнем уровне, поэтому вход завершится, даже если фон перезапускался.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  const url = info.url || tab?.pendingUrl || '';
  if (url.startsWith(REDIRECT_URI)) finishAuth(url);
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  const p = await takePendingAuth((st, x) => x.windowId === windowId);
  if (p) rejectWaiter(p.state, new McpError('Окно входа закрыто до завершения авторизации'));
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const h = handlers[msg?.type];
  if (!h) return false;
  Promise.resolve()
    .then(() => h(msg.payload || {}, sender))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: e?.message || String(e), needsAuth: !!e?.authRequired, needClientId: !!e?.needClientId }));
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  // при смене таймаута пересоздаём подключения, чтобы он применился
  const ch = area === 'local' && changes.settings;
  if (ch && ch.oldValue?.toolTimeoutSec !== ch.newValue?.toolTimeoutSec) for (const id of [...clients.keys()]) dropClient(id);
});

// Клик по иконке: открыть панель в giga.chat или открыть сам giga.chat.
chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.url && /^https:\/\/(www\.)?giga\.chat\//.test(tab.url)) {
    try { await chrome.tabs.sendMessage(tab.id, { type: 'togglePanel' }); return; } catch {}
  }
  chrome.tabs.create({ url: 'https://giga.chat/' });
});

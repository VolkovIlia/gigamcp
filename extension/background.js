// Фоновый service worker: хранит серверы, держит MCP-подключения, выполняет вызовы, проводит OAuth.
import { McpClient, McpError, resultToText } from './lib/mcp-client.js';
import { beginOAuthFlow, completeOAuthFlow, refreshAccessToken } from './lib/oauth.js';

// Адрес возврата OAuth. Он же «Redirect URI» для ручной регистрации клиента.
const REDIRECT_URI = `https://${chrome.runtime.id}.chromiumapp.org/oauth`;

const DEFAULT_SETTINGS = {
  enabled: true,          // MCP включён в чате
  autoRun: false,         // выполнять вызовы без подтверждения
  autoSend: true,         // отправлять результат в чат автоматически
  maxResultChars: 15000,  // лимит текста результата на один ответ
  contextMaxChars: 24000, // больше — переходим в компактный каталог инструментов
  maxAutoRounds: 12,      // защита от бесконечного цикла в авто-режиме
  toolTimeoutSec: 120,
};

const clients = new Map(); // id -> McpClient

// ---------- хранилище ----------

let lock = Promise.resolve();
function mutate(fn) {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

async function load() {
  const { servers = [], secrets = {}, settings = {} } = await chrome.storage.local.get(['servers', 'secrets', 'settings']);
  return { servers, secrets, settings: { ...DEFAULT_SETTINGS, ...settings } };
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
  c = new McpClient({ url: s.url, transport: s.transport || 'auto', getHeaders: () => headersFor(id), timeoutMs: settings.toolTimeoutSec * 1000 });
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
      toolsAt: Date.now(), serverInfo: client.serverInfo, instructions: client.instructions ? String(client.instructions).slice(0, 4000) : null, transportUsed: client.transport,
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

  async addServer({ name, url, authType = 'auto', token, headers, clientId, clientSecret, transport = 'auto', source = 'manual' }) {
    try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) throw 0; } catch { throw new McpError('Некорректный адрес. Нужен http(s)://…'); }
    const id = await mutate(async () => {
      const { servers } = await load();
      let id = slugify(name, url), n = 2;
      while (servers.some((s) => s.id === id)) id = `${slugify(name, url)}_${n++}`;
      servers.push({
        id, name: name || id, url, transport, source,
        authType: authType === 'auto' ? (token ? 'bearer' : 'none') : authType,
        enabled: true, disabledTools: [], tools: [], status: 'unknown', lastError: null, createdAt: Date.now(),
      });
      await saveServers(servers);
      return id;
    });
    await patchSecret(id, { token: token || null, headers: headers || {}, manualClient: clientId ? { clientId, clientSecret: clientSecret || null } : null });
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

  async importBridge({ url, token }) {
    const base = String(url || '').replace(/\/+$/, '');
    let list;
    try {
      const r = await fetch(`${base}/servers`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (r.status === 401) throw new McpError('Мост отклонил токен (401)');
      if (!r.ok) throw new McpError(`Мост ответил HTTP ${r.status}`);
      list = (await r.json()).servers || [];
    } catch (e) {
      throw new McpError(e instanceof McpError ? e.message : `Мост недоступен по адресу ${base}. Он запущен? (${e.message})`);
    }
    const { servers } = await load();
    const added = [], skipped = [], failed = [];
    for (const it of list) {
      if (servers.some((s) => s.url === it.url)) { skipped.push(it.name); continue; }
      const r = await handlers.addServer({ name: it.name, url: it.url, authType: token ? 'bearer' : 'none', token, source: 'bridge' });
      (r.error ? failed : added).push(it.name + (r.error ? `: ${r.error}` : ''));
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

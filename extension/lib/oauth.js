// OAuth 2.1 для MCP: обнаружение (RFC 9728 / RFC 8414), динамическая регистрация клиента (RFC 7591),
// PKCE S256, индикатор ресурса (RFC 8707), обновление токена.
// Окно входа открывает внешняя функция launch(url) -> redirectUrl (в расширении — chrome.identity.launchWebAuthFlow).

import { McpError } from './mcp-client.js';

const b64url = (bytes) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export function parseWwwAuthenticate(header = '') {
  const out = {};
  const re = /([a-zA-Z_]+)\s*=\s*(?:"([^"]*)"|([^\s,]+))/g;
  let m;
  while ((m = re.exec(header))) out[m[1].toLowerCase()] = m[2] ?? m[3];
  return out;
}

async function getJson(fetchImpl, url) {
  try {
    const r = await fetchImpl(url, { headers: { Accept: 'application/json', 'MCP-Protocol-Version': '2025-06-18' } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function wellKnown(base, suffix) {
  const u = new URL(base);
  const path = u.pathname.replace(/\/+$/, '');
  const list = [];
  if (path && path !== '/') list.push(`${u.origin}/.well-known/${suffix}${path}`);
  list.push(`${u.origin}/.well-known/${suffix}`);
  return list;
}

export function canonicalResource(serverUrl) {
  const u = new URL(serverUrl);
  u.hash = '';
  return u.toString();
}

/** Находит сервер авторизации для MCP-сервера. */
export async function discoverAuth(serverUrl, wwwAuthenticate = '', fetchImpl = fetch) {
  const www = parseWwwAuthenticate(wwwAuthenticate);
  let prm = null;
  if (www.resource_metadata) prm = await getJson(fetchImpl, new URL(www.resource_metadata, serverUrl).toString());
  if (!prm) for (const u of wellKnown(serverUrl, 'oauth-protected-resource')) { prm = await getJson(fetchImpl, u); if (prm) break; }

  const issuer = prm?.authorization_servers?.[0] || new URL(serverUrl).origin;
  let asMeta = null;
  const iu = new URL(issuer);
  const ipath = iu.pathname.replace(/\/+$/, '');
  const candidates = [
    ...wellKnown(issuer, 'oauth-authorization-server'),
    ...wellKnown(issuer, 'openid-configuration'),
  ];
  if (ipath && ipath !== '/') candidates.push(`${iu.origin}${ipath}/.well-known/openid-configuration`);
  for (const u of candidates) { asMeta = await getJson(fetchImpl, u); if (asMeta?.authorization_endpoint) break; asMeta = null; }

  if (!asMeta) {
    // Запасной вариант из спецификации MCP 2025-03-26: эндпоинты по умолчанию от корня сервера.
    const o = iu.origin;
    asMeta = { issuer: o, authorization_endpoint: `${o}/authorize`, token_endpoint: `${o}/token`, registration_endpoint: `${o}/register`, _guessed: true };
  }
  const scope = www.scope || (prm?.scopes_supported || []).join(' ') || '';
  const resource = prm?.resource || canonicalResource(serverUrl);
  return { asMeta, resource, scope, prm };
}

export async function registerClient(asMeta, { redirectUri, clientName = 'GigaMCP (расширение для giga.chat)' }, fetchImpl = fetch) {
  if (!asMeta.registration_endpoint) {
    throw new McpError('Сервер авторизации не поддерживает динамическую регистрацию. Укажите client_id вручную.', { needClientId: true });
  }
  const r = await fetchImpl(asMeta.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (!r.ok) {
    let t = ''; try { t = await r.text(); } catch {}
    throw new McpError(`Регистрация клиента не удалась (HTTP ${r.status}): ${t.slice(0, 200)}`, { needClientId: true });
  }
  const j = await r.json();
  return { clientId: j.client_id, clientSecret: j.client_secret || null, authMethod: j.token_endpoint_auth_method || 'none' };
}

export async function createPkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64url(digest) };
}

export function buildAuthorizeUrl({ asMeta, clientId, redirectUri, challenge, state, scope, resource }) {
  const u = new URL(asMeta.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  if (scope) u.searchParams.set('scope', scope);
  if (resource) u.searchParams.set('resource', resource);
  return u.toString();
}

async function tokenRequest(asMeta, params, { clientId, clientSecret, authMethod }, fetchImpl) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  const body = new URLSearchParams(params);
  if (clientSecret && authMethod === 'client_secret_basic') {
    headers.Authorization = 'Basic ' + btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`);
  } else {
    body.set('client_id', clientId);
    if (clientSecret) body.set('client_secret', clientSecret);
  }
  const r = await fetchImpl(asMeta.token_endpoint, { method: 'POST', headers, body: body.toString() });
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok || !j?.access_token) {
    throw new McpError(`Токен не получен (HTTP ${r.status}): ${j?.error_description || j?.error || ''}`, { status: r.status, oauthError: j?.error });
  }
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token || null,
    tokenType: j.token_type || 'Bearer',
    expiresAt: j.expires_in ? Date.now() + (Number(j.expires_in) - 30) * 1000 : null,
    scope: j.scope || null,
  };
}

export async function refreshAccessToken(oauth, fetchImpl = fetch) {
  if (!oauth?.tokens?.refreshToken) throw new McpError('Нет refresh-токена', { authRequired: true });
  const t = await tokenRequest(oauth.asMeta, {
    grant_type: 'refresh_token',
    refresh_token: oauth.tokens.refreshToken,
    ...(oauth.resource ? { resource: oauth.resource } : {}),
  }, oauth.client, fetchImpl);
  if (!t.refreshToken) t.refreshToken = oauth.tokens.refreshToken;
  return t;
}

/**
 * Шаг 1: обнаружение сервера авторизации, регистрация клиента, PKCE.
 * Возвращает { authUrl, pending } — pending нужно сохранить до возврата по redirectUri.
 */
export async function beginOAuthFlow({ serverUrl, wwwAuthenticate, redirectUri, fetchImpl = fetch, prev = null, manualClient = null }) {
  const { asMeta, resource, scope } = await discoverAuth(serverUrl, wwwAuthenticate, fetchImpl);
  let client = manualClient?.clientId ? { authMethod: manualClient.clientSecret ? 'client_secret_post' : 'none', ...manualClient } : null;
  if (!client && prev?.client?.clientId && prev?.asMeta?.issuer === asMeta.issuer && prev?.redirectUri === redirectUri) client = prev.client;
  if (!client) client = await registerClient(asMeta, { redirectUri }, fetchImpl);

  const { verifier, challenge } = await createPkce();
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const authUrl = buildAuthorizeUrl({ asMeta, clientId: client.clientId, redirectUri, challenge, state, scope, resource });
  return { authUrl, pending: { state, verifier, client, asMeta, resource, scope, redirectUri, createdAt: Date.now() } };
}

/** Шаг 2: разбор возврата по redirectUri и обмен кода на токены. */
export async function completeOAuthFlow(pending, redirectedUrl, fetchImpl = fetch) {
  const ru = new URL(redirectedUrl);
  const err = ru.searchParams.get('error');
  if (err) throw new McpError(`Сервер авторизации вернул ошибку: ${err} ${ru.searchParams.get('error_description') || ''}`.trim());
  if (ru.searchParams.get('state') !== pending.state) throw new McpError('Неверный state в ответе авторизации');
  const code = ru.searchParams.get('code');
  if (!code) throw new McpError('В ответе авторизации нет кода');
  const { asMeta, resource, scope, client, redirectUri, verifier } = pending;
  const tokens = await tokenRequest(asMeta, {
    grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier,
    ...(resource ? { resource } : {}),
  }, client, fetchImpl);
  return { asMeta, resource, scope, client, tokens, redirectUri };
}

/**
 * Полный вход одной функцией. launch(url) открывает страницу входа и возвращает URL возврата.
 * Возвращает объект oauth для хранения: { asMeta, resource, scope, client, tokens, redirectUri }.
 */
export async function runOAuthFlow({ launch, fetchImpl = fetch, ...opts }) {
  const { authUrl, pending } = await beginOAuthFlow({ fetchImpl, ...opts });
  const redirected = await launch(authUrl);
  if (!redirected) throw new McpError('Вход отменён');
  return completeOAuthFlow(pending, redirected, fetchImpl);
}

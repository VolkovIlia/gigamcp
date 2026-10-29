// Проверка MCP-клиента, OAuth, помощника для локальных программ и протокола в Node.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
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
  assert.deepEqual(tools.map((t) => t.name).sort(), ['add', 'big', 'echo', 'fail']);
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

console.log('Помощник для локальных программ (Native Messaging)');
// Порт в стиле chrome.runtime.Port поверх процесса помощника: 4 байта длины + JSON
function hostPort({ env, cwd } = {}) {
  const proc = spawn('python3', [join(here, '../extension/host/gigamcp_host.py')], { stdio: ['pipe', 'pipe', 'inherit'], env, cwd });
  const msgL = [], discL = [];
  let buf = Buffer.alloc(0);
  proc.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4) {
      const n = buf.readUInt32LE(0);
      if (buf.length < 4 + n) break;
      const m = JSON.parse(buf.subarray(4, 4 + n).toString('utf8'));
      assert.ok(n <= 1024 * 1024, 'кадр не больше 1 МБ');
      buf = buf.subarray(4 + n);
      msgL.forEach((f) => f(m));
    }
  });
  proc.on('exit', () => discL.forEach((f) => f()));
  return {
    proc,
    postMessage(m) { const b = Buffer.from(JSON.stringify(m)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); proc.stdin.write(Buffer.concat([h, b])); },
    onMessage: { addListener: (f) => msgL.push(f) },
    onDisconnect: { addListener: (f) => discL.push(f) },
    disconnect() { proc.stdin.end(); },
  };
}
await test('hello, запуск программы, вызовы, ответ больше 1 МБ по частям', async () => {
  const hello = await new Promise((resolve) => { const p = hostPort(); p.onMessage.addListener((m) => { p.disconnect(); resolve(m); }); p.postMessage({ type: 'hello' }); });
  assert.equal(hello.type, 'hello');
  const c = new McpClient({ transport: 'native', stdio: { command: process.execPath, args: [join(here, 'stdio-server.mjs')] }, nativeConnect: hostPort });
  const tools = await c.listTools();
  assert.equal(c.transport, 'native');
  assert.ok(tools.some((t) => t.name === 'add'));
  assert.equal(resultToText(await c.callTool('add', { a: 40, b: 2 })), '42');
  const big = resultToText(await c.callTool('big', { n: 1500000 }));
  assert.equal(big.length, 1500000);
  await c.close();
});
await test('понятная ошибка, если программы нет', async () => {
  const c = new McpClient({ transport: 'native', stdio: { command: 'no-such-mcp-program' }, nativeConnect: hostPort });
  const e = await c.listTools().catch((x) => x);
  assert.match(e.message, /Не удалось запустить «no-such-mcp-program»/);
});
await test('программа запускается в домашней папке, помощник сообщает «Документы» из user-dirs.dirs', async () => {
  // Flatpak-браузер запускает помощник из скрытой ~/.var/app/<браузер>/data/gigamcp: файл с относительным именем терялся там
  const home = mkdtempSync(join(tmpdir(), 'gmcp-home-'));
  mkdirSync(join(home, '.config'));
  mkdirSync(join(home, 'Документы'));
  writeFileSync(join(home, '.config/user-dirs.dirs'), 'XDG_DESKTOP_DIR="$HOME/Рабочий стол"\nXDG_DOCUMENTS_DIR="$HOME/Документы"\n');
  const env = { ...process.env, HOME: home };
  delete env.XDG_CONFIG_HOME;
  const p = hostPort({ env, cwd: mkdtempSync(join(tmpdir(), 'gmcp-browser-')) });
  const got = {};
  await new Promise((resolve) => {
    p.onMessage.addListener((m) => { got[m.type] = m; if (m.type === 'exit') resolve(); });
    p.postMessage({ type: 'spawn', command: 'sh', args: ['-c', 'pwd >&2'] });
  });
  assert.equal(got.exit.stderr.trim(), home);
  assert.deepEqual([got.spawned.home, got.spawned.documents, got.spawned.cwd], [home, join(home, 'Документы'), home]);
});
// Запускает install-host.py; в выводе и stdout, и stderr, чтобы при падении был виден traceback
const runInstaller = (args, env) => new Promise((resolve) => {
  const p = spawn('python3', [join(here, '../extension/host/install-host.py'), ...args], { env });
  let o = ''; p.stdout.on('data', (d) => (o += d)); p.stderr.on('data', (d) => (o += d));
  p.on('exit', (code) => resolve({ code, o }));
});
await test('установка без прав администратора и удаление', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gmcp-prof-'));
  const env = { ...process.env, HOME: mkdtempSync(join(tmpdir(), 'gmcp-home-')) };  // не трогать настоящий ~/.local/share/gigamcp
  const run = (args) => runInstaller(args, env);
  const r = await run(['--browser-dir', dir]);
  assert.equal(r.code, 0, r.o);
  const m = JSON.parse(readFileSync(join(dir, 'NativeMessagingHosts', 'ru.gigamcp.host.json'), 'utf8'));
  assert.deepEqual(m.allowed_origins, ['chrome-extension://mmjnppnijhblimofghdejjdhfgdjgcol/']);
  assert.ok(existsSync(m.path));
  const u = await run(['--uninstall', '--browser-dir', dir]);
  assert.equal(u.code, 0, u.o);
  assert.equal(existsSync(join(dir, 'NativeMessagingHosts', 'ru.gigamcp.host.json')), false);
});
// Запускает помощник, как браузер, и возвращает ответ на hello
const nativeHello = (path, env) => new Promise((resolve, reject) => {
  const p = spawn(path, ['chrome-extension://mmjnppnijhblimofghdejjdhfgdjgcol/'], { env });
  let buf = Buffer.alloc(0);
  p.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) { p.kill(); resolve(JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)))); }
  });
  p.on('exit', (code) => reject(new Error(`помощник завершился с кодом ${code}`)));
  const b = Buffer.from(JSON.stringify({ type: 'hello' }));
  const h = Buffer.alloc(4); h.writeUInt32LE(b.length);
  p.stdin.write(Buffer.concat([h, b]));
});
await test('Flatpak-браузер: манифест в его песочнице, помощник на хосте, разрешение только там, где стоит GigaMCP', async () => {
  // поддельные flatpak и flatpak-spawn: первый записывает аргументы, второй, как настоящий, запускает команду «на хосте»
  const home = mkdtempSync(join(tmpdir(), 'gmcp-home-'));
  const bin = join(home, 'bin');
  const appDir = join(home, '.var/app/org.chromium.Chromium');
  const otherDir = join(home, '.var/app/com.google.Chrome');
  mkdirSync(join(appDir, 'config/chromium/Default'), { recursive: true });
  mkdirSync(join(otherDir, 'config/google-chrome/Default'), { recursive: true });
  // папка настроек появляется сразу после установки расширения, Preferences браузер дописывает позже
  mkdirSync(join(appDir, 'config/chromium/Default/Local Extension Settings/mmjnppnijhblimofghdejjdhfgdjgcol'), { recursive: true });
  writeFileSync(join(otherDir, 'config/google-chrome/Default/Preferences'), '{"extensions":{"settings":{}}}');
  mkdirSync(bin);
  writeFileSync(join(bin, 'flatpak'), `#!/bin/sh\necho "$@" >> "${join(home, 'flatpak.log')}"\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'flatpak-spawn'), '#!/bin/sh\n[ "$1" = --host ] || exit 9\nshift\nexec "$@"\n', { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
  delete env.XDG_CONFIG_HOME;
  const run = (args) => runInstaller(args, env);
  const r = await run([]);
  assert.equal(r.code, 0, r.o);
  const mpath = join(appDir, 'config/chromium/NativeMessagingHosts/ru.gigamcp.host.json');
  const m = JSON.parse(readFileSync(mpath, 'utf8'));
  assert.ok(m.path.startsWith(appDir + '/'), `помощник должен лежать внутри песочницы: ${m.path}`);
  const log = readFileSync(join(home, 'flatpak.log'), 'utf8');
  assert.match(log, /override --user --talk-name=org\.freedesktop\.Flatpak org\.chromium\.Chromium/);
  assert.doesNotMatch(log, /com\.google\.Chrome/, 'браузеру без GigaMCP разрешение не выдаётся');
  assert.ok(existsSync(join(otherDir, 'config/google-chrome/NativeMessagingHosts/ru.gigamcp.host.json')));
  assert.match(r.o, /flatpak override --user --talk-name=org\.freedesktop\.Flatpak com\.google\.Chrome/);
  assert.equal((await nativeHello(m.path, env)).type, 'hello');
  const u = await run(['--uninstall']);
  assert.equal(u.code, 0, u.o);
  assert.equal(existsSync(mpath), false);
  assert.equal(existsSync(m.path), false);
});
await test('установщик со встроенным помощником работает без папки расширения (python3 - < файл)', async () => {
  const pk = spawnSync('bash', [join(here, '../scripts/pack.sh')], { encoding: 'utf8' });
  assert.equal(pk.status, 0, pk.stderr);
  const home = mkdtempSync(join(tmpdir(), 'gmcp-home-'));
  const dir = mkdtempSync(join(tmpdir(), 'gmcp-prof-'));
  const env = { ...process.env, HOME: home };
  // копия из магазина: свой ID приходит из команды в панели, а ID из прежнего манифеста (распакованная копия) остаётся
  const storeId = 'abcdefghijklmnopabcdefghijklmnop';
  const other = 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/';
  mkdirSync(join(dir, 'NativeMessagingHosts'));
  writeFileSync(join(dir, 'NativeMessagingHosts', 'ru.gigamcp.host.json'), JSON.stringify({ allowed_origins: [other] }));
  const install = (args) => spawnSync('python3', ['-', '--browser-dir', dir, ...args], { input: readFileSync(join(here, '../dist/install-host.py')), cwd: home, env, encoding: 'utf8' });
  const r = install(['--extension-id', storeId]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const m = JSON.parse(readFileSync(join(dir, 'NativeMessagingHosts', 'ru.gigamcp.host.json'), 'utf8'));
  assert.deepEqual(new Set(m.allowed_origins), new Set(['chrome-extension://mmjnppnijhblimofghdejjdhfgdjgcol/', `chrome-extension://${storeId}/`, other]));
  assert.equal((await nativeHello(m.path, env)).type, 'hello');
  assert.notEqual(install(['--extension-id', 'not-an-id']).status, 0, 'неверный ID отклоняется');
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
  // в инструкции — пример настоящего вызова (инструмент без обязательных параметров)
  assert.deepEqual(P.extractCallsFromText(full.text).map((c) => c.name), ['test/ping']);
  assert.match(full.text, /Это НЕ твои встроенные навыки/);
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
await test('Подбор инструментов под запрос и напоминание при отказе', () => {
  const srv = [{ id: 'taska', tools: [
    { name: 'risks_create', description: 'Create a risk', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
    { name: 'tasks_list', description: 'List tasks', inputSchema: { type: 'object', properties: { status: { type: 'string' } } } },
    { name: 'calendar_agenda', description: 'Agenda', inputSchema: { type: 'object' } },
  ] }];
  assert.equal(P.rankTools(srv, 'Покажи мои задачи на сегодня')[0].tool.name, 'tasks_list');
  const c = P.buildContext(srv, { query: 'Покажи мои задачи', forceCompact: true });
  assert.match(c.text, /ПОДХОДЯЩИЕ ДЛЯ ЭТОГО ЗАПРОСА[\s\S]*taska\/tasks_list[\s\S]*ОСТАЛЬНЫЕ ФУНКЦИИ[\s\S]*taska\/risks_create/);
  assert.equal(c.signature, P.buildContext(srv, { query: 'другое' }).signature, 'подпись не зависит от запроса');
  assert.ok(P.looksLikeRefusal('Я не могу показать задачи из Taska, так как у меня нет доступа к твоим данным в этом приложении.'));
  assert.ok(!P.looksLikeRefusal('Вот ваши задачи на сегодня: 1. Купить молоко'));
  assert.match(P.buildNudge(srv, 'задачи'), /^\[MCP-НАПОМИНАНИЕ\][\s\S]*taska\/tasks_list/);
});
await test('Большой сервер как Taska: «taska_*» не путается с «task», каталог короткий', () => {
  const obj = (props = {}, required = []) => ({ type: 'object', properties: props, required });
  const tools = [
    { name: 'taska_guide', description: 'Guide to Taska for agents: how tasks, goals and projects fit together.', inputSchema: obj() },
    { name: 'taska_briefing', description: 'Briefing: what needs attention in Taska today, tasks and goals.', inputSchema: obj() },
    { name: 'tasks_create', description: 'Create a task.', inputSchema: obj({ title: { type: 'string' } }, ['title']) },
    { name: 'tasks_list', description: 'List tasks with filters.', inputSchema: obj({ status: { type: 'string' }, due: { type: 'string' } }) },
    { name: 'tasks_get', description: 'Get one task.', inputSchema: obj({ id: { type: 'string' } }, ['id']) },
    { name: 'calendar_agenda', description: 'Agenda for a day.', inputSchema: obj({ date: { type: 'string' } }) },
  ];
  for (let i = 0; i < 240; i++) tools.push({ name: `module${i}_action_item`, description: `Does a thing number ${i} with a fairly long description so that the full catalog is big.`, inputSchema: obj({ x: { type: 'string', description: 'some parameter' } }) });
  const srv = [{ id: 'taska_stage', name: 'Taska-stage', tools }];
  const q = 'Какие у меня задачи на сегодня на Taska';
  const ranked = P.rankTools(srv, q);
  assert.equal(ranked[0].tool.name, 'tasks_list');
  const c = P.buildContext(srv, { query: q });
  assert.ok(c.compact);
  assert.ok(c.text.length < 14000, `контекст ${c.text.length} символов`);
  assert.match(c.text, /```mcp\n\{"call": "taska_stage\/tasks_list", "arguments": \{\}\}\n```/);
  assert.match(c.text, /module239_action_item/);
  assert.match(c.text, /твой ответ — только блок кода mcp[\s\S]*\[\/MCP-КОНТЕКСТ\]$/);
  assert.equal(P.nudgeReason('Ошибка при вызове инструмента. Ответ: Этот запрос относится к поиску данных в системе управления задачами.', srv, q), 'deflect');
  // настоящий ответ ГигаЧата бывает только с этой фразой; кириллица после «ошибк» не ловилась через \w
  assert.equal(P.nudgeReason('Ошибка при вызове инструмента', srv, 'Привет'), 'deflect');
  assert.equal(P.nudgeReason('Подходящие навыки не найдены', srv, 'Привет'), 'deflect');
  assert.equal(P.nudgeReason('Я не получила доступа к данным', srv, 'Привет'), 'refusal');
  assert.equal(P.nudgeReason('У меня отсутствует доступ к почте', srv, 'Привет'), 'refusal');
  assert.equal(P.nudgeReason('Я не могу подключиться к серверу', srv, 'Привет'), 'refusal');
  assert.equal(P.nudgeReason('Вот что я нашёл в интернете про задачи.', srv, q), 'missed');
  assert.equal(P.nudgeReason('Привет! Чем помочь?', srv, 'Привет'), null);
  assert.match(P.buildNudge(srv, q), /"call": "taska_stage\/tasks_list"/);
});
await test('Результаты и mcp/describe', () => {
  const t = P.formatResults([{ name: 'test/add', ok: true, text: '5' }, { name: 'test/x', ok: false, text: 'x'.repeat(5000) }], { maxChars: 3000 });
  assert.match(t, /^\[MCP-РЕЗУЛЬТАТ\]/);
  assert.match(t, /▶ test\/add — успешно\n5/);
  assert.match(t, /обрезано/);
  assert.match(P.describeTools(fakeServers, ['test/add', 'no/pe']), /a: number — первое[\s\S]*no\/pe — не найден/);
});
await test('Подсказка к каждому сообщению и большие результаты', () => {
  const h = P.buildHint(fakeServers, 'Сложи два числа');
  assert.ok(h.startsWith(P.HINT_OPEN));
  assert.match(h, /test\/add/, 'подходящая функция названа');
  assert.match(P.buildHint(fakeServers, 'Ещё раз, внимательнее', ['test/echo']), /уже вызывал: test\/echo/, 'продолжение без совпадений — уже вызванные функции');
  // функции, меняющие данные (readOnlyHint: false), подсказка не предлагает — ни по словам, ни из уже вызванных
  const deck = [{ id: 'deck', name: 'Deck', tools: [
    { name: 'new_presentation', description: 'Start a new presentation.', annotations: { readOnlyHint: false } },
    { name: 'add_slide', description: 'Add a slide.', annotations: { readOnlyHint: false } },
    { name: 'inspect_slide', description: 'Inspect a slide.', annotations: { readOnlyHint: true } },
  ] }];
  const vague = P.buildHint(deck, 'Ещё раз, внимательнее', ['deck/new_presentation', 'deck/inspect_slide']);
  assert.match(vague, /уже вызывал: deck\/inspect_slide\.$/);
  const bySlide = P.buildHint(deck, 'Что на других слайдах?', []);
  assert.match(bySlide, /deck\/inspect_slide/);
  assert.doesNotMatch(bySlide + vague, /new_presentation|add_slide/);
  // JSON ужимается без потерь — в лимит входит больше данных
  const pretty = JSON.stringify({ shapes: Array.from({ length: 40 }, (_, i) => ({ id: i, text: `ячейка ${i}` })) }, null, 2);
  const t = P.formatResults([{ name: 'x/y', ok: true, text: pretty }], { maxChars: 100000 });
  assert.ok(t.includes(JSON.stringify(JSON.parse(pretty))), 'JSON в компактном виде');
  // обрезанный результат помечен так, что модель знает долю и что запросить остальное нужно частями
  const cut = P.formatResults([{ name: 'x/y', ok: true, text: 'а'.repeat(5000) }], { maxChars: 2000 });
  assert.match(cut, /показано 2000 из 5000/);
  assert.ok(!P.formatResults([{ name: 'x/y', ok: true, text: '{не json' }]).includes('показано'), 'не-JSON и короткое не трогаем');
});
await test('Локальная программа: модель знает папки компьютера', () => {
  const pc = { home: '/home/u', documents: '/home/u/Документы', cwd: '/home/u' };
  const remote = P.buildContext(fakeServers);
  const local = P.buildContext([{ ...fakeServers[0], computer: pc }]);
  assert.match(local.text, /\/home\/u\/Документы\/имя_файла/);
  // пути Windows — через «/»: «\» модель вставила бы в JSON вызова без экранирования
  const win = P.buildContext([{ ...fakeServers[0], computer: { home: 'C:\\Users\\u', documents: 'C:\\Users\\u\\Documents', cwd: 'C:\\Users\\u' } }]);
  assert.match(win.text, /C:\/Users\/u\/Documents\/имя_файла/);
  assert.doesNotMatch(win.text, /C:\\/);
  assert.match(local.text, /от папки \/home\/u\./);
  assert.doesNotMatch(remote.text, /\/home\/u/);
  assert.notEqual(local.signature, remote.signature, 'в открытом чате контекст с папками отправится заново');
});

for (const s of servers) s.close();
console.log(`\nУспешно: ${passed}`);
process.exit(process.exitCode || 0);

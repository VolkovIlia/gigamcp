// Собирает отладочный бандл для вставки в страницу giga.chat без установки расширения (стаб фона).
const fs = require('fs'), path = require('path'), esbuild = require('esbuild');
const ext = path.join(__dirname, '../extension');
const stub = `
const __listeners = [];
const __state = {
  servers: [{ id: 'calc', name: 'Калькулятор (тест)', url: 'stub://calc', status: 'ok', enabled: true, disabledTools: [], authType: 'none',
    tools: [
      { name: 'add', description: 'Сложить два числа и вернуть сумму.', inputSchema: { type: 'object', properties: { a: { type: 'number', description: 'первое слагаемое' }, b: { type: 'number', description: 'второе слагаемое' } }, required: ['a', 'b'] } },
      { name: 'now', description: 'Текущие дата и время на компьютере пользователя.', inputSchema: { type: 'object', properties: {} } },
    ] }],
  settings: { enabled: true, autoRun: false, autoSend: true, maxResultChars: 15000, contextMaxChars: 24000, maxAutoRounds: 12, toolTimeoutSec: 120 },
  redirectUri: 'https://example.chromiumapp.org/oauth',
};
const __log = (window.__gmcpStubLog = []);
async function __handle(m) {
  __log.push(m);
  const p = m.payload || {};
  if (m.type === 'state') return JSON.parse(JSON.stringify(__state));
  if (m.type === 'saveSettings') { Object.assign(__state.settings, p.patch); setTimeout(() => __listeners.forEach((f) => f({ settings: {} }, 'local'))); return __state.settings; }
  if (m.type === 'updateServer') { Object.assign(__state.servers[0], p.patch); setTimeout(() => __listeners.forEach((f) => f({ servers: {} }, 'local'))); return __state.servers[0]; }
  if (m.type === 'callTool') {
    await new Promise((r) => setTimeout(r, 400));
    if (p.tool === 'add') return { ok: true, text: String(Number(p.arguments.a) + Number(p.arguments.b)), ms: 400 };
    if (p.tool === 'now') return { ok: true, text: new Date().toString(), ms: 400 };
    return { ok: false, text: 'нет такого инструмента' };
  }
  if (m.type === 'refreshServer') return { ok: true };
  throw new Error('В отладочном режиме недоступно: ' + m.type);
}
const chrome = {
  runtime: { lastError: null, sendMessage(m, cb) { __handle(m).then((d) => cb({ ok: true, data: d }), (e) => cb({ ok: false, error: e.message })); }, onMessage: { addListener() {} } },
  storage: { onChanged: { addListener(f) { __listeners.push(f); } } },
};
`;
const src = `(function(){ window.__gmcpLoaded = false; document.querySelectorAll('[data-gmcp]').forEach(e=>e.remove());
${fs.readFileSync(path.join(ext, 'content/protocol.js'), 'utf8')}
${stub}
${fs.readFileSync(path.join(ext, 'content/content.js'), 'utf8')}
})();`;
const out = esbuild.transformSync(src, { minify: true, target: 'chrome116', charset: 'utf8', lineLimit: 400 }).code;
fs.writeFileSync(path.join(__dirname, 'inject.min.js'), out);
console.log('bytes', Buffer.byteLength(out), 'chars', out.length);

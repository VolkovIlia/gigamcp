// E2E: настоящее расширение в Chromium + макет giga.chat + тестовые MCP-серверы.
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { startStreamable, startOAuth } from './servers.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const EXT = join(here, '../extension');
const SHOTS = process.env.SHOTS || join(here, 'shots');
const mock = readFileSync(join(here, 'mock-gigachat.html'), 'utf8');

const http = await startStreamable(4301);
const oauth = await startOAuth(4304, { consent: true });
const cfgDir = mkdtempSync(join(tmpdir(), 'gmcp-e2e-'));
writeFileSync(join(cfgDir, 'servers.json'), JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: [join(here, 'stdio-server.mjs')] } } }));


const profile = mkdtempSync(join(tmpdir(), 'gmcp-prof-'));
// помощник для локальных программ ставится в профиль браузера — как у пользователя, без администратора
spawnSync('python3', [join(here, '../extension/host/install-host.py'), '--browser-dir', profile], { stdio: 'ignore' });
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, viewport: { width: 1280, height: 860 }, locale: 'ru-RU',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let step = 0;
const ok = (name) => console.log(`  ✓ ${++step}. ${name}`);
const fail = async (e, page) => { console.log('  ✗', e.stack || e); if (page) await page.screenshot({ path: join(SHOTS, 'fail.png') }); process.exitCode = 1; };

let page;
try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  assert.equal(extId, 'mmjnppnijhblimofghdejjdhfgdjgcol');
  ok(`расширение загружено, id ${extId}`);

  await ctx.route('https://giga.chat/**', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: mock }));
  page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('    [console]', m.text()); });
  await page.goto('https://giga.chat/');
  const chip = page.locator('[data-gmcp=chip] .chip');
  await chip.waitFor();
  ok('кнопка MCP появилась у поля ввода');

  // добавляем сервер через панель
  await chip.click();
  const panel = page.locator('[data-gmcp=panel] .panel');
  await panel.waitFor();
  await panel.getByText('Добавить сервер по адресу').click();
  await panel.locator('[data-field=name]').fill('Тест');
  await panel.locator('[data-field=url]').fill('http://127.0.0.1:4301/mcp');
  await panel.locator('[data-field=authType]').selectOption('none');
  await panel.getByRole('button', { name: 'Подключить' }).click();
  await panel.getByText('Сервер подключён').waitFor({ timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('[data-gmcp=chip]').shadowRoot.querySelector('.badge').textContent === '4');
  ok('сервер добавлен из панели, 4 инструмента');
  await panel.locator('.srv [data-act=expand]').first().click();
  await page.screenshot({ path: join(SHOTS, 'panel.png') });

  // закрываем панель и пишем в чат
  await page.keyboard.press('Escape');
  await page.locator('#chat-input-textarea').click();
  await page.locator('#chat-input-textarea').fill('Сколько будет 2 + 3?');
  await page.keyboard.press('Enter');
  const sent0 = await page.waitForFunction(() => window.__sent?.[0]).then((h) => h.jsonValue());
  assert.match(sent0, /^\[MCP-КОНТЕКСТ v1 #/);
  assert.match(sent0, /test\/add — Сложить два числа/);
  assert.match(sent0, /Запрос пользователя:\nСколько будет 2 \+ 3\?$/);
  ok('контекст инструментов добавлен к первому сообщению');

  const card = page.locator('[data-gmcp=card] .card').first();
  await card.getByRole('button', { name: 'Выполнить' }).waitFor({ timeout: 10000 });
  assert.equal(await page.evaluate(() => window.__sent.length), 1, 'до подтверждения ничего не отправлено');
  ok('карточка вызова test/add ждёт подтверждения');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, 'card-pending.png') });
  await card.getByRole('button', { name: 'Выполнить' }).click();
  await page.waitForFunction(() => window.__sent.length >= 2, null, { timeout: 15000 });
  const sent1 = await page.evaluate(() => window.__sent[1]);
  assert.match(sent1, /^\[MCP-РЕЗУЛЬТАТ\]\n▶ test\/add — успешно\n5\n/);
  await page.getByText('Готово: 5').waitFor();
  ok('вызов выполнен на MCP-сервере, результат 5 отправлен, модель ответила');
  // служебные сообщения свёрнуты
  await page.waitForFunction(() => document.querySelectorAll('.gmcp-tag').length === 2, null, { timeout: 4000 });
  ok('служебные сообщения свёрнуты в плашки');
  await page.screenshot({ path: join(SHOTS, 'card-done.png') });

  // второй ход: контекст не дублируется, авто-режим
  await chip.click();
  await panel.locator('#gm-auto').click();
  await page.waitForFunction(() => document.querySelector('[data-gmcp=chip]').shadowRoot.querySelector('.auto').hidden === false);
  await page.keyboard.press('Escape');
  await page.locator('#chat-input-textarea').fill('А теперь посчитай ещё раз');
  await page.locator('form button[aria-label="Отправить"]').click();
  await page.waitForFunction(() => window.__sent.length >= 4, null, { timeout: 20000 });
  const sent = await page.evaluate(() => window.__sent);
  assert.equal(sent[2], 'А теперь посчитай ещё раз', 'контекст не повторяется');
  assert.match(sent[3], /^\[MCP-РЕЗУЛЬТАТ\]/);
  await page.waitForFunction(() => document.querySelectorAll('.Message-styled__Bot').length === 4);
  ok('авто-режим: вызов выполнен и результат отправлен без клика, контекст не продублирован');

  // перезагрузка: история не выполняется повторно
  await page.reload();
  await page.locator('[data-gmcp=chip] .chip').waitFor();
  await page.waitForTimeout(2500);
  assert.equal(await page.evaluate(() => window.__sent.length), 0);
  ok('после перезагрузки ничего не выполняется само');

  // OAuth через chrome.identity.launchWebAuthFlow
  await chip.click();
  await panel.getByText('Добавить сервер по адресу').click();
  await panel.locator('[data-field=name]').fill('Защищённый');
  await panel.locator('[data-field=url]').fill('http://127.0.0.1:4304/mcp');
  const popupP = ctx.waitForEvent('page');
  await panel.getByRole('button', { name: 'Подключить' }).click();
  const popup = await popupP;
  await popup.locator('#code').waitFor();
  // неверный код: сервер отвечает 400, окно не должно закрываться
  await popup.locator('#code').fill('000000');
  await popup.getByRole('button', { name: 'Разрешить' }).click();
  await popup.locator('#err').waitFor();
  assert.equal(popup.isClosed(), false);
  ok('OAuth: неверный код показывает ошибку сервера, окно остаётся открытым');
  await popup.goBack();
  await popup.locator('#code').fill('123456');
  await popup.getByRole('button', { name: 'Разрешить' }).click();
  await panel.getByText('Сервер подключён').waitFor({ timeout: 20000 });
  assert.ok(oauth.log.some((l) => l[0] === 'token'));
  await page.waitForFunction(() => document.querySelector('[data-gmcp=chip]').shadowRoot.querySelector('.badge').textContent === '8');
  ok('OAuth: верный код → токен, окно закрылось само, сервер подключён');

  // локальная программа (stdio) через помощник Native Messaging
  await panel.getByText('Локальная программа (stdio)').click();
  await panel.getByText(/Помощник установлен/).waitFor({ timeout: 10000 });
  await panel.locator('[data-field=l_name]').fill('Demo');
  await panel.locator('[data-field=l_command]').fill(process.execPath);
  await panel.locator('[data-field=l_args]').fill(`"${join(here, 'stdio-server.mjs')}"`);
  await panel.getByRole('button', { name: 'Подключить' }).click();
  await panel.getByText('Программа подключена').waitFor({ timeout: 20000 });
  ok('локальная программа подключена через помощник Native Messaging');

  // импорт конфига Claude Desktop
  await panel.getByText('Импорт конфига').click();
  await panel.locator('[data-field=importText]').fill(JSON.stringify({ mcpServers: { calc2: { command: process.execPath, args: [join(here, 'stdio-server.mjs'), '--calc2'], env: { X: '1' } }, web: { url: 'http://127.0.0.1:4301/mcp' } } }));
  await panel.getByRole('button', { name: 'Импортировать' }).click();
  await panel.getByText(/добавлено: calc2/).waitFor({ timeout: 20000 });
  ok('импорт конфига: программа добавлена, уже подключённый адрес пропущен');

  // вызов инструмента локальной программы из чата
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.__sent = []; });
  await page.locator('#chat-input-textarea').fill('Посчитай через демо 7 + 8');
  await page.keyboard.press('Enter');
  await page.getByText('Готово: 15').waitFor({ timeout: 30000 });
  const sentDemo = await page.evaluate(() => window.__sent);
  assert.match(sentDemo[0], /\[MCP-КОНТЕКСТ v1 #/, 'набор инструментов изменился — контекст обновлён');
  assert.match(sentDemo[0], /demo\/add/);
  ok('вызов инструмента локальной программы из чата (авто-режим): 7 + 8 = 15');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, 'panel-all.png') });
} catch (e) {
  await fail(e, page);
} finally {
  await ctx.close();
  http.srv.close(); oauth.srv.close();
}
process.exit(process.exitCode || 0);

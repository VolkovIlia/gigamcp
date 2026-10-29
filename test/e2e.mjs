// E2E: настоящее расширение в Chromium + макет giga.chat + тестовые MCP-серверы.
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
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

const http = await startStreamable(4301, { strictOrigin: true });
const oauth = await startOAuth(4304, { consent: true });
const cfgDir = mkdtempSync(join(tmpdir(), 'gmcp-e2e-'));
writeFileSync(join(cfgDir, 'servers.json'), JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: [join(here, 'stdio-server.mjs')] } } }));


const profile = mkdtempSync(join(tmpdir(), 'gmcp-prof-'));
// помощник для локальных программ ставится в профиль браузера — как у пользователя, без администратора;
// свой HOME, чтобы не трогать настоящий ~/.local/share/gigamcp
const hostHome = mkdtempSync(join(tmpdir(), 'gmcp-home-'));
spawnSync('python3', [join(here, '../extension/host/install-host.py'), '--browser-dir', profile], { stdio: 'ignore', env: { ...process.env, HOME: hostHome } });
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

  // модель отказалась («нет доступа») → расширение само напоминает про инструменты (авто-режим включён)
  await page.locator('#chat-input-textarea').fill('Покажи мои задачи');
  await page.keyboard.press('Enter');
  await page.getByText('Готово: задача 1').waitFor({ timeout: 25000 });
  const sentN = await page.evaluate(() => window.__sent);
  assert.ok(sentN.some((x) => x.startsWith('[MCP-НАПОМИНАНИЕ]')), 'напоминание отправлено');
  ok('отказ «нет доступа» → напоминание → модель вызвала инструмент');

  // ГигаЧат ушёл во встроенные навыки («Ошибка при вызове инструмента») → тоже напоминание
  await page.locator('#chat-input-textarea').fill('Дай список дел');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__sent.filter((x) => x.startsWith('[MCP-НАПОМИНАНИЕ]')).length >= 2 && window.__sent.filter((x) => x.startsWith('[MCP-РЕЗУЛЬТАТ]')).length >= 4, null, { timeout: 25000 });
  ok('«Ошибка при вызове инструмента» (встроенные навыки) → напоминание → вызов');

  // посреди цепочки: после [MCP-РЕЗУЛЬТАТ] ГигаЧат ушёл во встроенные навыки → напоминание с исходным запросом → вызов
  const nudgesBefore = await page.evaluate(() => window.__sent.filter((x) => x.startsWith('[MCP-НАПОМИНАНИЕ]')).length);
  await page.locator('#chat-input-textarea').fill('Создай документ с поздравлением');
  await page.keyboard.press('Enter');
  await page.getByText('Готово: документ сохранён').waitFor({ timeout: 30000 });
  const nudgeMid = await page.evaluate((n) => window.__sent.filter((x) => x.startsWith('[MCP-НАПОМИНАНИЕ]'))[n], nudgesBefore);
  assert.match(nudgeMid, /Создай документ с поздравлением/, 'напоминание повторяет исходный запрос, а не служебный результат');
  ok('после результата ГигаЧат ушёл во встроенные навыки → напоминание → цепочка продолжена через MCP');

  // итоговый ответ после результата — не повод напоминать, даже если запрос явно про функцию (иначе задача выполнится дважды)
  const nudgesBeforeFinal = await page.evaluate(() => window.__sent.filter((x) => x.startsWith('[MCP-НАПОМИНАНИЕ]')).length);
  await page.locator('#chat-input-textarea').fill('Верни текст через echo');
  await page.keyboard.press('Enter');
  await page.getByText('Готово: привет').waitFor({ timeout: 20000 });
  await page.waitForTimeout(3000);
  assert.equal(await page.evaluate(() => window.__sent.filter((x) => x.startsWith('[MCP-НАПОМИНАНИЕ]')).length), nudgesBeforeFinal, 'после итогового ответа напоминания нет');
  assert.equal(await page.locator('[data-gmcp=nudge]').count(), 0, 'и кнопки напоминания нет');
  ok('итоговый ответ после результата: напоминания нет');

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
  assert.ok(sentDemo[0].includes(`Домашняя папка: ${homedir()}.`), 'помощник сообщил папки компьютера, и они дошли до модели');
  ok('вызов инструмента локальной программы из чата (авто-режим): 7 + 8 = 15, модель знает папки компьютера');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, 'panel-all.png') });

  // помощника нет, интернета нет: установщик собирается из файлов расширения и скачивается браузером
  rmSync(join(profile, 'NativeMessagingHosts', 'ru.gigamcp.host.json'));
  await page.locator('[data-gmcp=chip] .chip').click();
  if (!(await panel.getByRole('button', { name: 'Проверить помощник' }).count())) await panel.getByText('Локальная программа (stdio)').click();
  await panel.getByRole('button', { name: 'Проверить помощник' }).first().click();
  await panel.getByText('Помощник не найден').waitFor({ timeout: 10000 });
  await panel.getByRole('button', { name: 'Скачать установщик' }).click();
  // под Playwright браузер сохраняет загрузки под служебными именами — ищем команду, а не имя файла
  const cmd = await panel.locator('code').filter({ hasText: /^python3 "/ }).textContent({ timeout: 15000 });
  const installer = cmd.match(/^python3 "(.+)"$/)?.[1];
  assert.ok(installer, `команда для скачанного файла: ${cmd}`);
  const inst = spawnSync('python3', [installer, '--browser-dir', profile], { encoding: 'utf8', env: { ...process.env, HOME: hostHome } });
  assert.equal(inst.status, 0, inst.stderr + inst.stdout);
  await panel.getByRole('button', { name: 'Проверить помощник' }).first().click();
  await panel.getByText(/Помощник установлен \(v0\.2\.7/).waitFor({ timeout: 10000 });
  ok('установщик скачан из самого расширения (без сети), команда с путём к файлу ставит помощник');
} catch (e) {
  await fail(e, page);
} finally {
  await ctx.close();
  http.srv.close(); oauth.srv.close();
}
process.exit(process.exitCode || 0);

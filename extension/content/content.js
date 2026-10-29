// Интеграция MCP в интерфейс giga.chat: кнопка у поля ввода, панель серверов, цикл вызовов инструментов.
(() => {
  'use strict';
  if (window.__gmcpLoaded) return;
  window.__gmcpLoaded = true;

  const P = window.GMCP.protocol;

  // ---------- селекторы giga.chat (вынесены сюда, чтобы легко поправить при смене вёрстки) ----------
  const SEL = {
    input: '#chat-input-textarea, form textarea[aria-label]',
    // кнопка отправки: ищем внутри формы по подписи
    sendLabel: /отправ|send/i,
    stopLabel: /останов|прерв|stop/i,
    // сообщения: пробуем по очереди, первый набор, который нашёл элементы, побеждает
    assistant: [
      '[class*="MessageItem-styled__AssistantRow"]',
      '[data-testid*="assistant" i]', '[data-role="assistant"]', '[data-author="assistant"]',
      '[class*="BotMessage"]', '[class*="AssistantMessage"]', '[class*="MessageBot"]', '[class*="Message-styled__Bot"]',
    ],
    user: [
      '[class*="MessageItem-styled__UserRow"]',
      '[data-testid*="user-message" i]', '[data-role="user"]', '[data-author="user"]',
      '[class*="UserMessage"]', '[class*="MessageUser"]', '[class*="Message-styled__User"]',
    ],
    // куда вставлять карточку внутри ответа и что сворачивать в сообщении пользователя
    assistantContent: '[class*="MessageItem-styled__AssistantContent"]',
    userBubble: '[class*="MessageItem-styled__UserBubble"]',
    // запасной вариант для ответов: блоки с отрендеренным markdown
    markdown: '[class*="Markdown"], [class*="markdown"]',
    modeButtonText: /^(Рассуждение|Исследование|Гига)$/,
    // место для кнопки MCP: нижняя левая часть поля ввода (там же значок режима «Гига»)
    chipSlot: '[class*="ChatInput-styled__BottomLeft"]',
  };

  const STABLE_MS = 1300;          // ответ считается дописанным, если текст не менялся столько времени
  const AUTO_WINDOW_MS = 15 * 60e3; // авто-выполнение только для ответов на недавнюю отправку

  // ---------- состояние ----------
  let state = { servers: [], settings: { enabled: true, autoRun: false, autoSend: true, maxResultChars: 15000, contextMaxChars: 14000, maxAutoRounds: 12 }, redirectUri: '' };
  let lastSendAt = 0;
  let autoRounds = 0;
  let bypass = false;
  let dead = false; // контекст расширения потерян (расширение перезагружено)
  const entries = new Map(); // key -> entry (вызовы в одном ответе)
  const textSeen = new WeakMap(); // el -> {text, at}
  const ui = { open: false, expanded: new Set(), addOpen: false, localOpen: false, importOpen: false, busy: new Set(), form: { name: '', url: '', authType: 'auto', token: '', clientId: '', clientSecret: '' }, local: { name: '', command: '', args: '', env: '', cwd: '' }, importText: '', host: null, msg: null };

  const doneKey = 'gmcp:done';
  const doneSet = new Set(JSON.parse(sessionStorage.getItem(doneKey) || '[]'));
  const markDone = (k) => { doneSet.add(k); try { sessionStorage.setItem(doneKey, JSON.stringify([...doneSet].slice(-300))); } catch {} };

  // ---------- связь с фоном ----------
  function bg(type, payload) {
    return new Promise((resolve, reject) => {
      if (dead) return reject(new Error('Расширение обновлено — перезагрузите страницу'));
      try {
        chrome.runtime.sendMessage({ type, payload }, (r) => {
          const le = chrome.runtime.lastError;
          if (le) return reject(new Error(le.message));
          if (!r) return reject(new Error('Нет ответа от фона расширения'));
          if (r.ok) resolve(r.data); else reject(Object.assign(new Error(r.error), { needsAuth: r.needsAuth, needClientId: r.needClientId }));
        });
      } catch (e) {
        dead = true;
        reject(new Error('Расширение обновлено — перезагрузите страницу'));
      }
    });
  }

  async function refreshState() {
    try { state = await bg('state'); } catch (e) { flash(e.message, 'error'); }
    renderChip(); renderPanel();
  }

  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && (ch.servers || ch.settings)) refreshState();
    });
    chrome.runtime.onMessage.addListener((m) => { if (m?.type === 'togglePanel') togglePanel(); });
  } catch {}

  // ---------- вспомогательное ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isOurs = (el) => !!el?.closest?.('[data-gmcp]');

  function activeServers() {
    return state.servers
      .filter((s) => s.enabled && s.status === 'ok' && s.tools?.length)
      .map((s) => ({ id: s.id, name: s.name, instructions: s.instructions, tools: s.tools.filter((t) => !(s.disabledTools || []).includes(t.name)) }))
      .filter((s) => s.tools.length);
  }
  const currentContext = () => P.buildContext(activeServers(), { maxChars: state.settings.contextMaxChars });
  const mcpOn = () => state.settings.enabled && activeServers().length > 0;

  // ---------- DOM giga.chat ----------
  const getInput = () => document.querySelector(SEL.input);
  const getForm = () => getInput()?.closest('form') || null;

  function labelOf(b) { return `${b.getAttribute('aria-label') || ''} ${b.getAttribute('title') || ''} ${b.innerText || ''}`.trim(); }

  function findSendButton() {
    const form = getForm();
    if (!form) return null;
    const btns = [...form.querySelectorAll('button')].filter((b) => !isOurs(b));
    return btns.find((b) => SEL.sendLabel.test(labelOf(b))) || form.querySelector('button[type="submit"]') || null;
  }

  function isGenerating() {
    const form = getForm();
    const scope = form ? form.parentElement || form : document;
    return [...scope.querySelectorAll('button')].some((b) => !isOurs(b) && b.getClientRects().length > 0 && SEL.stopLabel.test(labelOf(b)));
  }

  function setInputValue(text) {
    const ta = getInput();
    if (!ta) throw new Error('Не найдено поле ввода giga.chat');
    const proto = ta instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function submitInput() {
    const ta = getInput();
    for (let i = 0; i < 20; i++) {
      const b = findSendButton();
      if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') {
        bypass = true;
        try { b.click(); } finally { setTimeout(() => (bypass = false), 0); }
        return true;
      }
      await sleep(100);
    }
    // запасной путь — Enter в поле ввода
    bypass = true;
    try {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    } finally { setTimeout(() => (bypass = false), 0); }
    return true;
  }

  async function waitIdle(timeout = 120000) {
    const t0 = Date.now();
    while (isGenerating() && Date.now() - t0 < timeout) await sleep(300);
  }

  /** Отправить текст в чат от имени пользователя (результаты инструментов). */
  async function sendToChat(text) {
    await waitIdle();
    setInputValue(text);
    await sleep(120);
    lastSendAt = Date.now();
    await submitInput();
  }

  function pickAll(list) {
    for (const s of list) {
      let els; try { els = [...document.querySelectorAll(s)]; } catch { continue; }
      els = els.filter((e) => !isOurs(e));
      if (els.length) return els;
    }
    return [];
  }
  const outermost = (els) => els.filter((e) => !els.some((o) => o !== e && o.contains(e)));

  /** Сообщения чата по порядку: [{el, role}] */
  function getMessages() {
    let a = outermost(pickAll(SEL.assistant));
    const u = outermost(pickAll(SEL.user));
    if (!a.length) {
      // запасной вариант: отрендеренный markdown вне поля ввода и вне сообщений пользователя
      const form = getForm();
      a = outermost([...document.querySelectorAll(SEL.markdown)].filter((e) => !isOurs(e) && !(form && form.contains(e)) && !u.some((x) => x.contains(e))));
    }
    const all = [...a.map((el) => ({ el, role: 'assistant' })), ...u.map((el) => ({ el, role: 'user' }))];
    all.sort((x, y) => (x.el.compareDocumentPosition(y.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    return all;
  }

  const isServiceText = (t) => t.includes(P.CTX_OPEN) || t.includes(P.RES_OPEN) || t.includes(P.NUDGE_OPEN);

  function chatHasContext(signature) {
    for (const m of getMessages()) {
      const t = m.el.innerText || '';
      const sig = P.contextSignatureIn(t);
      if (sig && (!signature || sig === signature)) return true;
    }
    return false;
  }

  // ---------- вставка контекста при отправке ----------

  function needsContext() {
    if (!mcpOn()) return null;
    const ctx = currentContext();
    if (chatHasContext(ctx.signature)) return null;
    return ctx;
  }

  function injectInto(text) {
    const ctx = needsContext();
    if (!ctx) return null;
    if (isServiceText(text)) return null;
    const full = P.buildContext(activeServers(), { maxChars: state.settings.contextMaxChars, query: text });
    return `${full.text}\n\nЗапрос пользователя:\n${text}`;
  }

  function onUserSend() { lastSendAt = Date.now(); autoRounds = 0; }

  function interceptKey(e) {
    if (bypass || e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
    const ta = getInput();
    if (!ta || e.target !== ta) return;
    const val = ta.value;
    if (!val.trim()) return;
    const next = injectInto(val);
    onUserSend();
    if (!next) return;
    e.preventDefault(); e.stopImmediatePropagation();
    setInputValue(next);
    setTimeout(() => submitInput(), 80);
  }

  function interceptClick(e) {
    if (bypass) return;
    const b = e.target?.closest?.('button');
    if (!b || isOurs(b)) return;
    const send = findSendButton();
    if (!send || b !== send) return;
    const ta = getInput();
    const val = ta?.value || '';
    if (!val.trim()) return;
    const next = injectInto(val);
    onUserSend();
    if (!next) return;
    e.preventDefault(); e.stopImmediatePropagation();
    setInputValue(next);
    setTimeout(() => submitInput(), 80);
  }

  document.addEventListener('keydown', interceptKey, true);
  document.addEventListener('click', interceptClick, true);

  // ---------- поиск вызовов в ответах ----------

  function extractCalls(msgEl) {
    const found = [];
    for (const pre of msgEl.querySelectorAll('pre')) {
      if (isOurs(pre)) continue;
      const c = P.parseCallText(pre.innerText || pre.textContent || '');
      if (c) found.push({ call: c, anchor: pre });
    }
    if (!found.length) {
      const txt = msgEl.innerText || '';
      if (txt.includes('"call"') || txt.includes('"tool"')) {
        for (const c of P.extractCallsFromText(txt)) found.push({ call: c, anchor: null });
        if (!found.length) {
          // JSON без ограждения ``` — ищем объекты с полем "call"
          const re = /\{\s*"call"\s*:\s*"[^"]+"[\s\S]*?\}\s*\}/g;
          let m; while ((m = re.exec(txt))) { const c = P.parseCallText(m[0]); if (c) found.push({ call: c, anchor: null }); }
        }
      }
    }
    return found;
  }

  function isStable(el) {
    const text = el.innerText || '';
    const prev = textSeen.get(el);
    const now = Date.now();
    if (!prev || prev.text !== text) { textSeen.set(el, { text, at: now }); return false; }
    return now - prev.at >= STABLE_MS;
  }

  let scanTimer = null;
  function scheduleScan(ms = 250) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, ms);
  }

  function scan() {
    if (dead) return;
    ensureChip();
    const msgs = getMessages();
    collapseService(msgs);
    let lastAssistantIdx = -1;
    msgs.forEach((m, i) => { if (m.role === 'assistant') lastAssistantIdx = i; });
    let pendingRecheck = false;
    let aIndex = -1;
    msgs.forEach((m, i) => {
      if (m.role !== 'assistant') return;
      aIndex++;
      const text = m.el.innerText || '';
      if (isServiceText(text)) return;
      if (!text.includes('"call"') && !text.includes('"tool"')) return;
      const isLast = i === lastAssistantIdx;
      const followedByUser = msgs.slice(i + 1).some((x) => x.role === 'user');
      if (isLast && (!isStable(m.el) || isGenerating())) { pendingRecheck = true; return; }
      const found = extractCalls(m.el);
      if (!found.length) return;
      const key = `${location.pathname}#${aIndex}#${P.hash(JSON.stringify(found.map((f) => f.call)))}`;
      let entry = entries.get(key);
      if (!entry) {
        entry = {
          key, el: m.el, calls: found.map((f) => ({ ...f.call, status: 'pending', result: null })),
          anchors: found.map((f) => f.anchor), status: 'pending', detectedAt: Date.now(), card: null,
          history: doneSet.has(key) || followedByUser || !isLast,
        };
        if (entry.history) entry.status = doneSet.has(key) ? 'done-before' : 'history';
        entries.set(key, entry);
        const eligibleAuto = !entry.history && state.settings.autoRun && state.settings.enabled && lastSendAt && entry.detectedAt - lastSendAt < AUTO_WINDOW_MS;
        attachCard(entry);
        if (eligibleAuto) {
          if (autoRounds >= state.settings.maxAutoRounds) {
            entry.note = `Авто-режим остановлен после ${autoRounds} шагов подряд. Подтвердите вручную.`;
            renderCard(entry);
          } else { autoRounds++; runEntry(entry, { auto: true }); }
        }
      } else {
        entry.el = m.el;
        attachCard(entry);
      }
    });
    checkRefusal(msgs, lastAssistantIdx);
    if (pendingRecheck) scheduleScan(STABLE_MS / 2);
  }

  // ---------- модель отказалась пользоваться инструментами ----------

  const nudgeKey = 'gmcp:nudged';
  const nudged = new Set(JSON.parse(sessionStorage.getItem(nudgeKey) || '[]'));
  let nudgeHost = null;

  function lastHumanQuery(msgs, before) {
    for (let i = before - 1; i >= 0; i--) {
      if (msgs[i].role !== 'user') continue;
      const t = msgs[i].el.innerText || '';
      if (t.includes(P.RES_OPEN) || t.includes(P.NUDGE_OPEN)) return null; // предыдущий шаг уже служебный
      const j = t.lastIndexOf('Запрос пользователя:');
      return { query: j >= 0 ? t.slice(j + 20).trim() : t.trim(), withContext: t.includes(P.CTX_OPEN) };
    }
    return null;
  }

  const NUDGE_TEXT = {
    refusal: 'ГигаЧат ответил, что у него нет доступа, хотя инструменты подключены.',
    deflect: 'ГигаЧат попробовал свои встроенные навыки вместо функций GigaMCP.',
    missed: 'Похоже, запрос про подключённую систему, но ГигаЧат не вызвал функцию.',
  };

  function checkRefusal(msgs, lastIdx) {
    if (lastIdx < 0 || !mcpOn() || isGenerating()) return;
    const m = msgs[lastIdx];
    if (msgs.slice(lastIdx + 1).some((x) => x.role === 'user')) return;
    const text = m.el.innerText || '';
    if (!text.trim() || isServiceText(text) || extractCalls(m.el).length) return;
    if (!chatHasContext(null)) return;
    const q = lastHumanQuery(msgs, lastIdx);
    if (!q) return;
    const reason = P.nudgeReason(text, activeServers(), q.query);
    if (!reason) return;
    const prev = textSeen.get(m.el);
    if (!prev || prev.text !== text || Date.now() - prev.at < STABLE_MS) { isStable(m.el); scheduleScan(STABLE_MS); return; }
    const query = q.query;
    const key = `${location.pathname}#${P.hash(text.slice(0, 400))}`;
    if (nudged.has(key)) return;
    const send = () => {
      nudged.add(key);
      try { sessionStorage.setItem(nudgeKey, JSON.stringify([...nudged].slice(-100))); } catch {}
      nudgeHost?.remove(); nudgeHost = null;
      sendToChat(P.buildNudge(activeServers(), query)).catch((e) => flash(e.message, 'error'));
    };
    const recent = lastSendAt && Date.now() - lastSendAt < AUTO_WINDOW_MS;
    const autoOk = reason !== 'missed' || q.withContext; // «не вызвал» — сами напоминаем только сразу после контекста
    if (state.settings.autoRun && recent && autoOk && autoRounds < state.settings.maxAutoRounds) { autoRounds++; send(); return; }
    if (nudgeHost && m.el.contains(nudgeHost)) return;
    nudgeHost?.remove();
    nudgeHost = document.createElement('div');
    nudgeHost.setAttribute('data-gmcp', 'nudge');
    nudgeHost.style.cssText = 'display:block;margin:8px 0;';
    styleHost(nudgeHost);
    const sr = nudgeHost.attachShadow({ mode: 'open' });
    sr.innerHTML = `<style>${BASE_CSS}
      .box { display:flex; gap:10px; align-items:center; flex-wrap:wrap; border:1px solid var(--line); border-radius:14px; background:var(--bg2); padding:9px 12px; max-width:760px; }
      .box span { flex:1; min-width:200px; font-size:12.5px; color:var(--fg2); }
    </style><div class="t"><div class="box"><span>${NUDGE_TEXT[reason]}</span><button class="btn primary" data-act="nudge">Напомнить про инструменты</button></div></div>`;
    sr.querySelector('.t').classList.toggle('light', isLightPage());
    sr.querySelector('[data-act=nudge]').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); lastSendAt = Date.now(); send(); });
    (m.el.querySelector(SEL.assistantContent) || m.el).appendChild(nudgeHost);
  }

  // ---------- выполнение ----------

  async function runCall(c) {
    const servers = activeServers();
    if (c.name === P.DESCRIBE) {
      return { ok: true, text: P.describeTools(servers, c.arguments?.tools || []) };
    }
    // ищем и среди выключенных инструментов, чтобы дать понятную ошибку
    const ref = P.resolveName(servers, c.name);
    if (!ref) {
      const all = P.resolveName(state.servers.map((s) => ({ id: s.id, tools: s.tools || [] })), c.name);
      if (all) return { ok: false, text: `Инструмент ${c.name} выключен пользователем. Не вызывай его.` };
      const names = servers.flatMap((s) => s.tools.map((t) => `${s.id}/${t.name}`));
      return { ok: false, text: `Инструмент «${c.name}» не найден. Доступные: ${names.slice(0, 60).join(', ')}${names.length > 60 ? '…' : ''}` };
    }
    c.resolved = `${ref.server.id}/${ref.tool.name}`;
    return bg('callTool', { serverId: ref.server.id, tool: ref.tool.name, arguments: c.arguments });
  }

  async function runEntry(entry, { auto = false } = {}) {
    if (entry.status === 'running') return;
    entry.status = 'running'; entry.note = null;
    renderCard(entry);
    for (const c of entry.calls) {
      if (c.status === 'done' || c.status === 'error') continue;
      c.status = 'running'; renderCard(entry);
      try {
        const r = await runCall(c);
        c.result = r; c.status = r.ok ? 'done' : 'error';
        if (r.needsAuth) entry.note = 'Сервер требует вход: откройте панель MCP и нажмите «Войти».';
      } catch (e) {
        c.result = { ok: false, text: e.message }; c.status = 'error';
      }
      renderCard(entry);
    }
    entry.status = 'done';
    markDone(entry.key);
    entry.resultText = P.formatResults(entry.calls.map((c) => ({ name: c.resolved || c.name, ok: c.status === 'done', text: c.result?.text })), { maxChars: state.settings.maxResultChars });
    if (state.settings.autoSend) {
      entry.sent = true; renderCard(entry);
      try { await sendToChat(entry.resultText); } catch (e) { entry.sent = false; entry.note = e.message; }
    } else {
      try { setInputValue(entry.resultText); } catch {}
      entry.note = 'Результат вставлен в поле ввода — проверьте и отправьте.';
    }
    renderCard(entry);
  }

  // ---------- стили ----------

  const BASE_CSS = `
    :host { all: initial; color-scheme: dark light; }
    * { box-sizing: border-box; }
    .t { --bg: rgba(24,26,31,.97); --bg2: rgba(255,255,255,.05); --bg3: rgba(255,255,255,.09); --fg: #ECEEF1; --fg2: #A3A9B3; --line: rgba(255,255,255,.10);
         --acc: #21A038; --acc-fg: #FFFFFF; --acc-btn: #15852C; --mint: #80F67C; --err: #FF6B6B; --warn: #F5B94A; --run: #6CB4FF;
         font-family: var(--gmcp-font, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif); font-size: 13px; line-height: 1.45; color: var(--fg); -webkit-font-smoothing: antialiased; }
    .t.light { --bg: rgba(255,255,255,.98); --bg2: rgba(0,0,0,.04); --bg3: rgba(0,0,0,.07); --fg: #16181D; --fg2: #5F6670; --line: rgba(0,0,0,.10); --acc: #107F2A; --acc-fg: #fff; --acc-btn: #107F2A; --mint: #107F2A; }
    button { font: inherit; color: inherit; cursor: pointer; border: 0; background: none; }
    button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--acc); outline-offset: 1px; }
    .btn { padding: 6px 12px; border-radius: 10px; background: var(--bg3); font-weight: 500; white-space: nowrap; }
    .btn:hover { filter: brightness(1.15); }
    .btn.primary { background: var(--acc-btn); color: var(--acc-fg); }
    .btn.danger { color: var(--err); }
    .btn.small { padding: 3px 8px; border-radius: 8px; font-size: 12px; }
    .btn[disabled] { opacity: .5; cursor: default; }
    .muted { color: var(--fg2); }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
    input[type=text], input[type=url], input[type=password], select, textarea { width: 100%; padding: 7px 10px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg2); color: var(--fg); font: inherit; }
    select option { color: #111; }
    .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; background: var(--fg2); }
    .dot.ok { background: var(--acc); } .dot.error { background: var(--err); } .dot.auth { background: var(--warn); }
    .sw { position: relative; width: 30px; height: 18px; border-radius: 9px; background: var(--bg3); flex: none; transition: background .15s; }
    .sw::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--fg2); transition: transform .15s, background .15s; }
    .sw[aria-checked=true] { background: var(--acc); } .sw[aria-checked=true]::after { transform: translateX(12px); background: var(--acc-fg); }
    svg { display: block; }
    [hidden] { display: none !important; }
  `;

  const ICON = {
    mark: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5 1 H13 A2 2 0 0 1 15 3 V11 A2 2 0 0 1 13 13 H7 C6 13.6 4.5 14.8 0.7999999999999998 15.4 C2.2 14.2 3 13 3 9.5 V3 A2 2 0 0 1 5 1 Z M6 3 A1 1 0 0 0 5 4 V10 A1 1 0 0 0 6 11 H12 A1 1 0 0 0 13 10 V4 A1 1 0 0 0 12 3 Z M7.5 5 H10.5 A0.5 0.5 0 0 1 11 5.5 V8.5 A0.5 0.5 0 0 1 10.5 9 H7.5 A0.5 0.5 0 0 1 7 8.5 V5.5 A0.5 0.5 0 0 1 7.5 5 Z"/></svg>',
    tool: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L3 17.8V21h3.2l6.3-6.3a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.4-.6-.6-2.4 2.6-2.6z"/></svg>',
    refresh: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/></svg>',
    chevron: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg>',
    close: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  };

  function pageFont() {
    const el = getInput() || document.body;
    return (el && getComputedStyle(el).fontFamily) || '';
  }
  function styleHost(host) {
    const f = pageFont();
    if (f) host.style.setProperty('--gmcp-font', f);
  }

  function isLightPage() {
    const c = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g);
    if (!c) return false;
    const [r, g, b, a = 1] = c.map(Number);
    if (a < 0.5) return false;
    return 0.299 * r + 0.587 * g + 0.114 * b > 160;
  }

  // ---------- кнопка у поля ввода ----------

  let chipHost = null;
  function ensureChip() {
    const form = getForm();
    if (!form) return;
    const slot = form.querySelector(SEL.chipSlot);
    if (chipHost && (slot ? chipHost.parentElement === slot : form.contains(chipHost))) return;
    if (!chipHost) {
      chipHost = document.createElement('span');
      chipHost.setAttribute('data-gmcp', 'chip');
      chipHost.style.cssText = 'display:inline-flex;align-items:center;flex:none;';
      styleHost(chipHost);
      const sr = chipHost.attachShadow({ mode: 'open' });
      sr.innerHTML = `<style>${BASE_CSS}
        .chip { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 14px; background: var(--bg2); border: 1px solid var(--line); color: var(--fg); font-weight: 500; font-size: 12.5px; }
        .chip:hover { background: var(--bg3); }
        .chip.on { border-color: color-mix(in srgb, var(--acc) 55%, transparent); }
        .chip.on .ic { color: var(--acc); }
        .badge { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--bg3); font-size: 11px; display: inline-grid; place-items: center; }
        .chip.on .badge { background: var(--acc-btn); color: var(--acc-fg); }
        .auto { font-size: 10px; letter-spacing: .04em; color: var(--mint); }
      </style><div class="t"><button class="chip" type="button" aria-haspopup="dialog" aria-expanded="false"><span class="ic">${ICON.mark}</span><span>MCP</span><span class="badge">0</span><span class="auto" hidden>АВТО</span></button></div>`;
      sr.querySelector('.chip').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); togglePanel(); });
    }
    if (slot) {
      chipHost.style.marginLeft = slot.children.length ? '8px' : '0';
      slot.appendChild(chipHost);
      renderChip();
      return;
    }
    // запасные места: рядом с кнопками режимов, иначе — у кнопки «Прикрепить файл»
    const modeBtn = [...form.querySelectorAll('button')].find((b) => SEL.modeButtonText.test((b.innerText || '').trim()));
    let anchor = null;
    if (modeBtn) {
      // поднимаемся до контейнера всей группы режимов
      let g = modeBtn;
      while (g.parentElement && g.parentElement !== form) {
        const btns = [...g.parentElement.querySelectorAll('button')].filter((b) => !isOurs(b));
        if (btns.every((b) => SEL.modeButtonText.test((b.innerText || '').trim()))) g = g.parentElement; else break;
      }
      anchor = g;
    }
    if (anchor && anchor.parentElement) anchor.parentElement.insertBefore(chipHost, anchor.nextSibling);
    else {
      const attach = [...form.querySelectorAll('button')].find((b) => /прикреп|attach/i.test(labelOf(b)));
      if (attach?.parentElement) attach.parentElement.insertBefore(chipHost, attach.nextSibling);
      else form.appendChild(chipHost);
    }
    renderChip();
  }

  function renderChip() {
    if (!chipHost) return;
    const sr = chipHost.shadowRoot;
    const t = sr.querySelector('.t');
    t.classList.toggle('light', isLightPage());
    const n = activeServers().reduce((a, s) => a + s.tools.length, 0);
    const chip = sr.querySelector('.chip');
    chip.classList.toggle('on', mcpOn());
    chip.setAttribute('aria-expanded', String(ui.open));
    chip.title = mcpOn() ? `MCP включён: ${n} инструментов` : (state.settings.enabled ? 'MCP: нет подключённых серверов' : 'MCP выключен');
    sr.querySelector('.badge').textContent = String(n);
    sr.querySelector('.auto').hidden = !(mcpOn() && state.settings.autoRun);
  }

  // ---------- панель ----------

  let panelHost = null;
  function ensurePanel() {
    if (panelHost) return panelHost;
    panelHost = document.createElement('div');
    panelHost.setAttribute('data-gmcp', 'panel');
    panelHost.style.cssText = 'position:fixed;z-index:2147483000;inset:auto;';
    styleHost(panelHost);
    const sr = panelHost.attachShadow({ mode: 'open' });
    sr.innerHTML = `<style>${BASE_CSS}
      .panel { position: fixed; width: min(400px, calc(100vw - 32px)); max-height: min(72vh, 640px); display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 18px 50px rgba(0,0,0,.45); backdrop-filter: blur(14px); overflow: hidden; }
      .hd { display: flex; align-items: center; gap: 10px; padding: 12px 14px 10px; border-bottom: 1px solid var(--line); }
      .hd h2 { margin: 0; font-size: 14px; font-weight: 600; flex: 1; }
      .body { overflow: auto; padding: 6px 0 10px; }
      .row { display: flex; align-items: center; gap: 10px; padding: 7px 14px; }
      .row label { flex: 1; cursor: pointer; }
      .sec { padding: 8px 14px 2px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--fg2); }
      .srv { margin: 4px 10px; border-radius: 12px; background: var(--bg2); }
      .srv-h { display: flex; align-items: center; gap: 8px; padding: 9px 10px; }
      .srv-name { flex: 1; min-width: 0; }
      .srv-name b { font-weight: 600; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .srv-name small { color: var(--fg2); font-size: 11.5px; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .icon-btn { width: 26px; height: 26px; border-radius: 8px; display: grid; place-items: center; color: var(--fg2); }
      .icon-btn:hover { background: var(--bg3); color: var(--fg); }
      .icon-btn.open svg { transform: rotate(90deg); }
      .srv-b { padding: 0 10px 10px; display: grid; gap: 8px; }
      .err { color: var(--err); font-size: 12px; padding: 0 10px 8px; }
      .warn { color: var(--warn); font-size: 12px; }
      .tools { max-height: 220px; overflow: auto; border-radius: 10px; background: var(--bg2); padding: 4px 0; }
      .tool { display: flex; gap: 8px; align-items: flex-start; padding: 4px 8px; }
      .tool input { margin-top: 3px; accent-color: var(--acc); }
      .tool div { min-width: 0; } .tool b { font-weight: 500; font-size: 12.5px; } .tool small { display: block; color: var(--fg2); font-size: 11.5px; }
      .actions { display: flex; flex-wrap: wrap; gap: 6px; }
      .add { margin: 6px 10px; padding: 10px; border-radius: 12px; border: 1px dashed var(--line); display: grid; gap: 8px; }
      .toggle-sec { width: calc(100% - 20px); margin: 4px 10px; text-align: left; padding: 9px 10px; border-radius: 12px; color: var(--fg2); display: flex; gap: 6px; align-items: center; }
      .toggle-sec:hover { background: var(--bg2); color: var(--fg); }
      .ft { border-top: 1px solid var(--line); padding: 10px 14px; display: flex; align-items: center; gap: 10px; }
      .ft .muted { flex: 1; font-size: 12px; }
      .msg { margin: 6px 14px; padding: 8px 10px; border-radius: 10px; font-size: 12.5px; background: var(--bg3); }
      .msg.error { color: var(--err); } .msg.ok { color: var(--acc); }
      .empty { padding: 10px 14px; color: var(--fg2); }
      .hint { font-size: 11.5px; color: var(--fg2); }
      code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11.5px; background: var(--bg3); padding: 1px 4px; border-radius: 5px; }
    </style><div class="t"><div class="panel" role="dialog" aria-label="MCP-серверы" hidden></div></div>`;
    document.documentElement.appendChild(panelHost);
    const panel = sr.querySelector('.panel');
    panel.addEventListener('click', onPanelClick);
    panel.addEventListener('input', onPanelInput);
    panel.addEventListener('change', onPanelChange);
    // клавиши внутри панели не должны долетать до горячих клавиш giga.chat
    panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { togglePanel(false); chipHost?.shadowRoot.querySelector('.chip')?.focus(); } e.stopPropagation(); }, false);
    document.addEventListener('keydown', (e) => { if (ui.open && e.key === 'Escape') togglePanel(false); }, true);
    document.addEventListener('mousedown', (e) => {
      if (!ui.open) return;
      const path = e.composedPath();
      if (path.includes(panelHost) || (chipHost && path.includes(chipHost))) return;
      togglePanel(false);
    }, true);
    window.addEventListener('resize', positionPanel);
    return panelHost;
  }

  function togglePanel(force) {
    ensurePanel();
    ui.open = typeof force === 'boolean' ? force : !ui.open;
    if (ui.open) refreshState(); else renderPanel();
    renderChip();
  }

  function positionPanel() {
    if (!panelHost || !ui.open) return;
    const panel = panelHost.shadowRoot.querySelector('.panel');
    const r = chipHost?.isConnected ? chipHost.getBoundingClientRect() : null;
    const w = panel.offsetWidth || 400;
    if (r && r.width) {
      const left = Math.min(Math.max(16, r.left), window.innerWidth - w - 16);
      panel.style.left = left + 'px';
      const spaceAbove = r.top - 12;
      if (spaceAbove > 320) { panel.style.bottom = (window.innerHeight - r.top + 8) + 'px'; panel.style.top = 'auto'; panel.style.maxHeight = Math.min(640, spaceAbove - 8) + 'px'; }
      else { panel.style.top = (r.bottom + 8) + 'px'; panel.style.bottom = 'auto'; panel.style.maxHeight = Math.min(640, window.innerHeight - r.bottom - 24) + 'px'; }
    } else {
      panel.style.right = '16px'; panel.style.bottom = '16px'; panel.style.left = 'auto'; panel.style.top = 'auto';
    }
  }

  function flash(text, kind = 'info') {
    ui.msg = text ? { text, kind } : null;
    renderPanel();
    if (text && kind !== 'error') setTimeout(() => { if (ui.msg?.text === text) { ui.msg = null; renderPanel(); } }, 5000);
  }

  function serverHtml(s) {
    const open = ui.expanded.has(s.id);
    const busy = ui.busy.has(s.id);
    const disabled = new Set(s.disabledTools || []);
    const total = s.tools?.length || 0;
    const on = total - [...disabled].filter((n) => s.tools?.some((t) => t.name === n)).length;
    const statusText = s.status === 'ok' ? `${on}/${total} инструментов` : s.status === 'auth' ? 'нужен вход' : s.status === 'error' ? 'ошибка' : 'подключение…';
    let h = `<div class="srv" data-id="${esc(s.id)}">
      <div class="srv-h">
        <span class="dot ${esc(s.status)}" aria-hidden="true"></span>
        <div class="srv-name"><b>${esc(s.name)}</b><small>${esc(s.id)} · ${busy ? 'обновляю…' : esc(statusText)}${s.transport === 'stdio' ? ' · локальная программа' : ''}</small></div>
        ${s.status === 'auth' && s.authType !== 'bearer' ? `<button class="btn small primary" data-act="auth">Войти</button>` : ''}
        <button class="icon-btn" data-act="refresh" title="Обновить список инструментов" aria-label="Обновить">${ICON.refresh}</button>
        <button class="sw" role="switch" aria-checked="${!!s.enabled}" data-act="toggle-server" aria-label="Включить сервер ${esc(s.name)}"></button>
        <button class="icon-btn ${open ? 'open' : ''}" data-act="expand" aria-expanded="${open}" aria-label="Подробнее">${ICON.chevron}</button>
      </div>`;
    if (s.lastError && s.status !== 'ok') h += `<div class="err">${esc(s.lastError)}</div>`;
    if (open) {
      const where = s.transport === 'stdio' ? `$ ${[s.command, ...(s.args || [])].join(' ')}` : `${s.url}${s.transportUsed ? ` · ${s.transportUsed === 'sse' ? 'SSE' : 'Streamable HTTP'}` : ''}`;
      h += `<div class="srv-b"><div class="hint mono" style="word-break:break-all">${esc(where)}</div>`;
      if (total) {
        h += `<div class="actions"><button class="btn small" data-act="all-on">Включить все</button><button class="btn small" data-act="all-off">Выключить все</button></div><div class="tools">`;
        for (const t of s.tools) {
          h += `<label class="tool"><input type="checkbox" data-act="tool" data-tool="${esc(t.name)}" ${disabled.has(t.name) ? '' : 'checked'}><div><b>${esc(t.name)}</b>${t.description ? `<small>${esc(t.description.slice(0, 140))}</small>` : ''}</div></label>`;
        }
        h += `</div>`;
      }
      if (s.authType === 'bearer') h += `<div style="display:flex;gap:6px"><input type="password" placeholder="Новый токен" data-field="newToken" aria-label="Новый токен"><button class="btn small" data-act="set-token">Сохранить</button></div>`;
      h += `<div class="actions">${s.authType === 'oauth' ? '<button class="btn small" data-act="auth">Войти заново</button><button class="btn small" data-act="logout">Выйти</button>' : ''}<button class="btn small danger" data-act="remove">Удалить</button></div></div>`;
    }
    return h + '</div>';
  }

  function renderPanel() {
    if (!panelHost) return;
    const sr = panelHost.shadowRoot;
    const t = sr.querySelector('.t');
    t.classList.toggle('light', isLightPage());
    const panel = sr.querySelector('.panel');
    panel.hidden = !ui.open;
    if (!ui.open) return;
    // сохраняем фокус и прокрутку при перерисовке
    const active = sr.activeElement;
    const focusKey = active?.getAttribute?.('data-field') || active?.getAttribute?.('data-act');
    const scroll = panel.querySelector('.body')?.scrollTop || 0;
    const st = state.settings;
    const ctx = currentContext();
    const f = ui.form;
    panel.innerHTML = `
      <div class="hd"><span style="color:var(--acc)">${ICON.mark}</span><h2>MCP-серверы</h2>
        <button class="sw" role="switch" aria-checked="${!!st.enabled}" data-act="toggle-enabled" title="Использовать MCP в чате" aria-label="Использовать MCP в чате"></button>
        <button class="icon-btn" data-act="close" aria-label="Закрыть">${ICON.close}</button></div>
      <div class="body">
        ${ui.msg ? `<div class="msg ${esc(ui.msg.kind)}" role="status">${esc(ui.msg.text)}</div>` : ''}
        <div class="row"><label for="gm-auto">Выполнять вызовы без подтверждения</label><button id="gm-auto" class="sw" role="switch" aria-checked="${!!st.autoRun}" data-act="toggle-auto"></button></div>
        <div class="row"><label for="gm-send">Сразу отправлять результат в чат</label><button id="gm-send" class="sw" role="switch" aria-checked="${!!st.autoSend}" data-act="toggle-send"></button></div>
        <div class="sec">Серверы</div>
        ${state.servers.length ? state.servers.map(serverHtml).join('') : '<div class="empty">Пока ни одного сервера. Добавьте первый ниже.</div>'}
        <button class="toggle-sec" data-act="toggle-add" aria-expanded="${ui.addOpen}">${ui.addOpen ? '−' : '+'} Добавить сервер по адресу</button>
        ${ui.addOpen ? `<div class="add">
          <input type="text" data-field="name" placeholder="Название, например Taska" value="${esc(f.name)}" aria-label="Название">
          <input type="url" data-field="url" placeholder="https://example.com/mcp" value="${esc(f.url)}" aria-label="Адрес MCP-сервера">
          <select data-field="authType" aria-label="Авторизация">
            <option value="auto" ${f.authType === 'auto' ? 'selected' : ''}>Авторизация: определить автоматически (OAuth)</option>
            <option value="bearer" ${f.authType === 'bearer' ? 'selected' : ''}>Авторизация: токен (Bearer)</option>
            <option value="none" ${f.authType === 'none' ? 'selected' : ''}>Без авторизации</option>
          </select>
          ${f.authType === 'bearer' ? `<input type="password" data-field="token" placeholder="Токен" value="${esc(f.token)}" aria-label="Токен">` : ''}
          ${f.authType === 'auto' ? `<details><summary class="hint">Свой client_id для OAuth (если сервер не поддерживает автоматическую регистрацию)</summary>
            <div style="display:grid;gap:6px;margin-top:6px"><input type="text" data-field="clientId" placeholder="client_id" value="${esc(f.clientId)}"><input type="password" data-field="clientSecret" placeholder="client_secret (необязательно)" value="${esc(f.clientSecret)}">
            <div class="hint">Адрес возврата для регистрации: <code>${esc(state.redirectUri)}</code></div></div></details>` : ''}
          <div class="actions"><button class="btn primary" data-act="add" ${ui.busy.has('add') ? 'disabled' : ''}>${ui.busy.has('add') ? 'Подключаю…' : 'Подключить'}</button></div>
        </div>` : ''}
        <button class="toggle-sec" data-act="toggle-local" aria-expanded="${ui.localOpen}">${ui.localOpen ? '−' : '+'} Локальная программа (stdio)</button>
        ${ui.localOpen ? `<div class="add">
          <div class="hint">${ui.host == null ? 'Локальные программы запускает помощник на Python 3. Он ставится один раз, без прав администратора.'
            : ui.host.ok ? `Помощник установлен (v${esc(ui.host.version)}, Python ${esc(ui.host.python)}).`
            : `Помощник не найден. Выполните один раз в терминале${isWindows() ? ' (cmd)' : ''}:`}
            ${ui.host?.ok === false ? '' : '<button class="btn small" data-act="host-check" style="margin-left:6px">Проверить помощник</button>'}</div>
          ${ui.host?.ok === false ? `<div style="display:flex;gap:6px;align-items:flex-start"><code style="flex:1;word-break:break-all">${esc(hostInstallCommand())}</code>
            <button class="btn small" data-act="copy-host-cmd">Скопировать</button></div>
          <div class="hint">Браузер из Flatpak после установки перезапустите.
            <button class="btn small" data-act="host-check" style="margin-left:6px">Проверить помощник</button></div>` : ''}
          <input type="text" data-field="l_name" placeholder="Название, например WordCraft" value="${esc(ui.local.name)}" aria-label="Название">
          <input type="text" data-field="l_command" placeholder="Команда, например wordcraft-cli" value="${esc(ui.local.command)}" aria-label="Команда">
          <input type="text" data-field="l_args" placeholder="Аргументы, например mcp" value="${esc(ui.local.args)}" aria-label="Аргументы">
          <details><summary class="hint">Переменные окружения и рабочая папка</summary>
            <div style="display:grid;gap:6px;margin-top:6px"><textarea data-field="l_env" rows="3" placeholder="КЛЮЧ=значение, по одной на строку" aria-label="Переменные окружения">${esc(ui.local.env)}</textarea>
            <input type="text" data-field="l_cwd" placeholder="Рабочая папка (необязательно)" value="${esc(ui.local.cwd)}" aria-label="Рабочая папка"></div></details>
          <div class="actions"><button class="btn primary" data-act="add-local" ${ui.busy.has('add-local') ? 'disabled' : ''}>${ui.busy.has('add-local') ? 'Запускаю…' : 'Подключить'}</button></div>
        </div>` : ''}
        <button class="toggle-sec" data-act="toggle-import" aria-expanded="${ui.importOpen}">${ui.importOpen ? '−' : '+'} Импорт конфига (Claude Desktop, Cursor)</button>
        ${ui.importOpen ? `<div class="add">
          <div class="hint">Вставьте JSON с разделом <code>mcpServers</code>: и программы (command/args), и адреса (url) добавятся разом.</div>
          <textarea data-field="importText" rows="6" class="mono" placeholder='{"mcpServers": {"wordcraft": {"command": "wordcraft-cli", "args": ["mcp"]}}}' aria-label="Конфиг">${esc(ui.importText)}</textarea>
          <div class="actions"><button class="btn primary" data-act="import" ${ui.busy.has('import') ? 'disabled' : ''}>${ui.busy.has('import') ? 'Импортирую…' : 'Импортировать'}</button></div>
        </div>` : ''}
      </div>
      <div class="ft"><span class="muted">${ctx.toolCount ? `Контекст: ${ctx.toolCount} инстр., ~${Math.round(ctx.text.length / 100) / 10}k символов${ctx.compact ? ' (сжатый)' : ''}` : 'Нет активных инструментов'}</span>
        <button class="btn small" data-act="insert-ctx" ${ctx.toolCount ? '' : 'disabled'} title="Добавить служебный контекст в начало поля ввода">В поле ввода</button></div>`;
    const body = panel.querySelector('.body');
    if (body) body.scrollTop = scroll;
    if (focusKey) panel.querySelector(`[data-field="${focusKey}"], [data-act="${focusKey}"]`)?.focus();
    positionPanel();
  }

  function onPanelInput(e) {
    const k = e.target.getAttribute('data-field');
    if (!k) return;
    if (k in ui.form) ui.form[k] = e.target.value;
    if (k.startsWith('l_')) ui.local[k.slice(2)] = e.target.value;
    if (k === 'importText') ui.importText = e.target.value;
  }

  function onPanelChange(e) {
    const el = e.target;
    if (el.getAttribute('data-field') === 'authType') { ui.form.authType = el.value; renderPanel(); return; }
    if (el.getAttribute('data-act') === 'tool') {
      const id = el.closest('.srv').dataset.id;
      const s = state.servers.find((x) => x.id === id);
      const dis = new Set(s.disabledTools || []);
      el.checked ? dis.delete(el.dataset.tool) : dis.add(el.dataset.tool);
      bg('updateServer', { id, patch: { disabledTools: [...dis] } }).catch((err) => flash(err.message, 'error'));
    }
  }

  function splitArgs(str) {
    const out = []; let cur = '', q = null, any = false;
    for (const ch of String(str || '')) {
      if (q) { if (ch === q) q = null; else cur += ch; }
      else if (ch === '"' || ch === "'") { q = ch; any = true; }
      else if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ''; any = false; }
      else cur += ch;
    }
    if (cur || any) out.push(cur);
    return out;
  }

  async function checkHost() {
    try { ui.host = await bg('hostStatus'); } catch (e) { ui.host = { ok: false, error: e.message }; }
    renderPanel();
  }

  const isWindows = () => /Windows/.test(navigator.userAgent);
  // Установщик из релиза той же версии, что и расширение: со встроенным помощником, без папки расширения.
  // У копии из магазина свой ID — передаём его, чтобы помощник пускал именно её.
  function hostInstallCommand() {
    const url = `https://github.com/VolkovIlia/gigamcp/releases/download/v${chrome.runtime.getManifest().version}/install-host.py`;
    const id = chrome.runtime.id === 'mmjnppnijhblimofghdejjdhfgdjgcol' ? '' : ` --extension-id ${chrome.runtime.id}`;
    return `curl -fsSL ${url} | ${isWindows() ? 'python' : 'python3'} -${id}`;
  }

  function authError(err) {
    // фон мог перезапуститься, пока пользователь входил: вход тогда завершится сам, а панель обновится
    if (/message port closed|Receiving end does not exist/i.test(err.message)) flash('Если вход в открытом окне завершён, сервер подключится автоматически.', 'info');
    else flash(`Вход не выполнен: ${err.message}`, 'error');
  }

  async function withBusy(key, fn) {
    ui.busy.add(key); renderPanel();
    try { return await fn(); } finally { ui.busy.delete(key); renderPanel(); }
  }

  async function onPanelClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b || b.getAttribute('data-act') === 'tool') return;
    const act = b.getAttribute('data-act');
    const id = b.closest('.srv')?.dataset.id;
    const s = id && state.servers.find((x) => x.id === id);
    const st = state.settings;
    try {
      switch (act) {
        case 'close': togglePanel(false); break;
        case 'toggle-enabled': await bg('saveSettings', { patch: { enabled: !st.enabled } }); break;
        case 'toggle-auto': await bg('saveSettings', { patch: { autoRun: !st.autoRun } }); break;
        case 'toggle-send': await bg('saveSettings', { patch: { autoSend: !st.autoSend } }); break;
        case 'toggle-add': ui.addOpen = !ui.addOpen; renderPanel(); break;
        case 'toggle-local': ui.localOpen = !ui.localOpen; if (ui.localOpen && !ui.host) checkHost(); renderPanel(); break;
        case 'toggle-import': ui.importOpen = !ui.importOpen; renderPanel(); break;
        case 'host-check': await checkHost(); break;
        case 'copy-host-cmd':
          await navigator.clipboard.writeText(hostInstallCommand());
          flash('Команда скопирована — вставьте её в терминал', 'ok');
          break;
        case 'expand': ui.expanded.has(id) ? ui.expanded.delete(id) : ui.expanded.add(id); renderPanel(); break;
        case 'toggle-server': await bg('updateServer', { id, patch: { enabled: !s.enabled } }); break;
        case 'refresh': await withBusy(id, async () => { const r = await bg('refreshServer', { id }); flash(r.ok ? `«${s.name}»: список инструментов обновлён` : r.error, r.ok ? 'ok' : 'error'); }); break;
        case 'auth': await withBusy(id, async () => {
          flash('Открыл окно входа. Завершите вход там — сервер подключится сам.', 'info');
          try { await bg('authorize', { id }); flash(`«${s.name}»: вход выполнен`, 'ok'); }
          catch (err) { authError(err); }
        }); break;
        case 'logout': await bg('logout', { id }); break;
        case 'remove': if (confirm(`Удалить сервер «${s.name}»?`)) { await bg('removeServer', { id }); ui.expanded.delete(id); } break;
        case 'all-on': await bg('updateServer', { id, patch: { disabledTools: [] } }); break;
        case 'all-off': await bg('updateServer', { id, patch: { disabledTools: (s.tools || []).map((t) => t.name) } }); break;
        case 'set-token': {
          const v = b.parentElement.querySelector('[data-field="newToken"]').value.trim();
          if (v) { await bg('updateServer', { id, patch: { token: v } }); await bg('refreshServer', { id }); flash('Токен сохранён', 'ok'); }
          break;
        }
        case 'add': {
          const f = ui.form;
          if (!f.url.trim()) { flash('Укажите адрес сервера', 'error'); break; }
          await withBusy('add', async () => {
            const r = await bg('addServer', { name: f.name.trim(), url: f.url.trim(), authType: f.authType, token: f.authType === 'bearer' ? f.token.trim() : '', clientId: f.clientId.trim(), clientSecret: f.clientSecret.trim() });
            ui.form = { name: '', url: '', authType: 'auto', token: '', clientId: '', clientSecret: '' };
            ui.addOpen = false;
            if (r.needsAuth) {
              flash('Сервер требует вход — открыл окно авторизации. Завершите вход там.', 'info');
              ui.busy.add(r.id);
              try { await bg('authorize', { id: r.id }); flash('Сервер подключён', 'ok'); }
              catch (err) { authError(err); }
              finally { ui.busy.delete(r.id); }
            } else if (r.error) { ui.expanded.add(r.id); flash(r.error, 'error'); }
            else flash('Сервер подключён', 'ok');
          });
          break;
        }
        case 'add-local': {
          const l = ui.local;
          if (!l.command.trim()) { flash('Укажите команду', 'error'); break; }
          await withBusy('add-local', async () => {
            const env = {};
            for (const line of l.env.split('\n')) { const i = line.indexOf('='); if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
            const r = await bg('addServer', { name: l.name.trim(), transport: 'stdio', command: l.command.trim(), args: splitArgs(l.args), env, cwd: l.cwd.trim() });
            if (r.error) { ui.expanded.add(r.id); flash(r.error, 'error'); if (/помощник/i.test(r.error)) ui.host = { ok: false }; }
            else { ui.local = { name: '', command: '', args: '', env: '', cwd: '' }; ui.localOpen = false; flash('Программа подключена', 'ok'); }
          });
          break;
        }
        case 'import': await withBusy('import', async () => {
          const r = await bg('importConfig', { text: ui.importText });
          const parts = [];
          if (r.added.length) parts.push(`добавлено: ${r.added.join(', ')}`);
          if (r.skipped.length) parts.push(`пропущено: ${r.skipped.join(', ')}`);
          if (r.failed.length) parts.push(`ошибки: ${r.failed.join('; ')}`);
          flash(parts.join(' · ') || 'В конфиге нет серверов', r.failed.length ? 'error' : 'ok');
          if (r.added.length) { ui.importOpen = false; ui.importText = ''; }
        }); break;
        case 'insert-ctx': {
          const ctx = currentContext();
          const ta = getInput();
          const cur = ta?.value || '';
          if (cur.includes(P.CTX_OPEN)) { flash('Контекст уже в поле ввода', 'info'); break; }
          setInputValue(`${ctx.text}\n\nЗапрос пользователя:\n${cur}`);
          togglePanel(false); ta?.focus();
          break;
        }
      }
    } catch (err) {
      flash(err.needClientId ? `${err.message}` : err.message, 'error');
    }
  }

  // ---------- карточка вызова в ответе ----------

  function attachCard(entry) {
    if (!entry.card) {
      const host = document.createElement('div');
      host.setAttribute('data-gmcp', 'card');
      host.style.cssText = 'display:block;margin:8px 0;';
      styleHost(host);
      const sr = host.attachShadow({ mode: 'open' });
      sr.innerHTML = `<style>${BASE_CSS}
        .card { border: 1px solid var(--line); border-radius: 14px; background: var(--bg2); overflow: hidden; max-width: 760px; }
        .hd { display: flex; align-items: center; gap: 8px; padding: 9px 12px; }
        .hd .ttl { flex: 1; font-weight: 600; font-size: 13px; display: flex; gap: 6px; align-items: center; }
        .hd .ttl span { color: var(--acc); }
        .call { border-top: 1px solid var(--line); padding: 8px 12px; display: grid; gap: 6px; }
        .ch { display: flex; align-items: center; gap: 8px; }
        .ch .nm { font-weight: 500; overflow-wrap: anywhere; }
        .ch .pv { flex: 1; min-width: 0; color: var(--fg2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .st { font-size: 11.5px; padding: 2px 8px; border-radius: 8px; background: var(--bg3); white-space: nowrap; }
        .st.running { color: var(--run); } .st.done { color: var(--acc); } .st.error { color: var(--err); }
        details summary { cursor: pointer; color: var(--fg2); font-size: 12px; }
        pre { margin: 6px 0 0; padding: 8px 10px; border-radius: 10px; background: var(--bg3); white-space: pre-wrap; word-break: break-word; max-height: 260px; overflow: auto; font: 12px/1.45 ui-monospace, Menlo, Consolas, monospace; }
        .ft { border-top: 1px solid var(--line); padding: 8px 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
        .ft .note { flex: 1; font-size: 12px; color: var(--fg2); min-width: 160px; }
        .ft .note.warn { color: var(--warn); }
      </style><div class="t"><div class="card" role="group" aria-label="Вызов инструментов MCP"></div></div>`;
      sr.querySelector('.card').addEventListener('click', (e) => onCardClick(entry, e));
      entry.card = host;
    }
    const host = entry.card;
    const box = entry.el.querySelector(SEL.assistantContent) || entry.el;
    if (host.parentElement !== box) box.appendChild(host);
    renderCard(entry);
  }

  const ST_LABEL = { pending: 'ожидает', running: 'выполняется…', done: 'готово', error: 'ошибка' };

  function renderCard(entry) {
    const sr = entry.card?.shadowRoot;
    if (!sr) return;
    sr.querySelector('.t').classList.toggle('light', isLightPage());
    const card = sr.querySelector('.card');
    const n = entry.calls.length;
    const hist = entry.status === 'history' || entry.status === 'done-before';
    let h = `<div class="hd"><div class="ttl"><span>${ICON.tool}</span>MCP · ${n === 1 ? 'вызов инструмента' : `${n} вызова инструментов`}</div>`;
    if (hist) h += `<span class="st">${entry.status === 'done-before' ? 'выполнено ранее' : 'из истории'}</span>`;
    h += `</div>`;
    for (const c of entry.calls) {
      const args = JSON.stringify(c.arguments || {}, null, 2);
      const pv = JSON.stringify(c.arguments || {});
      h += `<div class="call"><div class="ch"><span class="nm mono">${esc(c.resolved || c.name)}</span><span class="pv mono">${pv === '{}' ? '' : esc(pv.length > 90 ? pv.slice(0, 89) + '…' : pv)}</span>${hist && c.status === 'pending' ? '' : `<span class="st ${c.status}">${ST_LABEL[c.status]}${c.result?.ms ? ` · ${(c.result.ms / 1000).toFixed(1)} с` : ''}</span>`}</div>
        <details><summary>Аргументы</summary><pre>${esc(args)}</pre></details>
        ${c.result ? `<details ${c.status === 'error' ? 'open' : ''}><summary>Результат${c.result.text ? ` · ${c.result.text.length} симв.` : ''}</summary><pre>${esc((c.result.text || '').slice(0, 6000))}${(c.result.text || '').length > 6000 ? '\n…' : ''}</pre></details>` : ''}
      </div>`;
    }
    const foot = [];
    if (entry.status === 'pending') {
      foot.push(`<span class="note ${entry.note ? 'warn' : ''}">${esc(entry.note || 'ГигаЧат хочет вызвать инструмент. Выполнить?')}</span>`);
      foot.push(`<button class="btn primary" data-act="run">Выполнить</button><button class="btn" data-act="deny">Отклонить</button><button class="btn small" data-act="always" title="Включить авто-выполнение для всех вызовов">Всегда разрешать</button>`);
    } else if (entry.status === 'running') {
      foot.push(`<span class="note">Выполняю…</span>`);
    } else if (entry.status === 'done') {
      foot.push(`<span class="note ${entry.note ? 'warn' : ''}">${esc(entry.note || (entry.sent ? 'Результат отправлен в чат.' : 'Готово.'))}</span>`);
      if (!entry.sent) foot.push(`<button class="btn primary" data-act="send">Отправить результат</button>`);
    } else if (entry.status === 'denied') {
      foot.push(`<span class="note">Вызов отклонён.</span>`);
    } else if (hist) {
      foot.push(`<span class="note"></span><button class="btn small" data-act="run">Выполнить снова</button>`);
    }
    if (foot.length) h += `<div class="ft">${foot.join('')}</div>`;
    card.innerHTML = h;
  }

  async function onCardClick(entry, e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const act = b.getAttribute('data-act');
    if (act === 'run') {
      if (entry.status !== 'pending') { entry.calls.forEach((c) => { c.status = 'pending'; c.result = null; }); entry.sent = false; }
      lastSendAt = Date.now(); autoRounds = 0;
      runEntry(entry);
    } else if (act === 'always') {
      await bg('saveSettings', { patch: { autoRun: true } }).catch(() => {});
      state.settings.autoRun = true;
      lastSendAt = Date.now(); autoRounds = 0;
      runEntry(entry, { auto: true });
    } else if (act === 'deny') {
      entry.status = 'denied'; markDone(entry.key); renderCard(entry);
      const msg = P.formatResults(entry.calls.map((c) => ({ name: c.name, ok: false, text: 'Пользователь отклонил вызов. Не повторяй его без просьбы; ответь без этого инструмента или спроси, как поступить.' })), { maxChars: 2000 });
      if (state.settings.autoSend) sendToChat(msg).catch(() => {}); else setInputValue(msg);
    } else if (act === 'send') {
      entry.sent = true; entry.note = null; renderCard(entry);
      sendToChat(entry.resultText).catch((err) => { entry.sent = false; entry.note = err.message; renderCard(entry); });
    }
  }

  // ---------- сворачиваем служебные сообщения пользователя ----------

  function ensureGlobalStyle() {
    if (document.getElementById('gmcp-style')) return;
    const st = document.createElement('style');
    st.id = 'gmcp-style';
    st.textContent = `
      [data-gmcp-collapsed="1"] { max-height: 4.2em !important; overflow: hidden !important; position: relative !important; -webkit-mask-image: linear-gradient(#000 45%, transparent); mask-image: linear-gradient(#000 45%, transparent); }
      .gmcp-tag { display: inline-flex; align-items: center; gap: 6px; margin: 2px 0 6px; padding: 2px 10px; border-radius: 10px; font: 500 12px/1.6 inherit; background: rgba(33,160,56,.18); color: #80F67C; cursor: pointer; border: 0; }
    `;
    document.head.appendChild(st);
  }

  function collapseService(msgs) {
    ensureGlobalStyle();
    for (const m of msgs) {
      if (m.role !== 'user') continue;
      if (m.el.querySelector(':scope > .gmcp-tag') || m.el.dataset.gmcpTagged) continue;
      const t = m.el.innerText || '';
      const isCtx = t.includes(P.CTX_OPEN), isRes = t.includes(P.RES_OPEN), isNudge = t.includes(P.NUDGE_OPEN);
      if (!isCtx && !isRes && !isNudge) continue;
      // сворачиваем самый глубокий элемент, который содержит весь текст сообщения
      let target = m.el.querySelector(SEL.userBubble) || m.el;
      while (target.children.length === 1 && (target.firstElementChild.innerText || '').length >= t.length * 0.9) target = target.firstElementChild;
      const tag = document.createElement('button');
      tag.type = 'button';
      tag.className = 'gmcp-tag';
      tag.setAttribute('data-gmcp', 'tag');
      const label = isCtx ? 'MCP: служебный контекст инструментов' : isRes ? 'MCP: результат инструментов' : 'MCP: напоминание про инструменты';
      tag.textContent = `${label} · показать`;
      tag.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const c = target.getAttribute('data-gmcp-collapsed') === '1';
        target.setAttribute('data-gmcp-collapsed', c ? '0' : '1');
        tag.textContent = `${label} · ${c ? 'скрыть' : 'показать'}`;
      });
      target.setAttribute('data-gmcp-collapsed', '1');
      target.parentElement.insertBefore(tag, target);
      m.el.dataset.gmcpTagged = '1';
    }
  }

  // ---------- запуск ----------

  const mo = new MutationObserver((muts) => {
    if (muts.every((m) => isOurs(m.target))) return;
    scheduleScan();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) { lastPath = location.pathname; autoRounds = 0; scheduleScan(400); }
  }, 700);

  refreshState().then(() => scheduleScan(600));

  // для отладки из консоли расширения
  window.__gmcp = { scan, getMessages, extractCalls, state: () => state, entries, currentContext, SEL };
})();

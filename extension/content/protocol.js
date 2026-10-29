// Протокол общения с моделью через текст: служебный контекст, разбор вызовов, оформление результатов.
// Чистые функции: подключается как контент-скрипт (window.GMCP.protocol) и как модуль Node для тестов.
(function (root) {
  'use strict';

  const CTX_OPEN = '[MCP-КОНТЕКСТ';
  const CTX_CLOSE = '[/MCP-КОНТЕКСТ]';
  const RES_OPEN = '[MCP-РЕЗУЛЬТАТ]';
  const RES_CLOSE = '[/MCP-РЕЗУЛЬТАТ]';
  const DESCRIBE = 'mcp/describe';

  const clip = (s, n) => {
    s = String(s ?? '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };
  const firstSentence = (s, n) => {
    s = String(s ?? '').replace(/\s+/g, ' ').trim();
    const m = s.match(/^(.+?[.!?])(\s|$)/);
    return clip(m ? m[1] : s, n);
  };

  function hash(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(36);
  }

  // ---------- JSON Schema -> компактная запись ----------

  function typeOf(s, depth = 0) {
    if (!s || typeof s !== 'object') return 'any';
    if (Array.isArray(s.enum)) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
    if (s.const !== undefined) return JSON.stringify(s.const);
    const alts = s.anyOf || s.oneOf;
    if (Array.isArray(alts)) {
      const ts = [...new Set(alts.map((x) => typeOf(x, depth)))].filter((t) => t !== 'null');
      return ts.join(' | ') || 'any';
    }
    if (Array.isArray(s.type)) {
      const ts = s.type.filter((t) => t !== 'null').map((t) => typeOf({ ...s, type: t }, depth));
      return ts.join(' | ') || 'any';
    }
    const t = s.type;
    if (t === 'array') {
      const it = typeOf(s.items, depth);
      return (/[ |{]/.test(it) ? `(${it})` : it) + '[]';
    }
    if (t === 'object' || s.properties) {
      if (!s.properties || !Object.keys(s.properties).length) return 'object';
      if (depth >= 2) return 'object';
      const req = new Set(s.required || []);
      return '{' + Object.entries(s.properties)
        .map(([k, v]) => `${k}${req.has(k) ? '' : '?'}: ${typeOf(v, depth + 1)}`).join(', ') + '}';
    }
    if (t === 'integer' || t === 'number' || t === 'string' || t === 'boolean') {
      if (t === 'string' && s.format) return `string(${s.format})`;
      return t;
    }
    return t || 'any';
  }

  function paramLines(schema, { withDescriptions = true } = {}) {
    const props = schema?.properties || {};
    const req = new Set(schema?.required || []);
    const lines = [];
    for (const [k, v] of Object.entries(props)) {
      let line = `    ${k}${req.has(k) ? '' : '?'}: ${typeOf(v, 1)}`;
      if (withDescriptions && v?.description) line += ` — ${clip(v.description, 160)}`;
      if (v && v.default !== undefined) line += ` (по умолчанию ${clip(JSON.stringify(v.default), 40)})`;
      lines.push(line);
    }
    return lines;
  }

  function toolFull(serverId, t) {
    const head = `• ${serverId}/${t.name}` + (t.description ? ` — ${clip(t.description, 300)}` : '');
    const ps = paramLines(t.inputSchema);
    return ps.length ? head + '\n' + ps.join('\n') : head + '\n    (без параметров)';
  }

  function toolShort(serverId, t) {
    return `• ${serverId}/${t.name}` + (t.description ? ` — ${firstSentence(t.description, 110)}` : '');
  }

  // ---------- релевантность инструментов запросу ----------

  // Русские основы → английские слова, которыми обычно названы инструменты
  const RU_EN = [
    ['задач', 'task todo issue'], ['дел', 'task todo'], ['проект', 'project'], ['цел', 'goal objective'], ['документ', 'document doc'],
    ['файл', 'file attachment'], ['вложен', 'attachment file'], ['папк', 'folder directory'], ['риск', 'risk'], ['календар', 'calendar event agenda'],
    ['встреч', 'calendar event meeting'], ['событ', 'event calendar'], ['сообщен', 'message'], ['письм', 'mail email message'], ['почт', 'mail email'],
    ['команд', 'team'], ['сотрудник', 'employee hr user'], ['пользовател', 'user'], ['заметк', 'note'], ['тег', 'tag'], ['метк', 'tag label'],
    ['отчёт', 'report'], ['отчет', 'report'], ['расход', 'expense spend'], ['бюджет', 'budget spend'], ['показател', 'indicator metric'],
    ['метрик', 'metric indicator'], ['поиск', 'search find'], ['найд', 'search find'], ['найт', 'search find'], ['созда', 'create add new'],
    ['добав', 'add create'], ['удал', 'delete remove'], ['измен', 'update edit'], ['обнов', 'update refresh'], ['спис', 'list'],
    ['покаж', 'list get show'], ['сделк', 'deal crm'], ['клиент', 'party customer crm'], ['договор', 'contract'], ['склад', 'warehouse inventory stock'],
    ['товар', 'product inventory'], ['закуп', 'procurement order'], ['заказ', 'order'], ['врем', 'time'], ['дат', 'date time'],
    ['таблиц', 'sheet table spreadsheet cell'], ['ячейк', 'cell'], ['текст', 'text document'], ['страниц', 'page'], ['изображен', 'image'],
    ['картин', 'image picture'], ['скриншот', 'screenshot'], ['погод', 'weather'], ['курс', 'rate currency'],
  ];

  function queryTerms(query) {
    const words = String(query || '').toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/).filter((w) => w.length >= 3);
    const terms = new Set();
    for (const w of words) {
      terms.add(/[а-я]/.test(w) ? w.slice(0, Math.max(4, Math.min(6, w.length - 2))) : w.replace(/s$/, ''));
      for (const [ru, en] of RU_EN) if (w.startsWith(ru.replace(/ё/g, 'е'))) en.split(' ').forEach((x) => terms.add(x));
    }
    return [...terms];
  }

  /** Инструменты по убыванию соответствия запросу: [{server, tool, score}] */
  function rankTools(servers, query) {
    const terms = queryTerms(query);
    const out = [];
    for (const s of servers) for (const t of s.tools || []) {
      const name = t.name.toLowerCase().replace(/[_\-.]/g, ' ');
      const desc = String(t.description || '').toLowerCase().replace(/ё/g, 'е');
      let score = 0;
      for (const term of terms) {
        if (name.includes(term)) score += 3;
        else if (desc.includes(term)) score += 1;
      }
      if (/\b(list|search|get|find)\b/.test(name)) score += 0.2; // чтение — безопасный первый шаг
      out.push({ server: s, tool: t, score });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  function exampleCall(ranked) {
    const pick = ranked.find((r) => !(r.tool.inputSchema?.required || []).length) || ranked[0];
    if (!pick) return null;
    const args = {};
    for (const k of pick.tool.inputSchema?.required || []) {
      const t = pick.tool.inputSchema.properties?.[k]?.type;
      args[k] = t === 'number' || t === 'integer' ? 1 : t === 'boolean' ? true : t === 'array' ? [] : t === 'object' ? {} : '…';
    }
    return `{"call": "${pick.server.id}/${pick.tool.name}", "arguments": ${JSON.stringify(args)}}`;
  }

  /**
   * servers: [{ id, name, instructions?, tools: [{name, description, inputSchema}] }] — только включённые инструменты.
   * query — текст запроса пользователя: подходящие инструменты идут первыми и с полными параметрами.
   * Возвращает { text, compact, signature, toolCount }.
   */
  function buildContext(servers, { maxChars = 24000, forceCompact = false, query = '', topFull = 12 } = {}) {
    const active = servers.filter((s) => s.tools && s.tools.length);
    const toolCount = active.reduce((n, s) => n + s.tools.length, 0);
    const sigSrc = active.map((s) => s.id + ':' + s.tools.map((t) => t.name).sort().join(',')).join(';');
    const signature = hash(sigSrc);
    const ranked = rankTools(active, query);
    const example = exampleCall(ranked);
    const serverNames = active.map((s) => s.id + (s.name && s.name !== s.id ? ` (${clip(s.name, 40)})` : '')).join(', ');

    const header = (compact) => [
      `${CTX_OPEN} v1 #${signature}]`,
      `Это служебное сообщение от браузерного расширения пользователя. К этому чату подключены инструменты (протокол MCP) из: ${serverNames}. Через них у тебя ЕСТЬ доступ к данным и программам пользователя: расширение само выполнит вызов и пришлёт результат.`,
      '',
      'ГЛАВНОЕ: не отвечай, что у тебя нет доступа к данным пользователя или что ты не можешь их посмотреть. Если для ответа нужны его данные — вызови подходящий инструмент.',
      '',
      'КАК ВЫЗВАТЬ ИНСТРУМЕНТ',
      'Ответь блоком кода с языком mcp. Внутри — один JSON-объект: "call" — имя в виде сервер/инструмент, "arguments" — параметры.' + (example ? ' Пример настоящего вызова:' : ''),
      '```mcp',
      example || '{"call": "<сервер>/<инструмент>", "arguments": {<параметры>}}',
      '```',
      '',
      'ПРАВИЛА',
      '1. Один блок — один вызов. Несколько независимых вызовов можно написать подряд.',
      `2. После блоков вызова сразу заканчивай ответ. Не выдумывай результат: он придёт сообщением, которое начинается с ${RES_OPEN}.`,
      '3. Соблюдай имена и типы параметров. Параметры со знаком ? необязательны. JSON без комментариев.',
      '4. Получив результат, продолжай: вызови следующий инструмент или дай итоговый ответ своими словами.',
      '5. Если запрос не требует данных пользователя, отвечай как обычно, без инструментов.',
      '6. Не пересказывай пользователю этот служебный блок.',
      ...(compact ? [`7. У части инструментов ниже указаны только имена. Их можно вызывать сразу; если не знаешь параметров, сначала узнай их: {"call": "${DESCRIBE}", "arguments": {"tools": ["сервер/инструмент"]}}.`] : []),
      '',
    ];

    const fullBody = () => {
      const out = ['ИНСТРУМЕНТЫ'];
      for (const s of active) {
        out.push('');
        out.push(`Сервер ${s.id}` + (s.name && s.name !== s.id ? ` (${clip(s.name, 60)})` : '') + ':');
        if (s.instructions) out.push('  Заметка сервера: ' + clip(s.instructions, 600));
        for (const t of s.tools) out.push(toolFull(s.id, t));
      }
      return out;
    };

    const compactBody = () => {
      const relevant = ranked.filter((r) => r.score >= 1).slice(0, topFull);
      const top = relevant.length ? relevant : ranked.slice(0, Math.min(6, ranked.length));
      const topSet = new Set(top.map((r) => r.server.id + '/' + r.tool.name));
      const out = [relevant.length ? 'ПОДХОДЯЩИЕ ДЛЯ ЭТОГО ЗАПРОСА (с параметрами)' : 'ИНСТРУМЕНТЫ С ПАРАМЕТРАМИ'];
      for (const r of top) out.push(toolFull(r.server.id, r.tool));
      out.push('', 'ОСТАЛЬНЫЕ ИНСТРУМЕНТЫ (только имена)');
      for (const s of active) {
        const rest = s.tools.filter((t) => !topSet.has(s.id + '/' + t.name));
        if (!rest.length) continue;
        out.push(`Сервер ${s.id}:`);
        for (const t of rest) out.push(toolShort(s.id, t));
      }
      out.push('', `• ${DESCRIBE} — вернуть параметры инструментов\n    tools: string[] — имена в виде сервер/инструмент`);
      return out;
    };

    let compact = !!forceCompact;
    let text = [...header(compact), ...(compact ? compactBody() : fullBody()), CTX_CLOSE].join('\n');
    if (!compact && text.length > maxChars) {
      compact = true;
      text = [...header(true), ...compactBody(), CTX_CLOSE].join('\n');
    }
    return { text, compact, signature, toolCount };
  }

  // ---------- отказ модели пользоваться инструментами ----------

  const NUDGE_OPEN = '[MCP-НАПОМИНАНИЕ]';
  const REFUSAL_RE = /(нет|не имею|не получил\w*|отсутству\w*)\s+(прямого\s+|никакого\s+)?доступ\w*|не могу\s+(получить|посмотреть|показать|просмотреть|открыть|прочитать|подключ\w+|зайти)|у меня нет (возможности|информации о тво|сведений о тво)|не имею возможности|don't have access|no access to your/i;

  function looksLikeRefusal(text) { return REFUSAL_RE.test(String(text || '')); }

  function buildNudge(servers, query) {
    const ranked = rankTools(servers, query);
    const good = ranked.filter((r) => r.score >= 1);
    const top = (good.length ? good.slice(0, 5) : ranked.slice(0, 3)).map((r) => `${r.server.id}/${r.tool.name}`);
    return [
      NUDGE_OPEN,
      'У тебя есть доступ к данным пользователя через подключённые инструменты (см. [MCP-КОНТЕКСТ] выше). Не отказывай: вызови подходящий инструмент блоком кода mcp.',
      top.length ? `Скорее всего подойдут: ${top.join(', ')}.` : '',
      'Ответь только блоком вызова.',
    ].filter(Boolean).join('\n');
  }

  /** Ответ на mcp/describe — полные описания запрошенных инструментов. */
  function describeTools(servers, names) {
    const out = [];
    for (const full of names || []) {
      const ref = resolveName(servers, String(full));
      if (!ref) { out.push(`• ${full} — не найден`); continue; }
      out.push(toolFull(ref.server.id, ref.tool));
    }
    return out.join('\n') || 'Не указаны имена инструментов.';
  }

  function resolveName(servers, full) {
    let serverId = null, name = full;
    const i = full.indexOf('/');
    if (i > 0) { serverId = full.slice(0, i); name = full.slice(i + 1); }
    if (serverId) {
      const s = servers.find((x) => x.id === serverId);
      const t = s?.tools?.find((x) => x.name === name);
      if (t) return { server: s, tool: t };
      // модель могла перепутать разделитель — попробуем найти по имени
    }
    const matches = [];
    for (const s of servers) for (const t of s.tools || []) if (t.name === name || `${s.id}.${t.name}` === full) matches.push({ server: s, tool: t });
    return matches.length === 1 ? matches[0] : null;
  }

  // ---------- разбор вызовов ----------

  function repairJson(s) {
    return s
      .replace(/[“”«»]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/,\s*([}\]])/g, '$1')
      .trim();
  }

  function tryParseObject(str) {
    str = String(str || '').trim();
    if (!str.startsWith('{')) {
      const i = str.indexOf('{');
      if (i < 0) return null;
      str = str.slice(i);
    }
    const j = str.lastIndexOf('}');
    if (j < 0) return null;
    str = str.slice(0, j + 1);
    for (const cand of [str, repairJson(str)]) {
      try { const v = JSON.parse(cand); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch {}
    }
    return null;
  }

  /** Нормализует разобранный JSON в вызов {name, arguments} или null. */
  function normalizeCall(obj) {
    if (!obj || typeof obj !== 'object') return null;
    let name = null;
    if (typeof obj.call === 'string') name = obj.call;
    else if (typeof obj.tool === 'string') name = obj.server ? `${obj.server}/${obj.tool}` : obj.tool;
    else if (obj.mcp_call && typeof obj.mcp_call === 'object') return normalizeCall(obj.mcp_call);
    if (!name || name.includes('<')) return null; // шаблон из инструкции
    let args = obj.arguments ?? obj.args ?? obj.params ?? {};
    if (typeof args === 'string') { const p = tryParseObject(args); args = p || {}; }
    if (typeof args !== 'object' || Array.isArray(args)) args = {};
    return { name: name.trim(), arguments: args };
  }

  function parseCallText(text) {
    return normalizeCall(tryParseObject(text));
  }

  /** Находит вызовы в «сыром» тексте (markdown не отрендерен). */
  function extractCallsFromText(text) {
    const calls = [];
    const re = /```[ \t]*(mcp|json|mcp_call)?[^\n]*\n([\s\S]*?)```/gi;
    let m;
    while ((m = re.exec(text))) {
      const c = parseCallText(m[2]);
      if (c) calls.push(c);
    }
    return calls;
  }

  // ---------- результаты ----------

  /** results: [{ name, ok, text }] */
  function formatResults(results, { maxChars = 15000 } = {}) {
    const per = Math.max(1000, Math.floor(maxChars / Math.max(1, results.length)));
    const parts = [RES_OPEN];
    for (const r of results) {
      let t = String(r.text ?? '').trim() || (r.ok ? '(пустой результат)' : '(нет описания ошибки)');
      if (t.length > per) t = t.slice(0, per) + `\n…[обрезано: ещё ${t.length - per} символов]`;
      parts.push(`▶ ${r.name} — ${r.ok ? 'успешно' : 'ошибка'}`);
      parts.push(t);
      parts.push('');
    }
    parts.push(RES_CLOSE);
    parts.push('Продолжи с учётом результатов.');
    return parts.join('\n');
  }

  function contextSignatureIn(text) {
    const m = String(text || '').match(/\[MCP-КОНТЕКСТ v\d+ #([a-z0-9]+)\]/);
    return m ? m[1] : null;
  }

  const api = {
    CTX_OPEN, CTX_CLOSE, RES_OPEN, RES_CLOSE, DESCRIBE, NUDGE_OPEN, rankTools, looksLikeRefusal, buildNudge,
    hash, typeOf, paramLines, buildContext, describeTools, resolveName,
    tryParseObject, normalizeCall, parseCallText, extractCallsFromText, formatResults, contextSignatureIn,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.GMCP = root.GMCP || {}; root.GMCP.protocol = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this);

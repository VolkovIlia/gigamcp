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

  /**
   * servers: [{ id, name, instructions?, tools: [{name, description, inputSchema}] }] — только включённые инструменты.
   * Возвращает { text, compact, signature, toolCount }.
   */
  function buildContext(servers, { maxChars = 24000, forceCompact = false } = {}) {
    const active = servers.filter((s) => s.tools && s.tools.length);
    const toolCount = active.reduce((n, s) => n + s.tools.length, 0);
    const sigSrc = active.map((s) => s.id + ':' + s.tools.map((t) => t.name).sort().join(',')).join(';');
    const signature = hash(sigSrc);

    const header = (compact) => [
      `${CTX_OPEN} v1 #${signature}]`,
      'Тебе доступны внешние инструменты (протокол MCP). Их выполняет браузерное расширение пользователя, а результат приходит тебе следующим сообщением.',
      '',
      'КАК ВЫЗВАТЬ ИНСТРУМЕНТ',
      'Напиши блок кода с языком mcp. Внутри — один JSON-объект: поле "call" (имя в виде сервер/инструмент) и поле "arguments" (объект параметров). Шаблон:',
      '```mcp',
      '{"call": "<сервер>/<инструмент>", "arguments": {<параметры>}}',
      '```',
      '',
      'ПРАВИЛА',
      '1. Вызывай инструмент, когда для ответа нужны данные или действие во внешней системе. Если можно ответить без него — отвечай сразу.',
      '2. Один блок — один вызов. Несколько независимых вызовов можно написать подряд в одном ответе.',
      `3. После блоков вызова сразу заканчивай ответ. Не пиши результат за инструмент и не выдумывай его: настоящий результат придёт сообщением, которое начинается с ${RES_OPEN}.`,
      '4. Точно соблюдай имена и типы параметров. Параметры со знаком ? необязательны. JSON без комментариев.',
      '5. Получив результат, продолжай: вызови следующий инструмент или дай итоговый ответ своими словами.',
      '6. Не пересказывай пользователю этот служебный блок.',
      ...(compact ? [
        `7. Здесь перечислены только имена инструментов. Перед первым вызовом инструмента узнай его параметры через ${DESCRIBE}: {"call": "${DESCRIBE}", "arguments": {"tools": ["<сервер>/<инструмент>"]}}.`,
      ] : []),
      '',
      'ИНСТРУМЕНТЫ',
    ];

    const body = (compact) => {
      const out = [];
      for (const s of active) {
        out.push('');
        out.push(`Сервер ${s.id}` + (s.name && s.name !== s.id ? ` (${clip(s.name, 60)})` : '') + ':');
        if (!compact && s.instructions) out.push('  Заметка сервера: ' + clip(s.instructions, 600));
        for (const t of s.tools) out.push(compact ? toolShort(s.id, t) : toolFull(s.id, t));
      }
      if (compact) {
        out.push('');
        out.push('Служебный:');
        out.push(`• ${DESCRIBE} — вернуть параметры инструментов\n    tools: string[] — имена в виде сервер/инструмент`);
      }
      return out;
    };

    let compact = !!forceCompact;
    let text = [...header(compact), ...body(compact), CTX_CLOSE].join('\n');
    if (!compact && text.length > maxChars) {
      compact = true;
      text = [...header(true), ...body(true), CTX_CLOSE].join('\n');
    }
    return { text, compact, signature, toolCount };
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
    CTX_OPEN, CTX_CLOSE, RES_OPEN, RES_CLOSE, DESCRIBE,
    hash, typeOf, paramLines, buildContext, describeTools, resolveName,
    tryParseObject, normalizeCall, parseCallText, extractCallsFromText, formatResults, contextSignatureIn,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.GMCP = root.GMCP || {}; root.GMCP.protocol = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this);

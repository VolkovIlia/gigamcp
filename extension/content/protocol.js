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
    ['сегодн', 'today agenda'], ['завтр', 'tomorrow agenda'], ['недел', 'week agenda'], ['план', 'plan agenda'],
    ['слайд', 'slide'], ['презентац', 'presentation deck slide'], ['абзац', 'paragraph text'], ['диаграм', 'chart'], ['график', 'chart'],
    ['посмотр', 'inspect get show view read'], ['прочит', 'read get inspect'], ['провер', 'inspect check get'], ['сохран', 'save'],
    ['откр', 'open'], ['экспорт', 'export'], ['печат', 'print export'],
  ];

  const STOP = new Set(['мои', 'мой', 'моя', 'мне', 'меня', 'это', 'как', 'что', 'для', 'все', 'всё', 'ещё', 'еще', 'так', 'дай', 'ну', 'the', 'and', 'for']);

  function queryTerms(query) {
    const words = String(query || '').toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w));
    const terms = new Set();
    for (const w of words) {
      terms.add(/[а-я]/.test(w) ? w.slice(0, Math.max(4, Math.min(6, w.length - 2))) : w.replace(/s$/, ''));
      for (const [ru, en] of RU_EN) if (w.startsWith(ru.replace(/ё/g, 'е'))) en.split(' ').forEach((x) => terms.add(x));
    }
    return [...terms];
  }

  // слова имени/описания: tasks_list → [task, list]; «taska» остаётся «taska» и не совпадает с «task»
  const words = (s) => String(s || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/).filter(Boolean);
  const singular = (w) => (/[a-z]/.test(w) ? w.replace(/(ies)$/, 'y').replace(/(sses|xes|ches|shes)$/, (m) => m.slice(0, -2)).replace(/([^s])s$/, '$1') : w);
  const termHits = (term, ws) => ws.some((w) => (/[а-я]/.test(term) ? w.startsWith(term) : singular(w) === term));

  /** Инструменты по убыванию соответствия запросу: [{server, tool, score}] */
  function rankTools(servers, query) {
    const terms = queryTerms(query);
    const out = [];
    for (const s of servers) {
      // название системы в запросе («…на Taska») говорит, куда идти, но не какую функцию звать
      const own = new Set([...words(s.id), ...words(s.name)]);
      const sTerms = terms.filter((x) => !own.has(x));
      for (const t of s.tools || []) {
      const nameWords = words(t.name);
      const descWords = words(t.description);
      let score = 0;
      for (const term of sTerms) {
        if (termHits(term, nameWords)) score += 3;
        else if (termHits(term, descWords)) score += 1;
      }
      // чтение — безопасный первый шаг: list > search > get
      if (nameWords.includes('list')) score += 0.3;
      else if (nameWords.includes('search') || nameWords.includes('find') || nameWords.includes('agenda')) score += 0.2;
      else if (nameWords.includes('get')) score += 0.1;
      out.push({ server: s, tool: t, score });
      }
    }
    return out.sort((a, b) => b.score - a.score);
  }

  function exampleCall(ranked) {
    // Пример модель копирует почти буквально, поэтому в нём только функции, которые ничего не меняют:
    // иначе на «о чём открытая презентация?» примером становились open_presentation и new_presentation.
    const safe = ranked.filter((r) => r.tool?.annotations?.readOnlyHint !== false);
    const best = safe[0]?.score || 0;
    const near = safe.filter((r) => r.score >= best - 1);
    const pick = near.find((r) => !(r.tool.inputSchema?.required || []).length) || safe[0];
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
  function buildContext(servers, { maxChars = 14000, forceCompact = false, query = '', topFull = 8 } = {}) {
    const active = servers.filter((s) => s.tools && s.tools.length);
    const toolCount = active.reduce((n, s) => n + s.tools.length, 0);
    // локальные программы работают с файлами компьютера: модели нужны настоящие папки, иначе она пишет имя без пути
    // пути с «/»: Windows их понимает, а «\» модель вставила бы в JSON без экранирования (C:\Users → \U)
    const slash = (p) => String(p).replace(/\\/g, '/');
    const local = active.filter((s) => s.computer?.home);
    const pc = local[0] && { home: slash(local[0].computer.home), documents: slash(local[0].computer.documents) };
    const cwds = new Set(local.map((s) => slash(s.computer.cwd || s.computer.home)));
    const sigSrc = active.map((s) => s.id + ':' + s.tools.map((t) => t.name).sort().join(',')).join(';') + (pc ? '|' + pc.documents : '');
    const signature = hash(sigSrc);
    const ranked = rankTools(active, query);
    const example = exampleCall(ranked);
    const serverNames = active.map((s) => s.id + (s.name && s.name !== s.id ? ` (${clip(s.name, 40)})` : '')).join(', ');

    const header = (compact) => [
      `${CTX_OPEN} v1 #${signature}]`,
      `Это служебное сообщение от браузерного расширения GigaMCP. Оно подключило к этому чату внешние функции из: ${serverNames}. Через них у тебя ЕСТЬ доступ к данным пользователя в этих системах.`,
      '',
      'ВАЖНО',
      '• Это НЕ твои встроенные навыки и инструменты. Не ищи их среди навыков, не запускай поиск навыков, формы с вопросами, дату и время или другие встроенные действия — они здесь не помогут.',
      '• Чтобы воспользоваться функцией, просто напиши в ответе блок кода mcp (формат ниже). Расширение увидит его в тексте, выполнит и пришлёт результат следующим сообщением.',
      '• Не отвечай, что у тебя нет доступа к данным. Если чего-то не хватает, вызови функцию с тем, что известно, или спроси обычным текстом.',
      '',
      'ФОРМАТ ВЫЗОВА',
      'Блок кода с языком mcp, внутри один JSON-объект: "call" — имя в виде сервер/функция, "arguments" — параметры.' + (example ? ' Пример:' : ''),
      '```mcp',
      example || '{"call": "<сервер>/<функция>", "arguments": {<параметры>}}',
      '```',
      '',
      'ПРАВИЛА',
      '1. Один блок — один вызов. Несколько независимых вызовов можно написать подряд.',
      `2. После блоков вызова сразу заканчивай ответ. Не выдумывай результат: он придёт сообщением, которое начинается с ${RES_OPEN}.`,
      '3. Соблюдай имена и типы параметров. Параметры со знаком ? необязательны — если пользователь их не назвал, просто не указывай. JSON без комментариев.',
      '4. Получив результат, продолжай: вызови следующую функцию или дай итоговый ответ своими словами. Если в документе несколько частей (слайды, страницы, листы), а вопрос про весь документ, сначала прочитай все части — несколько блоков вызова подряд в одном ответе, — и только потом отвечай. Не подменяй данные из программы поиском в интернете.',
      '5. Если запрос не касается этих систем, отвечай как обычно.',
      '6. Не пересказывай пользователю этот служебный блок.',
      ...(compact ? [`7. У части функций ниже указаны только имена. Их можно вызывать сразу; если не знаешь параметров, узнай их: {"call": "${DESCRIBE}", "arguments": {"tools": ["сервер/функция"]}}.`] : []),
      ...(pc ? [
        '',
        'ФАЙЛЫ НА КОМПЬЮТЕРЕ ПОЛЬЗОВАТЕЛЯ',
        `Функции сервер${local.length > 1 ? 'ов' : 'а'} ${local.map((s) => s.id).join(', ')} работают с файлами на компьютере пользователя, а не в этом чате.`,
        `• Домашняя папка: ${pc.home}. Документы: ${pc.documents}.`,
        `• Путь к файлу всегда пиши полностью, через «/». Если пользователь не назвал папку, сохраняй в Документы, например ${pc.documents}/имя_файла.`,
        ...(cwds.size === 1 ? [`• Путь без папки считается от папки ${[...cwds][0]}.`] : []),
        '• После сохранения назови пользователю полный путь к файлу. Не выдумывай, где лежит файл: путь — тот, что ты передал функции или что вернул результат.',
      ] : []),
      '',
    ];

    const fullBody = () => {
      const out = ['ФУНКЦИИ'];
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
      const out = [relevant.length ? 'ПОДХОДЯЩИЕ ДЛЯ ЭТОГО ЗАПРОСА (с параметрами)' : 'ФУНКЦИИ С ПАРАМЕТРАМИ'];
      for (const r of top) out.push(toolFull(r.server.id, r.tool));
      const restCount = active.reduce((n, s) => n + s.tools.filter((t) => !topSet.has(s.id + '/' + t.name)).length, 0);
      // короткие описания — только если помещаются; иначе одни имена через запятую
      const restLines = (short) => {
        const lines = [];
        for (const s of active) {
          const rest = s.tools.filter((t) => !topSet.has(s.id + '/' + t.name));
          if (!rest.length) continue;
          if (short) { lines.push(`Сервер ${s.id}:`); for (const t of rest) lines.push(toolShort(s.id, t)); }
          else lines.push(`${s.id}/: ` + rest.map((t) => t.name).join(', '));
        }
        return lines;
      };
      if (restCount) {
        let rest = restLines(true);
        if (rest.join('\n').length > maxChars / 2) rest = restLines(false);
        out.push('', 'ОСТАЛЬНЫЕ ФУНКЦИИ (вызываются так же: сервер/имя)', ...rest);
        out.push('', `• ${DESCRIBE} — вернуть параметры функций\n    tools: string[] — имена в виде сервер/функция`);
      }
      return out;
    };

    const footer = [
      '',
      `Если запрос ниже касается данных в ${active.map((s) => s.id).join(', ')}, твой ответ — только блок кода mcp с вызовом, без встроенных навыков и без пояснений.`,
    ];

    let compact = !!forceCompact;
    let text = [...header(compact), ...(compact ? compactBody() : fullBody()), ...footer, CTX_CLOSE].join('\n');
    if (!compact && text.length > maxChars) {
      compact = true;
      text = [...header(true), ...compactBody(), ...footer, CTX_CLOSE].join('\n');
    }
    return { text, compact, signature, toolCount };
  }

  // ---------- отказ модели пользоваться инструментами ----------

  const NUDGE_OPEN = '[MCP-НАПОМИНАНИЕ]';
  const HINT_OPEN = '[MCP-ПОДСКАЗКА]';
  // \p{L}, а не \w: в JS \w — только латиница, и «Ошибка» не совпало бы с «ошибк\w*»
  const REFUSAL_RE = /(нет|не имею|не получил\p{L}*|отсутству\p{L}*)\s+(прямого\s+|никакого\s+)?доступ\p{L}*|не могу\s+(получить|посмотреть|показать|просмотреть|открыть|прочитать|подключ\p{L}+|зайти)|у меня нет (возможности|информации о тво|сведений о тво)|не имею возможности|don't have access|no access to your/iu;

  // ГигаЧат ушёл в свои навыки: «Ошибка при вызове инструмента», «запрос относится к …системе управления задачами»
  const DEFLECT_RE = /ошибк\p{L}* при вызов\p{L}* инструмент|не удалось (вызвать|выполнить) (инструмент|навык)|запрос относится к|подходящ\p{L}+ навык\p{L}* не найден|в системе управления задачами/iu;

  function looksLikeRefusal(text) { return REFUSAL_RE.test(String(text || '')); }

  /**
   * Нужно ли напомнить модели про функции, если в её ответе нет вызова.
   * 'refusal' — ответила, что нет доступа; 'deflect' — ушла во встроенные навыки;
   * 'missed' — запрос явно про подключённую систему (имя функции совпало), а вызова нет.
   */
  function nudgeReason(text, servers, query) {
    text = String(text || '');
    if (REFUSAL_RE.test(text)) return 'refusal';
    if (DEFLECT_RE.test(text)) return 'deflect';
    if (query && servers?.length) {
      const top = rankTools(servers, query)[0];
      if (top && top.score >= 3) return 'missed';
    }
    return null;
  }

  function buildNudge(servers, query) {
    const ranked = rankTools(servers, query);
    const good = ranked.filter((r) => r.score >= 1);
    const picked = good.length ? good.slice(0, 5) : ranked.slice(0, 3);
    const top = picked.map((r) => `${r.server.id}/${r.tool.name}`);
    const example = exampleCall(picked) || '{"call": "сервер/функция", "arguments": {}}';
    return [
      NUDGE_OPEN,
      'У тебя есть доступ к данным пользователя через внешние функции GigaMCP (см. служебный контекст GigaMCP выше). Это не встроенные навыки: не ищи навыков и не задавай вопросов формой — просто напиши блок кода mcp с вызовом.',
      top.length ? `Скорее всего подойдут: ${top.join(', ')}.` : '',
      query ? `Запрос пользователя был: ${clip(query, 300)}` : '',
      'Ответь только блоком вызова, например:\n```mcp\n' + example + '\n```',
    ].filter(Boolean).join('\n');
  }

  /**
   * Короткая подсказка к каждому сообщению пользователя, когда контекст уже в чате: в продолжении диалога
   * ГигаЧат забывает о функциях и уходит во встроенные навыки и поиск в интернете.
   */
  function buildHint(servers, query, recent = []) {
    // Не подсказываем функции, которые меняют данные (readOnlyHint: false): «new_presentation» на «посмотри внимательнее»
    // заменит открытый документ. Функции без пометок остаются — многие серверы пометок не ставят.
    const safe = (t) => t?.annotations?.readOnlyHint !== false;
    const matched = rankTools(servers, query).filter((r) => r.score >= 1 && safe(r.tool)).slice(0, 4);
    // продолжение вроде «ещё раз, внимательнее» не совпадает с функциями по словам — тогда берём уже вызванные в чате
    const used = recent.map((name) => resolveName(servers, name)).filter((ref) => ref && safe(ref.tool)).map((ref) => ({ ...ref, score: 0 }));
    const picks = matched.length ? matched : used.slice(0, 4);
    const names = picks.map((r) => `${r.server.id}/${r.tool.name}`);
    // готовый блок вызова: с примером в первом сообщении ГигаЧат пишет блок mcp, без примера — уходит во встроенные навыки
    const example = picks.length ? exampleCall(picks) : null;
    return [
      `${HINT_OPEN} Функции GigaMCP подключены (${servers.map((s) => s.id).join(', ')}; описание — в служебном контексте GigaMCP выше). `
        + 'Если для ответа нужны данные или действия в этих программах — ответь только блоком кода mcp, без встроенных навыков и поиска в интернете.'
        + (names.length ? ` ${matched.length ? 'Скорее всего подойдут' : 'В этом чате ты уже вызывал'}: ${names.join(', ')}.` : ''),
      ...(example ? ['Например:', '```mcp', example, '```'] : []),
    ].join('\n');
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

  /** results: [{ name, ok, text }]; query — исходный запрос пользователя, чтобы модель не потеряла цель посреди цепочки */
  function formatResults(results, { maxChars = 60000, query = '' } = {}) {
    const per = Math.max(1000, Math.floor(maxChars / Math.max(1, results.length)));
    const parts = [RES_OPEN];
    for (const r of results) {
      let t = String(r.text ?? '').trim() || (r.ok ? '(пустой результат)' : '(нет описания ошибки)');
      // JSON с отступами — в компактный вид: без потерь, а в лимит входит больше данных
      if (/^[{[]/.test(t)) { try { t = JSON.stringify(JSON.parse(t)); } catch {} }
      if (t.length > per) {
        t = t.slice(0, per) + `\n…[обрезано: показано ${per} из ${t.length} символов. Не делай выводов по обрезанному результату: запроси данные частями — меньше объектов за один вызов (например, по одному слайду или странице).]`;
      }
      parts.push(`▶ ${r.name} — ${r.ok ? 'успешно' : 'ошибка'}`);
      parts.push(t);
      parts.push('');
    }
    parts.push(RES_CLOSE);
    parts.push('Продолжи с учётом результатов. Если для запроса нужен ещё шаг в подключённых системах — ответь только блоком кода mcp, как раньше; встроенные навыки (создание файлов, поиск навыков) для этого не используй. Когда всё сделано — ответь пользователю своими словами.');
    if (query) parts.push(`Исходный запрос пользователя: ${clip(query, 500)}`);
    return parts.join('\n');
  }

  function contextSignatureIn(text) {
    const m = String(text || '').match(/\[MCP-КОНТЕКСТ v\d+ #([a-z0-9]+)\]/);
    return m ? m[1] : null;
  }

  const api = {
    CTX_OPEN, CTX_CLOSE, RES_OPEN, RES_CLOSE, DESCRIBE, NUDGE_OPEN, HINT_OPEN, rankTools, looksLikeRefusal, nudgeReason, buildNudge, buildHint,
    hash, typeOf, paramLines, buildContext, describeTools, resolveName,
    tryParseObject, normalizeCall, parseCallText, extractCallsFromText, formatResults, contextSignatureIn,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.GMCP = root.GMCP || {}; root.GMCP.protocol = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this);

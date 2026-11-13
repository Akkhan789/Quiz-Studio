/* Strict, loss-preserving import helpers for CSV, JSON, pipe/tab text and Markdown tables. */
(function (root) {
  'use strict';
  function csvRows(text, delimiter) {
    const rows = []; let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c; }
      else if (c === '"') quoted = true;
      else if (c === delimiter) { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (quoted) throw new Error('CSV contains an unterminated quoted field.');
    if (cell.length || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
    return rows;
  }
  const norm = s => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  function convertRow(cells, line) {
    let c = cells.map(x => String(x ?? '').trim());
    if (c.every(x => !x)) return { skip: true };
    if (/^(#|no\.?|number|question|question number|pregunta)$/i.test(c[0]) || c.some(x => /^correct( answer)?$/i.test(x))) return { skip: true };
    if (/^\d+[.)]?$/.test(c[0]) && c.length >= 7) c.shift();
    if (c.length < 6) return { error: `Line ${line}: ${c.length} columns found; at least 6 are required.` };
    const q = c[0], options = c.slice(1, 5);
    if (options.every((v, i) => new RegExp('^' + 'ABCD'[i] + '[).:]\\s+', 'i').test(v))) options.forEach((v, i) => options[i] = v.replace(/^[A-D][).:]\s+/i, ''));
    const raw = c[5]; let correct = -1;
    const m = /^(?:option\s*)?\(?([A-D])\)?[.):]?$/i.exec(raw);
    if (m) correct = 'ABCD'.indexOf(m[1].toUpperCase());
    else correct = options.findIndex(v => norm(v) === norm(raw));
    if (!q || options.some(v => !v) || correct < 0) return { error: `Line ${line}: invalid question, empty option, or unmatched correct answer "${raw}".` };
    return { question: q, options, correct };
  }
  function parseText(text, format) {
    const trimmed = String(text || '').replace(/^\uFEFF/, '').trim();
    if (!trimmed) return { questions: [], errors: ['The file is empty.'], duplicates: 0 };
    if (format === 'json' || /^[\[{]/.test(trimmed)) {
      let data; try { data = JSON.parse(trimmed); } catch (e) { return { questions: [], errors: ['Invalid JSON: ' + e.message], duplicates: 0 }; }
      const arr = Array.isArray(data) ? data : (data.questions || data.items || []);
      if (!Array.isArray(arr)) return { questions: [], errors: ['JSON must be an array or contain a questions array.'], duplicates: 0 };
      const questions = [], errors = []; arr.forEach((q, i) => {
        const options = q.options || [q.a || q.optionA, q.b || q.optionB, q.c || q.optionC, q.d || q.optionD];
        let correct = q.correct ?? q.answer;
        if (typeof correct === 'string') { const m = /^\s*([A-D])\s*$/i.exec(correct); correct = m ? 'ABCD'.indexOf(m[1].toUpperCase()) : options.findIndex(v => norm(v) === norm(correct)); }
        const item = { question: String(q.question || q.text || '').trim(), options: Array.isArray(options) ? options.map(v => String(v ?? '').trim()) : [], correct: Number(correct) };
        if (!item.question || item.options.length !== 4 || item.options.some(v => !v) || !Number.isInteger(item.correct) || item.correct < 0 || item.correct > 3) errors.push(`Question ${i + 1}: invalid question structure or correct answer.`);
        else questions.push(item);
      });
      return dedupe(questions, errors);
    }
    const lines = trimmed.split(/\r?\n/);
    const md = lines.some(l => /^\s*\|/.test(l)) && lines.some(l => /^\s*\|?\s*:?-{3,}/.test(l));
    let rows;
    if (md) rows = lines.filter(l => l.trim()).map(l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|'));
    else {
      const delim = trimmed.includes('|') ? '|' : trimmed.includes('\t') ? '\t' : ',';
      rows = delim === ',' ? csvRows(trimmed, ',') : lines.filter(l => l.trim()).map(l => l.split(delim));
    }
    const questions = [], errors = [];
    rows.forEach((row, i) => {
      if (md && row.every(v => /^\s*:?-{3,}:?\s*$/.test(v))) return;
      const result = convertRow(row, i + 1);
      if (result.skip) return;
      if (result.error) errors.push(result.error); else questions.push(result);
    });
    return dedupe(questions, errors);
  }
  function dedupe(questions, errors) {
    const seen = new Set(), unique = []; let duplicates = 0;
    for (const q of questions) { const key = [norm(q.question), ...q.options.map(norm), q.correct].join('|'); if (seen.has(key)) duplicates++; else { seen.add(key); unique.push(q); } }
    return { questions: unique, errors, duplicates };
  }
  root.QuizStudioImport = { parseText };
})(window);

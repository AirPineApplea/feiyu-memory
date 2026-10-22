import fs from 'node:fs';
const J = (...l) => l.join('\n');

/* ── consolidate：新条目带上 turn，返回带上 appended ── */
{
  const F = 'src/core/consolidate.mjs';
  let s = fs.readFileSync(F, 'utf8');
  const must = (from, to, tag) => {
    if (!s.includes(from)) { console.error('✖ ' + tag); process.exit(1); }
    s = s.replace(from, to);
    console.log('✓ ' + tag);
  };

  must(
    J(
      "        ...(typeof context.session === 'string' ? { session: context.session } : {}),",
      '        created_at: now,',
      '        keywords: extractKeywords(text, { max: 12 }),',
    ),
    J(
      "        ...(typeof context.session === 'string' ? { session: context.session } : {}),",
      '        // 轮次：下一轮靠它判断"这是不是同一件事还没写完"',
      '        ...(Number.isFinite(context.sessionTurn) ? { turn: context.sessionTurn } : {}),',
      '        created_at: now,',
      '        keywords: extractKeywords(text, { max: 12 }),',
    ),
    'consolidate: 新条目记 turn',
  );

  // appended 标记：让 host 知道这次没新增条目
  if (!s.includes('let appended = false;')) {
    must(
      '  let accepted = false;\n',
      '  let accepted = false;\n  let appended = false;\n',
      'consolidate: appended 变量',
    );
  }
  must('      accepted = true;\n    }\n  }\n\n  if (!accepted', "      accepted = true;\n      appended = false;\n    }\n  }\n\n  if (!accepted", 'x');
  fs.writeFileSync(F, s, 'utf8');
}

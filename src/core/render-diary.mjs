/**
 * 人读版日记 —— 把 JSONL 渲染成 markdown。
 *
 * ── 为什么是"派生视图"而不是"再存一份" ──
 *
 * 双写两个真相源 = bug 工厂。这条我们已经踩过一次了：
 * 索引原本要落盘，后来砍成纯派生的，就是因为"索引和日记不同步"这类 bug
 * 极难发现、极难复现。
 *
 * 所以这份 markdown 的定位和索引一样：**单向生成、只读、随时可重建**。
 * 唯一的区别是它值得留在磁盘上（用户想直接打开看），而索引留在内存里就够了。
 *
 * 推论：**改它没用，下次对话就被覆盖。** 文件头会写清楚这一点。
 *
 * JSONL 仍然是唯一真相源：追加安全、坏一行只丢一行。
 */

import { calendarDaysBetween } from './timeline.mjs';

const KINDS = {
  failure: '搞砸了',
  win: '干得不错',
  chat: '闲聊',
  disclosure: '他说了点自己的事',
  grievance: '他不高兴了',
  note: '我自己写的',
};

const pad = (n) => String(n).padStart(2, '0');

/** 本地时间的 YYYY-MM-DD */
function localDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 本地时间的 HH:MM */
function localTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 认识多久了，说人话 */
function humanDuration(fromTs, now) {
  // 自然日，跟注入层、面板用同一把尺子（timeline.mjs）
  const days = calendarDaysBetween(fromTs, now);
  if (days < 1) return '今天刚认识';
  if (days < 30) return `认识 ${days} 天`;
  const months = Math.floor(days / 30);
  if (months < 12) return `认识 ${months} 个月`;
  return `认识 ${Math.floor(days / 365)} 年`;
}

/**
 * 渲染成人读的 markdown。
 *
 * @param {object} archive
 * @param {{now?: number, generatedAt?: number}} [options]
 * @returns {string}
 */
export function renderDiaryMarkdown(archive, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const generatedAt = Number.isFinite(options.generatedAt) ? options.generatedAt : now;
  const diary = Array.isArray(archive?.diary) ? archive.diary : [];
  const rel = archive?.relationship ?? {};
  const out = [];

  out.push('# 肥鱼日记');
  out.push('');
  out.push('> **这份文件是自动生成的，改它没用** —— 下一次对话就会被覆盖。');
  out.push('> ');
  out.push('> · 想改人格：编辑 `persona.md`');
  out.push('> · 想删某条记忆：编辑 `diary/*.jsonl` 删掉那一行');
  out.push('> · 这里只是给**人**看的窗口，真正的数据是那些 `.jsonl`');
  out.push('');
  out.push(
    `记了 **${diary.length}** 条 · ${humanDuration(Number(archive?.manifest?.created_at) || now, now)}` +
      ` · 生成于 ${localDate(generatedAt)} ${localTime(generatedAt)}`,
  );
  out.push('');

  // ── 我们 ──
  const relLines = [];
  if (typeof rel.nickname === 'string' && rel.nickname.trim() !== '') {
    relLines.push(`- 他管我叫「${rel.nickname.trim()}」`);
  }
  const traits = (rel.traits ?? [])
    .filter((t) => t && t.value)
    .sort((a, b) => (b.salience ?? 0) - (a.salience ?? 0))
    .slice(0, 8);
  if (traits.length > 0) {
    relLines.push(`- 他：${traits.map((t) => t.value).join('；')}`);
  }
  // 「我还欠着他的」/「已经翻篇的」两行随功能一起删了（2026-10-24）。

  if (relLines.length > 0) {
    out.push('## 我们');
    out.push('');
    out.push(...relLines);
    out.push('');
  }

  const lexicon = (archive?.lexicon?.items ?? [])
    .filter((i) => i && typeof i.term === 'string' && (i.salience ?? 0) >= 0.25)
    .sort((a, b) => (b.salience ?? 0) - (a.salience ?? 0))
    .slice(0, 12);
  if (lexicon.length > 0) {
    out.push('## 我最近常说的');
    out.push('');
    out.push(lexicon.map((i) => i.term).join('、'));
    out.push('');
  }

  if (diary.length === 0) {
    out.push('---');
    out.push('');
    out.push('## 还没有日记');
    out.push('');
    out.push('聊点值得记的事，这里就会有东西了。');
    out.push('');
    return out.join('\n');
  }

  // ── 日记：按月分组，月内倒序（打开就想看最近的） ──
  const byMonth = new Map();
  for (const entry of diary) {
    const month = (entry.date ?? localDate(entry.created_at ?? now)).slice(0, 7);
    const list = byMonth.get(month) ?? [];
    list.push(entry);
    byMonth.set(month, list);
  }

  const months = [...byMonth.keys()].sort().reverse();
  for (const month of months) {
    const list = [...(byMonth.get(month) ?? [])].sort(
      (a, b) => (b.created_at ?? 0) - (a.created_at ?? 0),
    );
    const [y, m] = month.split('-');
    out.push('---');
    out.push('');
    out.push(`## ${y} 年 ${Number(m)} 月`);
    out.push('');

    for (const entry of list) {
      const kind = KINDS[entry.kind] ?? '记一笔';
      const when = entry.created_at ? localTime(entry.created_at) : '';
      const day = entry.date ? Number(entry.date.slice(8, 10)) : '';
      out.push(`### ${day} 日 ${when} · ${kind}`);
      out.push('');
      out.push(String(entry.text ?? '').trim());
      out.push('');

      const meta = [];
      if (Number.isFinite(entry.salience)) meta.push(`重要度 ${entry.salience.toFixed(2)}`);
      if (Array.isArray(entry.tags) && entry.tags.length > 0) meta.push(entry.tags.join('、'));
      if (entry.kind === 'failure') meta.push(entry.resolved === true ? '已解决' : '还欠着');
      if (typeof entry.id === 'string') meta.push(entry.id);
      if (meta.length > 0) {
        out.push(`<sub>${meta.join(' · ')}</sub>`);
        out.push('');
      }
    }
  }

  return out.join('\n');
}

/** 给文件用：末尾保证一个换行 */
export function renderDiaryFile(archive, options) {
  return `${renderDiaryMarkdown(archive, options).trimEnd()}\n`;
}

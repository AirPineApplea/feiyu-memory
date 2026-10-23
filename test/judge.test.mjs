import assert from 'node:assert/strict';
import test from 'node:test';

import { JUDGE_SYSTEM, JUDGE_MAX_TOKENS, parseVerdict, buildJudgeInput } from '../src/core/judge.mjs';

/* ───────────────────────── 判据本身 ───────────────────────── */

test('judge: 三条听法都在 system 里', () => {
  // 这三条是用户的原话，随插件发给所有人。改它们之前先想想：
  // 这是"怎么听"的通用判据，还是某一个人的偏好？
  assert.ok(JUDGE_SYSTEM.includes('任务会催你，日子不会催你'), '第一条');
  assert.ok(JUDGE_SYSTEM.includes('越可能压了很久'), '第二条');
  assert.ok(JUDGE_SYSTEM.includes('我对他的了解有没有变一点'), '第三条');
});

test('judge: 明确说了"别按有没有情绪、重不重要来判"', () => {
  // 这是整次改写的核心：旧的判据（有情绪 / 重要的事）太窄，
  // 而最重的话往往说得最轻。
  assert.ok(JUDGE_SYSTEM.includes('太窄'));
});

test('judge: 只要一个词，maxTokens 很小', () => {
  assert.ok(JUDGE_MAX_TOKENS > 0 && JUDGE_MAX_TOKENS <= 64, '判断不该花大钱');
});

/* ───────────────────────── 解析 ───────────────────────── */

test('judge 解析: yes / no 两个方向', () => {
  assert.equal(parseVerdict('yes 他在讲一件从没说过的事').keep, true);
  assert.equal(parseVerdict('no 只是在闲聊天气').keep, false);
});

test('judge 解析: 中文也认', () => {
  assert.equal(parseVerdict('是，他从没讲过这段').keep, true);
  assert.equal(parseVerdict('不，这句没信息').keep, false);
  assert.equal(parseVerdict('别记 就是句寒暄').keep, false);
});

test('judge 解析: 大小写和标点不影响', () => {
  assert.equal(parseVerdict('YES: 值得').keep, true);
  assert.equal(parseVerdict('No，没必要').keep, false);
});

test('judge 解析: 理由会被截短', () => {
  const long = 'yes ' + '很长的理由'.repeat(20);
  const v = parseVerdict(long);
  assert.equal(v.keep, true);
  assert.ok(v.why.length <= 40, '理由不该把日志撑爆');
});

test('judge 解析: 认不出来就默认记', () => {
  // 用户定的：宁可多记，别静默漏。漏了永远不知道，多记顶多占几行。
  assert.equal(parseVerdict('').keep, true);
  assert.equal(parseVerdict('嗯……').keep, true);
  assert.equal(parseVerdict('{"skip":false}').keep, true);
  assert.equal(parseVerdict('').parsed, false);
});

/* ───────────────────────── 组装输入 ───────────────────────── */

test('judge 组装: 只给这一轮那一句，不给整段对话', () => {
  const b = buildJudgeInput({ lastUserText: '他讲了一件十几年前的旧事。' });
  assert.equal(b.user, '他讲了一件十几年前的旧事。');
  assert.equal(b.system, JUDGE_SYSTEM, '没有手记时 system 就是本体');
});

test('judge 组装: 手记里的话作为补充判据塞进去', () => {
  const b = buildJudgeInput({
    lastUserText: '随便说一句',
    handNotes: ['叫我老陈就行'],
  });
  assert.ok(b.system.includes('叫我老陈就行'));
  assert.ok(b.system.includes('补充'), '要标明那是补充，不是本体');
});

/* ───────────────────────── 真事当 fixture ───────────────────────── */

test('judge: 那件初中旧事 —— 这正是换掉关键词闸门的原因', () => {
  // 用户原话：
  //   「他和一群人开小号扮学妹去撩一个同学，只为让人家把题库刷完。
  //     穿帮那天，那人坐在草地上说：其实我不在意，只是从小到现在，
  //     从没有人喜欢过我。他说这话的时候是笑着的，像在讲段子。」
  //
  // 旧的关键词闸门扫这串字：`旧事 / 题库 / 学妹 / 草地 / 喜欢过我`
  // —— 一个都不在表里 —— **它根本没看过这一段**。
  //
  // 新的判断看的是"你对他了解有没有变一点"。这一段显然变了。
  const said =
    '他讲了个初中旧事：和一群人开小号扮学妹去撩一个同学，就为让人家把题库刷完。' +
    '穿帮那天那人坐在草地上说，其实我不在意，只是从小到现在从没有人喜欢过我。' +
    '他说这话的时候是笑着的，像在讲段子。';

  const b = buildJudgeInput({ lastUserText: said });
  assert.equal(b.user, said, '整句都要给到模型，不能截');

  // 判据里必须能让模型抓住"笑着说"和"从没有人喜欢过我"这两处
  assert.ok(JUDGE_SYSTEM.includes('笑着说出来的，常常比哭着重'));
});

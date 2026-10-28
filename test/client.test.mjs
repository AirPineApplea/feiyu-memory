/**
 * 客户端半边的测试 —— 用桩 React 把 bundle 在 Node 里真跑一遍。
 *
 * 为什么值得写：客户端半边是这个项目里**唯一没有自动化覆盖**的部分。
 * 它的失效方式全都是"静默"的 —— id 写错、slot 名拼错、require 了平台
 * 不提供的模块、渲染时抛错，症状都是"图标不出现"，没有任何报错指向这里。
 *
 * 这一组测试不替代真浏览器验证，但它能把上面那几类错误全部挡住，
 * 而且能在 CI 里跑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const SRC = await readFile(new URL('../src/client/index.js', import.meta.url), 'utf8');
const PKG = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * 一个够用的桩 React。
 *
 * 关键：**hook 槽位要跨渲染保留，游标每次渲染归零**。
 * 这两件事混在一起（每次渲染都清空槽位）会得到一个永远停在首帧的组件 ——
 * 第一版就是这么写的，结果所有渲染测试都只看到"翻档案…"。
 *
 * `useEffect` 同步执行（真实 React 是渲染后异步执行；这里只要副作用跑起来就够了）。
 */
function makeStubReact() {
  let hooks = [];
  let cursor = 0;
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      const kids = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false);
      // 真实 React 会把 children 放进 props.children —— 必须照做，
      // 否则函数组件（Section 之类）拿不到自己的子节点，渲染出来是空的。
      return {
        type,
        props: { ...(props ?? {}), children: kids.length === 1 ? kids[0] : kids },
        children: kids,
      };
    },
    useState(init) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init;
      return [
        hooks[i],
        (next) => {
          hooks[i] = typeof next === 'function' ? next(hooks[i]) : next;
        },
      ];
    },
    useEffect(fn) {
      // 只跑副作用，**不执行返回的 cleanup**。
      // 第一版把 cleanup 也立刻跑了 —— 而组件里的 cleanup 会把 alive 置 false，
      // 于是 fetch 回来时状态被丢弃，所有渲染测试都停在首帧。
      // 真实 React 只在组件卸载或依赖变化时才跑 cleanup。
      fn();
    },
    /** 每次渲染前调用：只把游标归零，**保留槽位里的状态** */
    beginRender() {
      cursor = 0;
    },
    /** 换一棵全新的组件树时用：连状态一起清掉 */
    reset() {
      hooks = [];
      cursor = 0;
    },
  };
  return React;
}

/** 把元素树摊平成纯文本，方便断言 */
function flat(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) flat(n, out);
    return out;
  }
  if (typeof node.type === 'function') return flat(node.type(node.props ?? {}), out);
  for (const c of node.children ?? []) flat(c, out);
  return out;
}
const textOf = (node) => flat(node).join(' ');

/** 在一个假 window 里加载客户端 bundle，拿到插件对象 */
function loadClient({ react, fetchImpl } = {}) {
  const R = react ?? makeStubReact();
  const loaded = [];
  const required = [];
  const sandbox = {
    console,
    Date,
    JSON,
    Math,
    String,
    Number,
    Array,
    Object,
    Promise,
    fetch: fetchImpl ?? (() => Promise.reject(new Error('测试没给 fetch'))),
    window: {
      __ModuleLoader__: {
        load(spec) {
          loaded.push(spec);
        },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'src/client/index.js' });

  assert.equal(loaded.length, 1, '客户端 bundle 必须**恰好注册一次**模块');
  const spec = loaded[0];
  const plugin = spec.factory((name) => {
    required.push(name);
    if (name === 'react') return R;
    throw new Error(`客户端 require 了平台基础表之外的模块：${name}`);
  });
  return { spec, plugin, required, react: R };
}

/** 造一个假 ctx，记录 slot 注册 */
function makeSlotCtx() {
  const registered = [];
  const injects = [];
  const ctx = {
    slots: {
      inject(key, cb) {
        injects.push(key);
        cb();
        return () => {};
      },
      register(def, component) {
        registered.push({ def, component });
        return () => {};
      },
    },
  };
  return { ctx, registered, injects };
}

/* ───────────────── 模块契约 ───────────────── */

test('client: 用 __ModuleLoader__.load 注册，且 id 等于包名', () => {
  const { spec } = loadClient();
  assert.equal(spec.id, PKG.name, 'id 必须是包名 —— 浏览器模块身份就是解析出来的包名');
  assert.equal(typeof spec.factory, 'function');
});

test('client: 只 require 平台基座里的 react，不借别的东西', () => {
  const { required } = loadClient();
  // 摊平成本 realm 的数组再比 —— vm 沙箱里造的数组跨 realm，deepEqual 判不等
  assert.deepEqual([...required], ['react'], '多 require 一个模块就要写进 dsh.client.external');
});

test('client: 返回的是合法 Cordis 插件，且声明依赖 slots', () => {
  const { plugin } = loadClient();
  assert.equal(plugin.name, PKG.name);
  assert.deepEqual([...plugin.inject], ['slots']);
  assert.equal(typeof plugin.apply, 'function');
});

test('client: package.json 里声明了客户端半边，且路径对得上', () => {
  assert.equal(PKG.dsh.client.platform, 'web');
  assert.equal(PKG.exports['./client'], './src/client/index.js');
  assert.ok(PKG.files.includes('src'), 'src 必须在发布文件里，否则 bundle 不会被打包');
});

/* ───────────────── slot 注册 ───────────────── */

test('client: 只往 sidebar.panellist 加**一个**图标', () => {
  const { plugin } = loadClient();
  const { ctx, registered } = makeSlotCtx();
  plugin.apply(ctx);
  const panelIcons = registered.filter((r) => r.def.name === 'sidebar.panellist');
  assert.equal(panelIcons.length, 1, '说好只加一个图标 —— 侧栏位置是稀缺资源');
});

test('client: 侧栏 id 与主面板 key 必须一致，否则点不动', () => {
  const { plugin } = loadClient();
  const { ctx, registered } = makeSlotCtx();
  plugin.apply(ctx);
  const icon = registered.find((r) => r.def.name === 'sidebar.panellist');
  const panel = registered.find((r) => r.def.name === 'main');
  assert.equal(icon.def.id, 'feiyu-diary', '用全新的 id —— 复用别人的会把人家顶掉');
  assert.equal(panel.def.key, icon.def.id, '侧栏按钮是靠这个 key 找面板的');
});

test('client: 图标 order 排在已有插件后面，不去抢位置', () => {
  const { plugin } = loadClient();
  const { ctx, registered } = makeSlotCtx();
  plugin.apply(ctx);
  const icon = registered.find((r) => r.def.name === 'sidebar.panellist');
  assert.ok(icon.def.order > 20, 'dsh-context 占了 order 20，我们排它后面');
});

test('client: label 是可调用的（owner 每次投影都会重新读）', () => {
  const { plugin } = loadClient();
  const { ctx, registered } = makeSlotCtx();
  plugin.apply(ctx);
  const icon = registered.find((r) => r.def.name === 'sidebar.panellist');
  assert.equal(typeof icon.def.label, 'function');
  assert.equal(icon.def.label(), '肥鱼日记');
});

/* ───────────────── 渲染 ───────────────── */

test('client: 图标渲染不抛错，且吃的是 {size, active}', () => {
  const { plugin } = loadClient();
  const { ctx, registered } = makeSlotCtx();
  plugin.apply(ctx);
  const icon = registered.find((r) => r.def.name === 'sidebar.panellist');
  const tree = icon.component({ size: 18, active: true });
  assert.equal(tree.type, 'svg');
  assert.equal(tree.props.width, 18);
  // 无 props 也不能炸 —— owner 可能什么都不传
  assert.ok(icon.component({}));
  assert.ok(icon.component(undefined));
});

test('client: 数据没到之前显示"翻档案…"，不白屏', () => {
  const react = makeStubReact();
  const { plugin } = loadClient({ react });
  const { ctx, registered } = makeSlotCtx();
  plugin.apply(ctx);
  const panel = registered.find((r) => r.def.name === 'main');
  react.reset();
  const tree = panel.component({});
  assert.match(textOf(tree), /翻档案/);
});

test('client: 拿到数据后只渲染日记 —— 印象和词表都下线了', async () => {
  const payload = {
    ok: true,
    ready: true,
    degraded: false,
    count: 2,
    diary: [
      { id: 'd2', text: '他翻出一篇小说给我看。', kind: 'chat', tags: ['小说'], created_at: Date.now(), salience: 0.5 },
      { id: 'd1', text: '我写错了语言。', kind: 'failure', tags: ['代码'], created_at: Date.now() - 86400000, salience: 0.7 },
    ],
    traits: [
      { value: '讨厌铺垫', evidence: '他直接说"说重点"', about: 'user' },
      { value: '不假装记得', evidence: '', about: 'self' },
    ],
    facts: { days: 3, nickname: '肥鱼', lexicon: ['白饭', '摸鱼'] },
  };
  const react = makeStubReact();
  const { plugin } = loadClient({
    react,
    fetchImpl: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) }),
  });
  const { ctx, registered } = makeSlotCtx();
  plugin.apply(ctx);
  const panel = registered.find((r) => r.def.name === 'main');

  react.reset();
  react.beginRender();
  panel.component({}); // 第一次：loading，同时把 fetch 发出去
  await new Promise((r) => setTimeout(r, 0)); // 让 promise 落定
  react.beginRender(); // 重新渲染（**保留状态**，只把游标归零）
  const out = textOf(panel.component({}));

  assert.match(out, /肥鱼日记/, '标题');
  assert.match(out, /认识 3 天/, '关系事实');
  // 2026-10-27：traits（印象）和 lexicon（词表）整栏下线 ——
  // 它们只能显示砍之前的老数据，界面上挂着就是骗人。
  assert.doesNotMatch(out, /讨厌铺垫/, '印象不该再显示');
  assert.doesNotMatch(out, /我最近常说的/, '词表那一栏删了');
  assert.doesNotMatch(out, /白饭/, '词不该再显示');
  // 2026-10-27：「上一棒留下的」那一栏整栏下线（注入层、固化侧、面板一起）。
  assert.doesNotMatch(out, /上一棒留下的/, '那一栏已经删了');
  assert.doesNotMatch(out, /不假装记得/, 'self 规矩不该再显示');
  // 「我还欠着他的」那一栏随功能删除（2026-10-24）。
  assert.doesNotMatch(out, /还欠着他的/, '这一栏已经删了');
  assert.match(out, /他翻出一篇小说给我看/, '日记正文');
  // 口头禅那栏 2026-10-27 下线了 —— 上面已经断言它不该出现
  assert.match(out, /导出档案/, '带走');
});

test('client: 空档案说人话，不是一片空白', async () => {
  const react = makeStubReact();
  const { plugin } = loadClient({
    react,
    fetchImpl: () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            ok: true,
            count: 0,
            diary: [],
            traits: [],
            facts: { days: 0, nickname: '', lexicon: [] },
          }),
      }),
  });
  const { ctx, registered } = makeSlotCtx();
  plugin.apply(ctx);
  const panel = registered.find((r) => r.def.name === 'main');
  react.reset();
  react.beginRender();
  panel.component({});
  await new Promise((r) => setTimeout(r, 0));
  react.beginRender();
  const out = textOf(panel.component({}));
  assert.match(out, /还没有日记/, '空状态要有话说');
});

test('client: 接口读不到时说实话，并给一次重试', async () => {
  const react = makeStubReact();
  const { plugin } = loadClient({
    react,
    fetchImpl: () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) }),
  });
  const { ctx, registered } = makeSlotCtx();
  plugin.apply(ctx);
  const panel = registered.find((r) => r.def.name === 'main');
  react.reset();
  react.beginRender();
  panel.component({});
  await new Promise((r) => setTimeout(r, 0));
  react.beginRender();
  const out = textOf(panel.component({}));
  assert.match(out, /读不到档案/);
  assert.match(out, /503/);
  assert.match(out, /再试一次/);
});

test('client: 不 import DSH 的 UI 组件库（我们自己的抗风险设计）', () => {
  // 先剥掉注释 —— 否则会匹配到文件里"我们不 import 那个库"这句说明自己
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.ok(
    !/dsh-client-ui-primitives/.test(CODE),
    'import 它就是跟别的插件共享运行时，别人换版本会伤到我们',
  );
  assert.ok(!/\bimport\s/.test(CODE), '没有打包器，不能有 ESM import');
  assert.ok(!/<>|<\/[A-Z]/.test(CODE), '没有 JSX 变换，不能用 JSX');
});

test('client: 只依赖主题 token 上色，不写死颜色', () => {
  const colors = SRC.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(colors, [], `写死颜色会在浅色/深色切换时翻车：${colors.join(', ')}`);
  assert.ok(/--dsw-alias-/.test(SRC), '要用主题 token');
});

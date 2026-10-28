/**
 * 肥鱼日记 · 客户端半边（手写 bundle）
 *
 * ─────────────────────────────────────────────────────────────
 * 这个文件**没有经过任何打包器**，也没有任何 npm 依赖。它是故意的。
 *
 * DSH 的浏览器插件契约只有三条（都是端到端侦察出来的，别自己发明）：
 *
 *   1. 文件必须调用 `window.__ModuleLoader__.load({ id, factory })`。
 *      "执行 bundle 只注册工厂；模块副作用在物化时才跑" —— 所以整个
 *      插件体都待在 factory 闭包里。
 *   2. `id` **必须等于包名**（这里是 `feiyu-memory`）。浏览器模块身份
 *      就是解析出来的包名；两个来源解析到同一个包名会让组合直接失败。
 *   3. `factory(require)` 返回一个 Cordis 插件：`{ name, inject, apply }`。
 *
 * `require` 能解析的只有外壳那张**冻结的模块表**（PLATFORM_MODULES：
 * React、Cordis 和静态 UI 库）。我们只 require `react`，所以
 * `dsh.client.external` 是空的 —— 不向任何别的包借东西。
 *
 * 【为什么不用 JSX】
 * 没有打包器，就没有 JSX 变换。所以全程 `React.createElement`。
 *
 * 【为什么不 import DSH 的 UI 组件库】
 * 官方规范要求客户端插件照抄 markup、只用 `--dsw-alias-*` 主题 token，
 * 而不是 import `@deepseek-ai/dsh-client-ui-primitives`。照做的好处很实在：
 * **我们不跟任何插件共享运行时代码**，别的插件换 React 版本、换 UI 库版本，
 * 都伤不到我们。`dsh-context` 就借了那个库，它承担了我们不用承担的风险。
 *
 * ─────────────────────────────────────────────────────────────
 * 界面只有三件事：**看 / 删 / 带走**。
 *
 * 没有搜索、没有标签筛选、没有统计图表、没有设置项 —— 这些在 SPEC 第 0.1
 * 条就被明令砍掉了（"像鱼还是像系统"）。多一个控件就多一分"管理软件"味。
 *
 * 唯一不能省的是**删**：在那之前，想删一条记忆得自己去编辑 jsonl 文件。
 * 会做这件事的人不需要面板，需要面板的人不会做这件事。
 */
window.__ModuleLoader__.load({
  id: 'feiyu-memory',

  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect } = React;

    /** 侧栏格子的 id，同时也是主面板的 key。**必须与注册时一致。** */
    const PANEL_ID = 'feiyu-diary';
    /** 主机的数据接口前缀，和 host 半边的 PANEL_BASE 必须对得上 */
    const API = '/feiyu-diary';

    /**
     * 主题 token。全部走 CSS 变量，浅色/深色自动跟着切换 ——
     * 这几个 token 的 `requiresLightAndDark` 都是 true，写死颜色就会翻车。
     */
    const C = {
      bg: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      border1: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      text1: 'var(--dsw-alias-label-primary)',
      text2: 'var(--dsw-alias-label-secondary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
      brand: 'var(--dsw-alias-brand-primary)',
    };

    /* ───────────────────────── 图标 ───────────────────────── */

    /**
     * 侧栏图标。owner 会传 `{ size, active }` 进来 ——
     * 这是 `SidebarPanelIconOwnerProps`，别改成别的 props 名。
     */
    function Icon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 20;
      const active = Boolean(props && props.active);
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          role: 'img',
          'aria-label': '肥鱼日记',
          style: { display: 'block', opacity: active ? 1 : 0.72 },
        },
        h('ellipse', {
          cx: 14,
          cy: 12,
          rx: 7.6,
          ry: 5.2,
          stroke: 'currentColor',
          strokeWidth: 1.5,
        }),
        h('path', {
          d: 'M6.9 12 L2 8.2 L2 15.8 Z',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 18.4, cy: 10.6, r: 1.05, fill: 'currentColor' }),
      );
    }

    /* ───────────────────────── 小组件 ───────────────────────── */

    function Section(props) {
      return h(
        'section',
        { style: { marginTop: 22 } },
        h(
          'h3',
          {
            style: {
              margin: '0 0 10px',
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: '0.06em',
              color: C.text2,
            },
          },
          props.title,
        ),
        props.children,
      );
    }

    function Empty(props) {
      return h(
        'p',
        { style: { margin: 0, fontSize: 13, lineHeight: 1.7, color: C.text2 } },
        props.text,
      );
    }

    /* ───────────────────────── 一条日记 ───────────────────────── */

    function Entry(props) {
      const e = props.entry;
      const [confirming, setConfirming] = useState(false);
      const when = dayLabel(e.created_at);

      return h(
        'article',
        {
          style: {
            position: 'relative',
            padding: '12px 14px',
            marginBottom: 8,
            borderRadius: 10,
            background: C.layer1,
            border: `1px solid ${C.border1}`,
          },
        },
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 6,
              fontSize: 11,
              color: C.text2,
            },
          },
          h('span', null, when),
          e.tags && e.tags.length > 0 ? h('span', { style: { opacity: 0.6 } }, '·') : null,
          h('span', null, (e.tags || []).join(' · ')),
        ),
        h(
          'p',
          { style: { margin: 0, fontSize: 13, lineHeight: 1.75, color: C.text1 } },
          e.text,
        ),
        // 「忘掉」—— 这个面板存在的一半理由
        h(
          'div',
          { style: { marginTop: 8, display: 'flex', justifyContent: 'flex-end' } },
          confirming
            ? h(
                'span',
                { style: { display: 'inline-flex', gap: 10, alignItems: 'center', fontSize: 12 } },
                h('span', { style: { color: C.text2 } }, '确定忘掉？'),
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => props.onForget(e.id),
                    style: linkStyle(C.err),
                  },
                  '忘掉',
                ),
                h(
                  'button',
                  { type: 'button', onClick: () => setConfirming(false), style: linkStyle(C.text2) },
                  '算了',
                ),
              )
            : h(
                'button',
                {
                  type: 'button',
                  onClick: () => setConfirming(true),
                  title: '从档案里删掉这一条',
                  style: {
                    ...linkStyle(C.text2),
                    opacity: props.busy ? 0.5 : 0.75,
                  },
                  disabled: Boolean(props.busy),
                },
                '忘掉',
              ),
        ),
      );
    }

    function linkStyle(color) {
      return {
        margin: 0,
        padding: 0,
        border: 0,
        background: 'none',
        color,
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
        textDecoration: 'underline',
        textUnderlineOffset: 3,
      };
    }

    /** 时间说人话：今天 / 昨天 / 3 天前 / 10-05 */
    function dayLabel(ts) {
      if (!Number.isFinite(ts)) return '';
      const startOfDay = (t) => {
        const d = new Date(t);
        d.setHours(0, 0, 0, 0);
        return d.getTime();
      };
      const days = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / 86400000);
      if (days <= 0) return '今天';
      if (days === 1) return '昨天';
      if (days < 7) return `${days} 天前`;
      const d = new Date(ts);
      return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`;
    }

    /* ───────────────────────── 主面板 ───────────────────────── */

    function Panel() {
      const [phase, setPhase] = useState('loading');
      const [state, setState] = useState(null);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState('');
      const [tick, setTick] = useState(0);

      useEffect(() => {
        let alive = true;
        fetch(`${API}/state`, { headers: { Accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then((data) => {
            if (!alive) return;
            setState(data);
            setPhase('ready');
          })
          .catch((err) => {
            if (!alive) return;
            setError(String((err && err.message) || err));
            setPhase('error');
          });
        return () => {
          alive = false;
        };
      }, [tick]);

      function forget(id) {
        setBusy(id);
        fetch(`${API}/forget`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        })
          // ⚠️ **必须检查 r.ok。**
          //
          // 这里原来是 `.then((r) => r.json())` —— 服务端回 400/403 时 JSON 照样
          // 能解析，于是被当成成功，接着刷新一遍、什么都没变。表现就是
          // **「忘掉按钮点不动」**：没有报错、没有删除、没有任何提示。
          //
          // 2026-10-26 社区报的那个 bug，一半就出在这里：把它变成静默。
          .then((r) =>
            r
              .json()
              .catch(() => ({}))
              .then((body) => {
                if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
                return body;
              }),
          )
          .then(() => {
            setBusy('');
            setError('');
            setTick((n) => n + 1);
          })
          .catch((err) => {
            setBusy('');
            setError(`删不掉：${String((err && err.message) || err)}`);
          });
      }

      const wrap = { height: '100%', overflowY: 'auto', background: C.bg, color: C.text1 };
      const inner = { maxWidth: 720, margin: '0 auto', padding: '28px 24px 60px' };

      if (phase === 'loading') {
        return h('div', { style: wrap }, h('div', { style: inner }, h(Empty, { text: '翻档案…' })));
      }
      if (phase === 'error') {
        return h(
          'div',
          { style: wrap },
          h(
            'div',
            { style: inner },
            h(Empty, { text: `读不到档案：${error}` }),
            h(
              'button',
              {
                type: 'button',
                onClick: () => setTick((n) => n + 1),
                style: { ...linkStyle(C.brand), marginTop: 10 },
              },
              '再试一次',
            ),
          ),
        );
      }

      const d = state || {};
      const facts = d.facts || {};
      // traits（印象）2026-10-27 整类下线 —— 面板不显示，固化也不再产出。
      // 数据还在档案里，要看就翻 relationship.json。
      const diary = d.diary || [];

      const head = [];
      head.push(`本地存储 · ${d.count || 0} 条`);
      if (facts.days > 0) head.push(`认识 ${facts.days} 天`);
      if (facts.nickname) head.push(`他管我叫"${facts.nickname}"`);
      if (d.degraded) head.push('档案只读');

      return h(
        'div',
        { style: wrap },
        h(
          'div',
          { style: inner },

          // ── 标题 ──
          h('h2', { style: { margin: 0, fontSize: 18, fontWeight: 600 } }, '肥鱼日记'),
          h(
            'p',
            { style: { margin: '6px 0 0', fontSize: 12, color: C.text2 } },
            head.join(' · '),
          ),

          // ── 出错横幅 ──
          //
          // 之前「忘掉」失败是**完全静默**的：服务端回 400/403，前端把 JSON
          // 当成功、刷新一遍、什么都没变 —— 用户只看到「点不动」。
          // 现在失败会出现在这里，而且带着服务端说的原因。
          error !== ''
            ? h(
                'p',
                {
                  style: {
                    margin: '10px 0 0',
                    padding: '8px 10px',
                    fontSize: 12,
                    lineHeight: 1.6,
                    color: C.err,
                    border: `1px solid ${C.err}`,
                    borderRadius: 6,
                  },
                },
                error,
              )
            : null,

          // ── 「我对他的一些印象」（traits）2026-10-27 整栏下线 ──
          // 注入层、固化侧都删了 —— 面板这里跟着删，不然界面上还挂着一栏，
          // 而它永远不会再有新内容（只能显示砍之前的老数据）。
          // 档案里那些 traits 一个字没删，要看就翻 relationship.json。

          // ── 「我最近常说的」（lexicon）2026-10-27 整栏下线 ──
          // 同一刀：词表不再产出，这栏只剩历史。

          // 「上一棒留下的」那一栏 2026-10-27 整栏下线 ──
          // 档案里那些 about="self" 的 trait 一个字没删，只是不再显示。

          // 「我还欠着他的」那一栏随功能一起删了（2026-10-24）。

          // ── 日记 ──
          h(
            Section,
            { title: '最近的事' },
            diary.length === 0
              ? h(Empty, { text: '还没有日记。多聊几句，我就会有东西可记。' })
              : diary.map((e) => h(Entry, { key: e.id, entry: e, onForget: forget, busy: busy === e.id })),
          ),

          // 「我最近常说的」2026-10-27 整栏下线（见上面）。

          // ── 带走 ──
          h(
            Section,
            { title: '档案' },
            h(
              'a',
              {
                href: `${API}/export`,
                download: '',
                style: { ...linkStyle(C.brand), fontSize: 13 },
              },
              '导出档案（.dshpack）',
            ),
            h(
              'p',
              { style: { margin: '10px 0 0', fontSize: 12, lineHeight: 1.7, color: C.text2 } },
              '它就是一个普通文件夹，在 ~/.dsh/feiyu-diary/。可以直接打开、改、拷走。',
            ),
          ),
        ),
      );
    }

    /* ───────────────────────── 注册 ───────────────────────── */

    function apply(ctx) {
      // 侧栏图标。用**自己的 id** —— 复用别人的 id 会顶掉人家的格子。
      // order 40：排在插件市场(0)和上下文洞察(20)后面，当老三。
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => '肥鱼日记' },
          Icon,
        ),
      );

      // 主面板。key 必须与侧栏的 id 一致 —— 侧栏按钮就是靠这个 key 找面板的。
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel),
      );
    }

    return { name: 'feiyu-memory', inject: ['slots'], apply };
  },
});

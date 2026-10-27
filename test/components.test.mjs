/**
 * 组件层冒烟测试：不装 React，也不开浏览器，但真的把组件函数跑起来。
 *
 * 做法：给 bundle 一个「迷你 react」——createElement 返回纯对象，useState 返回
 * 初始值，useEffect 当场执行，useRef 按调用序号保留同一个 ref（跨两次渲染，
 * 相当于组件实例存活）。于是可以验证：
 *   - 引擎在两次快照之间真的把「跑完了」变成了一条系统通知；
 *   - 铃铛/面板的渲染路径不抛错，按钮、勾选框、状态文案接的是对的回调；
 *   - 勾选框改设置真的落盘，面板开合走的是同一个 store。
 *
 * 它不验证 React 的调度细节（那是框架的事），只验证「我的接线对不对」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/** 迷你 react：够跑本插件的组件，不模拟并发。 */
function makeMiniReact() {
  const refs = [];
  const effects = [];
  let refIndex = 0;
  const impl = {
    Fragment: Symbol('Fragment'),
    createElement(type, props) {
      const children = Array.prototype.slice.call(arguments, 2);
      const merged = Object.assign({}, props || {});
      if (children.length === 1) merged.children = children[0];
      else if (children.length > 1) merged.children = children;
      return { type, props: merged };
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, function noop() {}];
    },
    useEffect(fn) {
      effects.push(fn);
    },
    useRef(value) {
      const index = refIndex++;
      if (!(index in refs)) refs[index] = { current: value };
      return refs[index];
    },
  };
  return {
    impl,
    /** 一次「渲染」：重置钩子序号，跑完所有 effect。 */
    render(component, props) {
      refIndex = 0;
      effects.length = 0;
      const tree = component(props);
      effects.forEach((fn) => fn());
      return tree;
    },
  };
}

function makeNotification(permission = 'granted') {
  const calls = [];
  class FakeNotification {
    constructor(title, options) {
      this.title = title;
      this.options = options || {};
      calls.push(this);
    }
    close() {}
  }
  FakeNotification.permission = permission;
  FakeNotification.calls = calls;
  FakeNotification.requestPermission = () => Promise.resolve('granted');
  return FakeNotification;
}

function makeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    map,
  };
}

function loadPlugin({ permission = 'granted', focused = false } = {}) {
  const storage = makeStorage();
  const Notification = makeNotification(permission);
  const document = {
    visibilityState: 'visible',
    hasFocus: () => focused,
    head: { appendChild() {} },
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    addEventListener() {},
    removeEventListener() {},
  };
  const window = {
    document,
    Notification,
    localStorage: storage,
    setTimeout: () => 0,
    addEventListener() {},
    removeEventListener() {},
  };

  let entry;
  window.__ModuleLoader__ = { load: (value) => (entry = value) };
  const sandbox = { window, document, console };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'dsh-notify-on-done/lib/client.js' });

  const mini = makeMiniReact();
  const exported = entry.factory((specifier) => {
    if (specifier !== 'react') throw new Error('unexpected require: ' + specifier);
    return mini.impl;
  });

  return { exported, mini, storage, Notification, document };
}

/** 深度遍历元素树（含字符串节点），遇到函数组件也调用一次看下去。 */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit));
    return;
  }
  if (typeof node === 'string' || typeof node === 'number') {
    visit({ text: String(node) });
    return;
  }
  if (typeof node !== 'object') return;
  visit(node);
  const children = node.props && node.props.children;
  if (children !== undefined) walk(children, visit);
}

function collect(node, predicate) {
  const found = [];
  walk(node, (item) => {
    if (!item.text && predicate(item)) found.push(item);
  });
  return found;
}

function texts(node) {
  const out = [];
  walk(node, (item) => {
    if (item.text) out.push(item.text);
  });
  return out;
}

function listState(running) {
  return {
    ids: ['s1'],
    byId: { s1: { id: 's1', title: '重构重试逻辑', running, blank: false } },
  };
}

test('引擎：两次快照之间「跑完了」→ 一条系统通知', () => {
  const { exported, mini, Notification } = loadPlugin();
  const components = exported.__test.components;

  const statuses = new Map();
  const props = {
    useSessions: (selector) => selector(listState(true)),
    useSessionStatus: (selector) => selector(statuses),
  };

  // 第一帧：正在跑 → 只记账。
  mini.render(components.NotifyEngine, props);
  assert.equal(Notification.calls.length, 0, '基线帧不许补报');

  // 第二帧：跑完了 → 弹通知。
  const finished = {
    useSessions: (selector) => selector(listState(false)),
    useSessionStatus: (selector) => selector(statuses),
  };
  mini.render(components.NotifyEngine, finished);
  assert.equal(Notification.calls.length, 1);
  assert.match(Notification.calls[0].title, /回答完成/);
  assert.match(Notification.calls[0].options.body, /重构重试逻辑/);
});

test('铃铛：需要权限时带小圆点，点击开面板', () => {
  const { exported, mini } = loadPlugin({ permission: 'default' });
  const NotifyBell = exported.__test.components.NotifyBell;
  const panelStore = exported.__test.panelStore;

  const tree = mini.render(NotifyBell, {});
  assert.ok(tree.props.className.includes('dshnod-bell'));
  const dot = collect(tree, (item) => item.props && item.props.className === 'dshnod-dot');
  assert.equal(dot.length, 1, '未授权时铃铛要有提示点');

  const before = panelStore.value;
  tree.props.onClick();
  assert.equal(panelStore.value, !before, '点击铃铛切换面板');
  exported.__test.setPanelOpen(false);
});

test('铃铛：已授权时不带提示点', () => {
  const { exported, mini } = loadPlugin({ permission: 'granted' });
  const tree = mini.render(exported.__test.components.NotifyBell, {});
  assert.equal(
    collect(tree, (item) => item.props && item.props.className === 'dshnod-dot').length,
    0,
  );
});

test('面板：权限/开关/测试按钮按状态渲染，勾选框落到设置', () => {
  const denied = loadPlugin({ permission: 'denied' });
  const panel = denied.mini.render(denied.exported.__test.components.SettingsPanel, {
    settings: { ...denied.exported.__test.DEFAULTS },
  });

  const copy = texts(panel);
  assert.ok(copy.includes('完成提醒'), '面板要有标题');
  assert.ok(
    copy.some((text) => text.includes('已拒绝')),
    '被拒绝时要说明原因：' + JSON.stringify(copy),
  );

  const Check = denied.exported.__test.components.Check;
  const boxes = collect(panel, (item) => item.type === Check);
  assert.equal(boxes.length, 5, '五项开关');

  // 第一项勾选 → 设置里 enabled 关闭（Check 只是包一层 label，直接展开看 input）。
  const label = Check(boxes[0].props);
  assert.equal(label.type, 'label');
  const [input] = collect(label, (item) => item.type === 'input');
  assert.equal(input.props.checked, true);
  input.props.onChange({ target: { checked: false } });
  assert.equal(denied.exported.__test.readSettings().enabled, false);
  assert.equal(denied.storage.getItem('dsh-notify-on-done:settings').includes('"enabled":false'), true);

  // 兜底按钮：点了要有站内浮层。
  const fallback = collect(panel, (item) => item.type === 'button' && texts(item).some((t) => t.includes('浮层')));
  assert.equal(fallback.length, 1);
  fallback[0].props.onClick();
  assert.equal(denied.exported.__test.toastStore.value.length, 1, '点兜底按钮要看到浮层');
});

test('面板：已授权时给「测试通知」，点击真的弹', () => {
  const granted = loadPlugin({ permission: 'granted' });
  const panel = granted.mini.render(granted.exported.__test.components.SettingsPanel, {
    settings: { ...granted.exported.__test.DEFAULTS },
  });

  const copy = texts(panel);
  assert.ok(copy.some((text) => text.includes('已开启')), '授权后状态文案：' + JSON.stringify(copy));

  const testButton = collect(
    panel,
    (item) => item.type === 'button' && texts(item).some((t) => t.includes('测试通知')),
  );
  assert.equal(testButton.length, 1);
  testButton[0].props.onClick();
  assert.equal(granted.Notification.calls.length, 1);
  assert.match(granted.Notification.calls[0].title, /测试通知/);
});

test('浮层：列出自带关闭按钮', () => {
  const { exported, mini } = loadPlugin({ permission: 'denied' });
  exported.__test.pushToast({ title: 'dsh · 回答完成', body: '「x」已完成', sessionId: 's1' });
  const stack = mini.render(exported.__test.components.ToastStack, {
    toasts: exported.__test.toastStore.value,
  });
  const copy = texts(stack);
  assert.ok(copy.includes('dsh · 回答完成'));
  const close = collect(stack, (item) => item.type === 'button');
  assert.equal(close.length, 1);
  close[0].props.onClick();
  assert.equal(exported.__test.toastStore.value.length, 0);
});

test('测试按钮：每次点击用不同 tag（同 tag 只会替换旧通知，第二次不再弹）', () => {
  const { exported, mini, Notification } = loadPlugin({ permission: 'granted' });
  const panel = mini.render(exported.__test.components.SettingsPanel, {
    settings: { ...exported.__test.DEFAULTS },
  });
  const [button] = collect(
    panel,
    (item) => item.type === 'button' && texts(item).some((text) => text.includes('测试通知')),
  );

  button.props.onClick();
  button.props.onClick();

  assert.equal(Notification.calls.length, 2);
  assert.notEqual(
    Notification.calls[0].options.tag,
    Notification.calls[1].options.tag,
    '两次测试通知不能共用 tag，否则 Windows 只替换不提醒',
  );
  assert.equal(exported.__test.lastNotificationError(), '');
});

test('权限过期：面板以为已授权、浏览器其实已拒绝 → 记原因并走兜底，不静默', () => {
  const { exported, mini, Notification } = loadPlugin({ permission: 'granted' });
  // 用户在站点设置里改成了「禁止」，但面板还没刷新
  Notification.permission = 'denied';

  const panel = mini.render(exported.__test.components.SettingsPanel, {
    settings: { ...exported.__test.DEFAULTS },
  });
  const [button] = collect(
    panel,
    (item) => item.type === 'button' && texts(item).some((text) => text.includes('测试通知')),
  );

  const before = exported.__test.toastStore.value.length;
  button.props.onClick();

  assert.equal(Notification.calls.length, 0, '权限不是 granted 时不许构造通知');
  assert.match(exported.__test.lastNotificationError(), /denied/);
  assert.equal(exported.__test.toastStore.value.length, before + 1, '必须落到站内浮层');
});

test('面板诊断行：权限 / 安全上下文 / 窗口聚焦 都写出来', () => {
  const { exported, mini } = loadPlugin({ permission: 'granted' });
  const panel = mini.render(exported.__test.components.SettingsPanel, {
    settings: { ...exported.__test.DEFAULTS },
  });
  const diag = texts(panel).find((text) => text.startsWith('权限 '));
  assert.ok(diag, '诊断行缺失');
  assert.match(diag, /安全上下文/);
  assert.match(diag, /窗口聚焦/);
});

/**
 * dsh-notify-on-done 单测：不开浏览器也能验证「谁在什么时候该弹什么」。
 *
 * 做法：把 lib/client.js 当成浏览器里的那个 bundle —— 喂一个假的
 * `window.__ModuleLoader__` + 假 react 把 factory 跑起来，然后直接打纯逻辑
 * （collectRows / advance / decide / deliver）和注册接线（apply → slots）。
 *
 * 覆盖的是最容易出错的判断，而不是渲染像素：
 *   - 页面刚开时正在跑的对话不能补报；子代理会话不能提醒；
 *   - running true→false 的多标签页判定、待确认交互的首次出现；
 *   - 聚焦状态、总开关、单项开关的抑制；
 *   - 系统通知失败时必须落到站内浮层 + 提示音，不能静默。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/** 假 Notification 类，记录构造参数，permission 可写。 */
function makeNotification(permission = 'granted') {
  const calls = [];
  class FakeNotification {
    constructor(title, options) {
      this.title = title;
      this.options = options || {};
      this.closed = false;
      calls.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  FakeNotification.permission = permission;
  FakeNotification.calls = calls;
  FakeNotification.requestPermission = () => {
    FakeNotification.permission = 'granted';
    return Promise.resolve('granted');
  };
  return FakeNotification;
}

/** 假 localStorage。 */
function makeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
    map,
  };
}

/**
 * 在独立的 vm realm 里把 bundle 跑起来。
 * @param {{permission?: string, focused?: boolean, storage?: object}} options
 */
function loadPlugin(options = {}) {
  const permission = options.permission ?? 'granted';
  const storage = options.storage ?? makeStorage();
  const Notification = permission === 'unsupported' ? undefined : makeNotification(permission);

  const styles = [];
  const document = {
    visibilityState: 'visible',
    hasFocus: () => options.focused === true,
    head: { appendChild: (node) => styles.push(node) },
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    addEventListener() {},
    removeEventListener() {},
  };
  const window = {
    document,
    Notification,
    localStorage: storage,
    // 浮层的自动消失定时器在单测里不必真跑（否则测试进程要多等 9 秒）。
    setTimeout: () => 0,
  };

  let entry;
  window.__ModuleLoader__ = {
    load: (value) => {
      entry = value;
    },
  };

  const sandbox = { window, document, console, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'dsh-notify-on-done/lib/client.js' });

  assert.ok(entry, 'bundle 必须调用 window.__ModuleLoader__.load');
  assert.equal(entry.id, 'dsh-notify-on-done');

  const fakeReact = {
    createElement: () => null,
    Fragment: 'Fragment',
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
  };
  const exported = entry.factory((specifier) => {
    assert.equal(specifier, 'react', 'bundle 只能 require 基座播种的 react');
    return fakeReact;
  });

  return { exported, storage, Notification, styles, document, window };
}

/** 一行会话。 */
function row(id, patch = {}) {
  return {
    id,
    title: '会话 ' + id,
    blank: false,
    running: false,
    pending: '',
    ...patch,
  };
}

test('bundle 契约：id / apply / inject / name', () => {
  const { exported } = loadPlugin();
  assert.equal(exported.name, 'dsh-notify-on-done');
  assert.equal(typeof exported.apply, 'function');
  assert.deepEqual(Array.from(exported.inject), ['slots']);
});

test('样式只注入一次（就地带上，无需构建产物）', () => {
  const { styles } = loadPlugin();
  assert.equal(styles.length, 1, 'factory 物化时应注入一次样式');
  assert.equal(styles[0].dataset.pluginCss, 'dsh-notify-on-done');
  assert.match(styles[0].textContent, /\.dshnod-panel/);
});

test('apply 把引擎挂进 shell.overlay、把铃铛挂进会话头部', () => {
  const { exported } = loadPlugin();
  const registered = [];
  const injected = [];
  const ctx = {
    slots: {
      inject(key, callback) {
        injected.push(key);
        const dispose = callback();
        return () => dispose();
      },
      register(options, component) {
        registered.push({ options, component });
        return () => {};
      },
    },
  };
  exported.apply(ctx);

  assert.deepEqual(injected, ['shell.overlay', 'conversation.session.header.utilities']);
  assert.equal(registered.length, 2);
  assert.equal(registered[0].options.name, 'shell.overlay');
  assert.equal(registered[0].options.id, 'dsh-notify-on-done.engine');
  assert.equal(registered[1].options.id, 'dsh-notify-on-done.bell');
  assert.equal(typeof registered[0].component, 'function');
  assert.equal(typeof registered[1].component, 'function');
});

test('collectRows：读官方快照、过滤子代理、status 覆盖 list、标题回退', () => {
  const { exported } = loadPlugin();
  const list = {
    ids: ['a', 'b', 'c'],
    byId: {
      a: { id: 'a', title: '  标题A  ', running: false, blank: false },
      b: { id: 'b', displayTitle: '项目名', running: true, blank: false },
      c: { id: 'c', title: '子代理', running: true, origin: 'subagent' },
    },
  };
  const statuses = new Map([
    ['a', { running: true, pendingInteraction: { kind: 'question' } }],
    ['b', { running: false, pendingInteraction: { kind: 'unrelated' } }],
  ]);

  const rows = exported.__test.collectRows(list, statuses);
  assert.deepEqual(
    Array.from(rows, (item) => item.id),
    ['a', 'b'],
    'origin=subagent 的派生会话必须被排除',
  );
  assert.equal(rows[0].title, '标题A');
  assert.equal(rows[0].running, true, 'status.running 优先于 list 的兜底值');
  assert.equal(rows[0].pending, 'question');
  assert.equal(rows[1].title, '项目名', '没有 durable title 时用 displayTitle');
  assert.equal(rows[1].running, false);
  assert.equal(rows[1].pending, '', '非导航可见的交互类型不算待确认');

  // 没有 status 时退回 summary.running；空快照不炸。
  assert.equal(exported.__test.collectRows(list, undefined)[1].running, true);
  assert.deepEqual(Array.from(exported.__test.collectRows(undefined, undefined)), []);
});

test('advance：首次见到正在跑的会话不补报，结束后报完成并带用时', () => {
  const { exported } = loadPlugin();
  const { advance } = exported.__test;

  // 页面刚打开，会话正在跑：只记账。
  const first = advance(new Map(), [row('a', { running: true })], 1000);
  assert.deepEqual(Array.from(first.events), []);
  assert.equal(first.state.get('a').since, 1000);

  // 跑完：一条 completed，用时 = 现在 - 开始。
  const second = advance(first.state, [row('a', { running: false })], 61000);
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].kind, 'completed');
  assert.equal(second.events[0].durationMs, 60000);

  // 再走一步没有新事件（幂等）。
  const third = advance(second.state, [row('a', { running: false })], 62000);
  assert.deepEqual(Array.from(third.events), []);
});

test('advance：同一帧里跑完（false→false）不冒事件，新会话开始也不提醒', () => {
  const { exported } = loadPlugin();
  const { advance } = exported.__test;

  const base = advance(new Map(), [row('a'), row('b')], 0);
  assert.deepEqual(Array.from(base.events), []);

  // b 开始跑：状态机记下 started（decide 会在落地前把它丢掉，见下一个用例）。
  const started = advance(base.state, [row('a'), row('b', { running: true })], 100);
  assert.deepEqual(
    Array.from(started.events, (event) => event.kind),
    ['started'],
  );
  assert.equal(started.state.get('b').since, 100);
  assert.equal(exported.__test.decide(started.events[0], exported.__test.DEFAULTS, { focused: false }), null);

  // 空会话（blank）跑完不提醒。
  const blank = advance(started.state, [row('a'), row('b', { running: false, blank: true })], 200);
  assert.deepEqual(Array.from(blank.events), []);
});

test('advance：待确认交互只在「从无到有」时报一次', () => {
  const { exported } = loadPlugin();
  const { advance } = exported.__test;

  const base = advance(new Map(), [row('a')], 0);
  const asked = advance(base.state, [row('a', { pending: 'question' })], 10);
  assert.equal(asked.events.length, 1);
  assert.equal(asked.events[0].kind, 'pending');
  assert.equal(asked.events[0].pending, 'question');

  const still = advance(asked.state, [row('a', { pending: 'question' })], 20);
  assert.deepEqual(Array.from(still.events), []);

  const gone = advance(still.state, [row('a')], 30);
  assert.deepEqual(Array.from(gone.events), []);
});

test('decide：开关与聚焦状态的抑制矩阵', () => {
  const { exported } = loadPlugin();
  const { decide, DEFAULTS } = exported.__test;
  const settings = { ...DEFAULTS };
  const completed = { kind: 'completed', id: 'a', title: '会话', durationMs: 125000 };

  assert.equal(decide(completed, settings, { focused: true }), null, '前台不打扰');
  assert.equal(decide(completed, { ...settings, onlyWhenUnfocused: false }, { focused: true }).title.includes('回答完成'), true);
  assert.equal(decide(completed, { ...settings, enabled: false }, { focused: false }), null, '总开关');
  assert.equal(decide({ kind: 'started', id: 'a' }, settings, { focused: false }), null, '启动不提醒');

  const pending = { kind: 'pending', id: 'a', title: '会话', pending: 'approval' };
  assert.equal(decide(pending, { ...settings, notifyPending: false }, { focused: false }), null);
  assert.match(decide(pending, settings, { focused: false }).body, /等你批准/);
});

test('载荷文案：用时格式与标题兜底', () => {
  const { exported } = loadPlugin();
  const { decide, formatDuration } = exported.__test;
  const settings = { ...exported.__test.DEFAULTS };

  assert.equal(formatDuration(800), '1 秒');
  assert.equal(formatDuration(59000), '59 秒');
  assert.equal(formatDuration(60000), '1 分');
  assert.equal(formatDuration(125000), '2 分 5 秒');

  const payload = decide({ kind: 'completed', id: 's1', title: '', durationMs: 61000 }, settings, {
    focused: false,
  });
  assert.equal(payload.title, 'dsh · 回答完成');
  assert.match(payload.body, /当前会话/);
  assert.match(payload.body, /1 分 1 秒/);
  assert.equal(payload.tag, 'dsh-notify-on-done-s1-completed');

  const long = decide(
    { kind: 'completed', id: 's2', title: 'x'.repeat(80), durationMs: 1000 },
    settings,
    { focused: false },
  );
  assert.ok(long.body.length < 100, '过长的标题要截断，通知体不能爆');
  assert.match(long.body, /…/);
});

test('系统通知：未授权/不支持一律返回 false，交给兜底', () => {
  const denied = loadPlugin({ permission: 'denied' });
  assert.equal(
    denied.exported.__test.showSystemNotification({ title: 't', body: 'b' }),
    false,
  );

  const unsupported = loadPlugin({ permission: 'unsupported' });
  assert.equal(unsupported.exported.__test.currentPermission(), 'unsupported');
  assert.equal(
    unsupported.exported.__test.showSystemNotification({ title: 't', body: 'b' }),
    false,
  );
});

test('系统通知：授权后真的 new 出来，并接上点击聚焦', () => {
  const granted = loadPlugin({ permission: 'granted' });
  assert.equal(granted.exported.__test.currentPermission(), 'granted');

  const payload = { title: 'dsh · 回答完成', body: '「x」已完成', tag: 'tag-1', sessionId: 's1', kind: 'completed' };
  assert.equal(granted.exported.__test.showSystemNotification(payload), true);

  const [notification] = granted.Notification.calls;
  assert.equal(notification.title, 'dsh · 回答完成');
  assert.equal(notification.options.body, '「x」已完成');
  assert.equal(notification.options.tag, 'tag-1');

  let focused = false;
  granted.window.focus = () => {
    focused = true;
  };
  notification.onclick();
  assert.equal(focused, true);
  assert.equal(notification.closed, true);
});

test('deliver：有权限走系统通知（不刷站内浮层），没权限落到浮层兜底', () => {
  const granted = loadPlugin({ permission: 'granted', focused: false });
  const settings = { ...granted.exported.__test.DEFAULTS };
  const event = { kind: 'completed', id: 's1', title: '会话', durationMs: 5000 };

  const payload = granted.exported.__test.deliver(event, settings, 1000);
  assert.ok(payload, '该提醒时要提醒');
  assert.equal(granted.Notification.calls.length, 1);
  assert.equal(granted.exported.__test.toastStore.value.length, 0, '有系统通知就不再刷浮层');

  const offline = loadPlugin({ permission: 'denied', focused: false });
  const offlineSettings = { ...offline.exported.__test.DEFAULTS };
  const offlinePayload = offline.exported.__test.deliver(
    { kind: 'pending', id: 's2', title: '会话', pending: 'question' },
    offlineSettings,
    1000,
  );
  assert.ok(offlinePayload, '兜底也算提醒过了');
  assert.equal(offline.exported.__test.toastStore.value.length, 1);
  assert.match(offline.exported.__test.toastStore.value[0].body, /等你回答/);
});

test('deliver：前台 / 关闭时静默', () => {
  const focused = loadPlugin({ permission: 'granted', focused: true });
  const settings = { ...focused.exported.__test.DEFAULTS };
  const event = { kind: 'completed', id: 's1', title: '会话', durationMs: 5000 };
  assert.equal(focused.exported.__test.deliver(event, settings, 1000), null);
  assert.equal(focused.Notification.calls.length, 0);

  const off = loadPlugin({ permission: 'granted', focused: false });
  assert.equal(off.exported.__test.deliver(event, { ...settings, enabled: false }, 1000), null);
  assert.equal(off.Notification.calls.length, 0);
});

test('多标签页去重：8 秒内同一会话只弹一次', () => {
  const storage = makeStorage();
  const tabA = loadPlugin({ permission: 'granted', focused: false, storage });
  const tabB = loadPlugin({ permission: 'granted', focused: false, storage });
  const event = { kind: 'completed', id: 's1', title: '会话', durationMs: 1000 };

  assert.ok(tabA.exported.__test.deliver(event, { ...tabA.exported.__test.DEFAULTS }, 10000));
  assert.equal(tabB.exported.__test.deliver(event, { ...tabB.exported.__test.DEFAULTS }, 12000), null);
  assert.equal(tabB.Notification.calls.length, 0, '第二个标签页不许重复弹');

  // 过了去重窗口，恢复。
  assert.ok(tabB.exported.__test.deliver(event, { ...tabB.exported.__test.DEFAULTS }, 30000));
});

test('设置：默认值、落盘、脏数据不炸', () => {
  const storage = makeStorage();
  storage.setItem('dsh-notify-on-done:settings', '{ not json');
  const first = loadPlugin({ storage });
  assert.equal(first.exported.__test.readSettings().enabled, true, '坏 JSON 退回默认值');

  const updated = first.exported.__test.writeSettings({ onlyWhenUnfocused: false, sound: false });
  assert.equal(updated.onlyWhenUnfocused, false);
  assert.equal(JSON.parse(storage.getItem('dsh-notify-on-done:settings')).sound, false);
  assert.equal(first.exported.__test.readSettings().onlyWhenUnfocused, false);
});

test('真实提醒：同一会话连续两次完成 → 两条不同 tag，且旧的一条被关掉', () => {
  const { exported, Notification } = loadPlugin({ permission: 'granted', focused: false });
  const settings = { ...exported.__test.DEFAULTS };
  const event = { kind: 'completed', id: 's1', title: '会话', durationMs: 5000 };

  assert.ok(exported.__test.deliver(event, settings, 1_000_000));
  // 第二次必须过了跨标签页去重窗口（8s）才允许再提醒
  assert.ok(exported.__test.deliver(event, settings, 1_020_000));

  assert.equal(Notification.calls.length, 2);
  assert.notEqual(
    Notification.calls[0].options.tag,
    Notification.calls[1].options.tag,
    '同一个会话两次完成不能共用 tag —— Windows 会当成「原地更新」，只进通知中心不弹横幅',
  );
  assert.equal(Notification.calls[0].closed, true, '上一条同会话通知要关掉，通知中心只留最新');
  assert.equal(Notification.calls[1].closed, false);
});

test('真实提醒：不同会话各自保留，互不关闭', () => {
  const { exported, Notification } = loadPlugin({ permission: 'granted', focused: false });
  const settings = { ...exported.__test.DEFAULTS };

  exported.__test.deliver({ kind: 'completed', id: 's1', title: '一', durationMs: 1000 }, settings, 1000);
  exported.__test.deliver({ kind: 'completed', id: 's2', title: '二', durationMs: 1000 }, settings, 1001);

  assert.equal(Notification.calls.length, 2);
  assert.equal(Notification.calls[0].closed, false, '另一个会话的通知不该被关掉');
  assert.equal(Notification.calls[1].closed, false);
});

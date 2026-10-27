/**
 * dsh-notify-on-done — 对话结束 / 需要你确认时的桌面提醒（client 半）
 *
 * 目标：dsh 网页端在一轮对话结束后弹一条**系统通知**（Windows 上是右下角
 * toast，走浏览器/Edge/Chrome 的系统通知通道），不用一直盯着页面。
 *
 * 为什么放在浏览器里做：dsh web 的宿主可能跑在别的机器（WSL / 远程 / 容器）
 * 上，宿主机弹窗到不了你屏幕；而**通知必须发生在你正在看的那个浏览器里**。
 * 浏览器 Notification API 在 Windows 上直接由系统投递（Windows 11 通知中心），
 * 无需任何本地依赖。
 *
 * 数据来源（不猜 DOM，只读官方状态）：
 *   - props.useSessions   — 会话列表快照（byId[id].running / title / blank / origin）
 *   - props.useSessionStatus — 会话 UI 状态（running / pendingInteraction）
 * 这两个是 `shell.overlay` 与 header 槽位都会拿到的「标准套件」钩子，
 * 由基础座统一播种，因此不需要任何跨包依赖。
 *
 * 通知规则（可在面板里改）：
 *   1. running true→false            → 「回答完成」（带用时）
 *   2. pendingInteraction 从无到有   → 「需要你的确认」（提问 / 审批 / 计划复核）
 *   3. 派生会话（origin=subagent）不提醒；页面首次挂载时正在跑的会话不补报；
 *   4. 默认只在窗口不聚焦时提醒（页面就在眼前时不打扰）；
 *   5. 未授权 / 不支持系统通知时：站内浮层 + 提示音兜底（三选一，绝不静默丢失）；
 *   6. 多标签页打开同一会话时用 localStorage 时间戳去重，避免连环弹。
 *
 * 形态（零构建、零三方依赖，手写 `__ModuleLoader__` CJS bundle）：
 *   - `shell.overlay`（root 列表槽）      → 提醒引擎 + 站内浮层 + 设置面板
 *   - `conversation.session.header.utilities`（会话头部右侧列表槽）→ 铃铛按钮
 * 只 require("react")（基座播种），图标是内联 SVG，样式是自带 <style>。
 */
window.__ModuleLoader__.load({
  id: "dsh-notify-on-done",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var h = react.createElement;

    // #region 常量
    /** localStorage 前缀；改这里等于把用户设置重置一次。 */
    var PLUGIN_ID = "dsh-notify-on-done";
    var SETTINGS_KEY = PLUGIN_ID + ":settings";
    var DEDUPE_PREFIX = PLUGIN_ID + ":sent:";
    /** 多标签页去重窗口：8 秒内同一会话只弹一次。 */
    var DEDUPE_WINDOW_MS = 8000;
    var TOAST_MS = 9000;
    var PRODUCT = "dsh";

    /** 默认设置（面板里改，写 localStorage）。 */
    var DEFAULTS = {
      /** 总开关。 */
      enabled: true,
      /** 只在窗口不聚焦时提醒（页面在前台就不打扰）。 */
      onlyWhenUnfocused: true,
      /** 「需要你确认」也提醒。 */
      notifyPending: true,
      /** 没有系统通知时用提示音兜底。 */
      sound: true,
      /** 首次点击页面时顺手申请一次通知权限（避免用户忘了点铃铛）。 */
      autoRequest: true,
    };

    var PENDING_TEXT = {
      question: "有一个问题等你回答",
      approval: "有一条操作等你批准",
      "plan-review": "有一份计划等你确认",
    };
    // #endregion

    // #region 小工具
    function win() {
      return typeof window === "undefined" ? undefined : window;
    }

    function doc() {
      var w = win();
      return w && w.document ? w.document : undefined;
    }

    /** localStorage 在隐私模式 / 被禁用时会直接抛异常，一律降级为「没有存储」。 */
    function storage() {
      var w = win();
      if (!w) return undefined;
      try {
        var s = w.localStorage;
        if (!s || typeof s.getItem !== "function") return undefined;
        return s;
      } catch (error) {
        return undefined;
      }
    }

    function clampText(value, max) {
      var text = typeof value === "string" ? value.trim() : "";
      if (text.length <= max) return text;
      return text.slice(0, max - 1) + "…";
    }

    /** 毫秒 → 「1 分 12 秒」/「8 秒」。 */
    function formatDuration(ms) {
      var total = Math.max(0, Math.round((typeof ms === "number" ? ms : 0) / 1000));
      if (total < 60) return Math.max(1, total) + " 秒";
      var minutes = Math.floor(total / 60);
      var seconds = total % 60;
      if (seconds === 0) return minutes + " 分";
      return minutes + " 分 " + seconds + " 秒";
    }

    /** 订阅器三件套：不引状态库，够用就行。 */
    function createStore(value) {
      return { value: value, listeners: [] };
    }

    function subscribeStore(store, fn) {
      store.listeners.push(fn);
      return function () {
        var index = store.listeners.indexOf(fn);
        if (index >= 0) store.listeners.splice(index, 1);
      };
    }

    function emitStore(store) {
      var value = store.value;
      store.listeners.slice().forEach(function (fn) {
        try {
          fn(value);
        } catch (error) {
          /* 单个订阅者出错不影响其他订阅者 */
        }
      });
    }

    /** useState + 订阅：React 18/19 都能跑，不依赖 useSyncExternalStore。 */
    function useStoreValue(store) {
      var pair = react.useState(store.value);
      var value = pair[0];
      var setValue = pair[1];
      react.useEffect(function () {
        var off = subscribeStore(store, setValue);
        setValue(store.value);
        return off;
      }, []);
      return value;
    }
    // #endregion

    // #region 设置
    // 注意：settingsStore 在下面几个函数定义之后才初始化（函数声明会提升）。
    function mergeSettings(base, patch) {
      var next = {};
      for (var key in DEFAULTS) next[key] = base[key] === true;
      if (patch && typeof patch === "object") {
        for (var key2 in DEFAULTS) {
          if (typeof patch[key2] === "boolean") next[key2] = patch[key2];
        }
      }
      return next;
    }

    function readSettings() {
      var base = mergeSettings(DEFAULTS, undefined);
      var store = storage();
      if (!store) return base;
      try {
        var raw = store.getItem(SETTINGS_KEY);
        if (!raw) return base;
        var parsed = JSON.parse(raw);
        return mergeSettings(base, parsed);
      } catch (error) {
        return base;
      }
    }

    function writeSettings(patch) {
      var next = mergeSettings(settingsStore.value, patch);
      settingsStore.value = next;
      var store = storage();
      if (store) {
        try {
          store.setItem(SETTINGS_KEY, JSON.stringify(next));
        } catch (error) {
          /* 配额/隐私模式：内存里生效即可 */
        }
      }
      emitStore(settingsStore);
      return next;
    }

    function useSettings() {
      return useStoreValue(settingsStore);
    }

    /** 全局设置单例：读一次 localStorage，之后由 writeSettings 广播给所有订阅者。 */
    var settingsStore = createStore(readSettings());
    // #endregion

    // #region 权限
    /** 'granted' | 'default' | 'denied' | 'unsupported' */
    function currentPermission() {
      var w = win();
      var N = w && w.Notification;
      if (typeof N !== "function") return "unsupported";
      var value = N.permission;
      if (value === "granted" || value === "denied" || value === "default") return value;
      return "default";
    }

    var permissionStore = createStore(currentPermission());

    function refreshPermission() {
      var next = currentPermission();
      if (next === permissionStore.value) return next;
      permissionStore.value = next;
      emitStore(permissionStore);
      return next;
    }

    function usePermission() {
      return useStoreValue(permissionStore);
    }

    function requestPermission() {
      var w = win();
      var N = w && w.Notification;
      if (!N || typeof N.requestPermission !== "function") {
        return Promise.resolve("unsupported");
      }
      try {
        var result = N.requestPermission();
        if (result && typeof result.then === "function") {
          return result.then(
            function (value) {
              refreshPermission();
              return value;
            },
            function () {
              refreshPermission();
              return "denied";
            },
          );
        }
        refreshPermission();
        return Promise.resolve(N.permission);
      } catch (error) {
        refreshPermission();
        return Promise.resolve("denied");
      }
    }
    // #endregion

    // #region 系统通知 / 声音 / 站内浮层
    /** 最后一条通知留个引用，避免个别浏览器在 GC 时提前收走 onclick。 */
    var lastNotification;

    /** 真正弹系统通知；返回是否弹成功（权限、环境、构造函数都可能失败）。 */
    function showSystemNotification(payload) {
      var w = win();
      var N = w && w.Notification;
      if (!N || N.permission !== "granted") return false;
      try {
        var notification = new N(payload.title, {
          body: payload.body,
          tag: payload.tag,
          data: { sessionId: payload.sessionId, kind: payload.kind },
        });
        notification.onclick = function () {
          try {
            if (w.focus) w.focus();
            notification.close();
          } catch (error) {
            /* 关不掉就算了 */
          }
        };
        lastNotification = notification;
        return true;
      } catch (error) {
        return false;
      }
    }

    var audioContext;

    /** 两短音：没有系统通知时的听觉兜底（首次需要一次用户手势才能出声）。 */
    function beep() {
      var w = win();
      if (!w) return;
      try {
        var Ctor = w.AudioContext || w.webkitAudioContext;
        if (!Ctor) return;
        if (!audioContext) audioContext = new Ctor();
        if (audioContext.state === "suspended" && audioContext.resume) audioContext.resume();
        var start = audioContext.currentTime;
        [880, 1320].forEach(function (frequency, index) {
          var oscillator = audioContext.createOscillator();
          var gain = audioContext.createGain();
          var at = start + index * 0.16;
          oscillator.type = "sine";
          oscillator.frequency.value = frequency;
          gain.gain.setValueAtTime(0.0001, at);
          gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.14);
          oscillator.connect(gain);
          gain.connect(audioContext.destination);
          oscillator.start(at);
          oscillator.stop(at + 0.15);
        });
      } catch (error) {
        /* 没有 WebAudio / 被策略拦：静默 */
      }
    }

    var toastStore = createStore([]);
    var toastSeq = 0;

    function pushToast(payload) {
      var id = ++toastSeq;
      var next = toastStore.value.concat([
        { id: id, title: payload.title, body: payload.body, sessionId: payload.sessionId },
      ]);
      toastStore.value = next.slice(-3);
      emitStore(toastStore);
      var w = win();
      if (w && typeof w.setTimeout === "function") {
        w.setTimeout(function () {
          dismissToast(id);
        }, TOAST_MS);
      }
    }

    function dismissToast(id) {
      var next = toastStore.value.filter(function (item) {
        return item.id !== id;
      });
      if (next.length === toastStore.value.length) return;
      toastStore.value = next;
      emitStore(toastStore);
    }

    /** 跨标签页去重：另一个标签页刚提醒过就闭嘴。 */
    function claimNotification(sessionId, now) {
      var store = storage();
      if (!store) return true;
      var key = DEDUPE_PREFIX + sessionId;
      try {
        var raw = store.getItem(key);
        if (raw) {
          var at = parseInt(raw, 10);
          var delta = now - at;
          if (!isNaN(at) && delta >= 0 && delta < DEDUPE_WINDOW_MS) return false;
        }
        store.setItem(key, String(now));
      } catch (error) {
        return true;
      }
      return true;
    }

    /** 窗口是否在前台（用户是否正看着这一页）。 */
    function isWindowFocused() {
      var w = win();
      var d = doc();
      if (!w || !d) return true;
      try {
        if (d.visibilityState === "hidden") return false;
        if (typeof d.hasFocus === "function") return d.hasFocus();
        return true;
      } catch (error) {
        return true;
      }
    }
    // #endregion

    // #region 纯逻辑：会话快照 → 事件 → 通知载荷
    /** 会话标题：durable title → displayTitle（不是 id 的话）→ 空串。 */
    function titleOf(summary) {
      if (!summary) return "";
      var title = typeof summary.title === "string" ? summary.title.trim() : "";
      if (title) return title;
      var display = typeof summary.displayTitle === "string" ? summary.displayTitle.trim() : "";
      if (display && display !== String(summary.id)) return display;
      return "";
    }

    /** 只认导航里会显示的那三种待处理交互（与核心 sidebar 的投影一致）。 */
    function pendingKindOf(status) {
      var interaction = status && status.pendingInteraction;
      var kind = interaction && typeof interaction.kind === "string" ? interaction.kind : "";
      if (kind === "approval" || kind === "plan-review" || kind === "question") return kind;
      return "";
    }

    /**
     * 会话列表快照 → 扁平行。只读官方快照，不碰 DOM。
     * @param list - useSessions 的 SessionListState。
     * @param statuses - useSessionStatus 的 Map（可能缺席）。
     */
    function collectRows(list, statuses) {
      var rows = [];
      if (!list || typeof list !== "object") return rows;
      var byId = list.byId || {};
      var ids = Array.isArray(list.ids) ? list.ids : Object.keys(byId);
      for (var index = 0; index < ids.length; index++) {
        var id = ids[index];
        var summary = byId[id];
        if (!summary) continue;
        // 子代理 / 派生会话自己跑自己完，绝不是「你的对话结束了」。
        if (summary.origin === "subagent") continue;
        var status = statuses && typeof statuses.get === "function" ? statuses.get(id) : undefined;
        var running =
          status && typeof status.running === "boolean" ? status.running : summary.running === true;
        rows.push({
          id: String(id),
          title: titleOf(summary),
          blank: summary.blank === true,
          running: running,
          pending: pendingKindOf(status),
        });
      }
      return rows;
    }

    /**
     * 状态机一步：对比上一帧，产出事件（纯函数，单测直接打这里）。
     * @param prev - Map<id, {running, pending, since, title}>
     * @param rows - collectRows 的结果
     * @param now - 当前毫秒时间
     * @returns {{ state: Map, events: Array }}
     */
    function advance(prev, rows, now) {
      var before = prev instanceof Map ? prev : new Map();
      var state = new Map();
      var events = [];
      for (var index = 0; index < rows.length; index++) {
        var row = rows[index];
        var previous = before.get(row.id);
        var since = 0;
        if (row.running) {
          since = previous && previous.running && typeof previous.since === "number" ? previous.since : now;
        }
        state.set(row.id, {
          title: row.title,
          running: row.running,
          pending: row.pending,
          since: since,
        });
        // 首次见到的会话只记账：页面刷新时正在跑的对话不补一条通知。
        if (!previous) continue;
        if (!previous.running && row.running) {
          events.push({ kind: "started", id: row.id, title: row.title });
        } else if (previous.running && !row.running && !row.blank) {
          events.push({
            kind: "completed",
            id: row.id,
            title: row.title,
            durationMs: Math.max(0, now - (typeof previous.since === "number" ? previous.since : now)),
          });
        }
        if (!previous.pending && row.pending) {
          events.push({ kind: "pending", id: row.id, title: row.title, pending: row.pending });
        }
      }
      return { state: state, events: events };
    }

    /**
     * 事件 + 设置 + 环境 → 通知载荷（null 表示这次不提醒）。
     * @param event - advance 产出的事件
     * @param settings - 用户设置
     * @param env - {focused}
     */
    function decide(event, settings, env) {
      if (!event || !settings || settings.enabled !== true) return null;
      if (event.kind !== "completed" && event.kind !== "pending") return null;
      if (event.kind === "pending" && settings.notifyPending !== true) return null;
      var focused = env && env.focused === true;
      if (settings.onlyWhenUnfocused === true && focused) return null;

      var name = clampText(event.title, 40) || "当前会话";
      var title;
      var body;
      if (event.kind === "completed") {
        title = PRODUCT + " · 回答完成";
        body = "「" + name + "」已完成 · 用时 " + formatDuration(event.durationMs);
      } else {
        title = PRODUCT + " · 需要你的确认";
        var reason = PENDING_TEXT[event.pending] || "有事情等你处理";
        body = "「" + name + "」" + reason;
      }
      return {
        title: title,
        body: body,
        tag: PLUGIN_ID + "-" + event.id + "-" + event.kind,
        kind: event.kind,
        sessionId: event.id,
      };
    }

    /** 一次事件的落地：系统通知优先，否则站内浮层 + 提示音。 */
    function deliver(event, settings, now) {
      var payload = decide(event, settings, { focused: isWindowFocused() });
      if (!payload) return null;
      if (!claimNotification(event.id, now)) return null;
      if (showSystemNotification(payload)) return payload;
      pushToast(payload);
      if (settings.sound === true) beep();
      return payload;
    }
    // #endregion

    // #region 设置面板开合
    var panelStore = createStore(false);

    function setPanelOpen(open) {
      if (panelStore.value === open) return;
      panelStore.value = open;
      emitStore(panelStore);
    }

    function togglePanel() {
      setPanelOpen(!panelStore.value);
    }
    // #endregion

    // #region 图标
    function BellIcon(props) {
      return h(
        "svg",
        {
          viewBox: "0 0 16 16",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.3,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          className: props.className,
        },
        h("path", {
          d: "M8 2.1a3.35 3.35 0 0 0-3.35 3.35c0 3.1-1.25 4.05-1.25 4.05h9.2s-1.25-.95-1.25-4.05A3.35 3.35 0 0 0 8 2.1Z",
        }),
        h("path", { d: "M6.55 11.85a1.55 1.55 0 0 0 2.9 0" }),
      );
    }
    // #endregion

    // #region 组件：提醒引擎（shell.overlay）
    function NotifyEngine(props) {
      var settings = useSettings();
      var toasts = useStoreValue(toastStore);
      var panelOpen = useStoreValue(panelStore);
      var memory = react.useRef(null);
      if (memory.current === null) memory.current = new Map();

      // 钩子每次都调，不写条件分支：旧宿主缺席时退化成「永远看不到值」。
      var useSessions = props.useSessions || useAbsentValue;
      var useSessionStatus = props.useSessionStatus || useAbsentValue;

      var list = useSessions(identity);
      var statuses = useSessionStatus(identity);

      // 状态机：每个快照变化走一步，事件当场落地。
      react.useEffect(
        function () {
          var result = advance(memory.current, collectRows(list, statuses), Date.now());
          memory.current = result.state;
          for (var index = 0; index < result.events.length; index++) {
            deliver(result.events[index], settings, Date.now());
          }
        },
        [list, statuses, settings],
      );

      // 权限状态跟随窗口聚焦/可见性刷新（用户可能在地址栏里改过）。
      react.useEffect(function () {
        refreshPermission();
        var w = win();
        var d = doc();
        if (!w || !d) return undefined;
        var onFocus = function () {
          refreshPermission();
        };
        var onVisibility = function () {
          if (d.visibilityState === "visible") refreshPermission();
        };
        w.addEventListener("focus", onFocus);
        d.addEventListener("visibilitychange", onVisibility);
        return function () {
          w.removeEventListener("focus", onFocus);
          d.removeEventListener("visibilitychange", onVisibility);
        };
      }, []);

      // 首次点击顺手申请权限：拖到用户手势里才不会被浏览器静默拦掉。
      react.useEffect(
        function () {
          if (settings.autoRequest !== true) return undefined;
          var d = doc();
          var w = win();
          if (!d || !w) return undefined;
          if (currentPermission() !== "default") return undefined;
          var requested = false;
          var onGesture = function () {
            if (requested) return;
            if (currentPermission() !== "default") return;
            requested = true;
            requestPermission();
            d.removeEventListener("pointerdown", onGesture, true);
          };
          d.addEventListener("pointerdown", onGesture, true);
          return function () {
            d.removeEventListener("pointerdown", onGesture, true);
          };
        },
        [settings.autoRequest],
      );

      return h(
        react.Fragment,
        null,
        panelOpen ? h(SettingsPanel, { settings: settings }) : null,
        toasts.length > 0 ? h(ToastStack, { toasts: toasts }) : null,
      );
    }

    function identity(value) {
      return value;
    }

    /** 宿主没给这个钩子时的替身：恒为 undefined，让上层按「不知道」处理。 */
    function useAbsentValue() {
      return undefined;
    }
    // #endregion

    // #region 组件：站内浮层
    function ToastStack(props) {
      return h(
        "div",
        { className: "dshnod-toasts", role: "status", "aria-live": "polite" },
        props.toasts.map(function (toast) {
          return h(
            "div",
            { className: "dshnod-toast", key: toast.id },
            h("div", { className: "dshnod-toast-title" }, toast.title),
            h("div", { className: "dshnod-toast-body" }, toast.body),
            h(
              "button",
              {
                className: "dshnod-toast-x",
                "aria-label": "关闭",
                onClick: function () {
                  dismissToast(toast.id);
                },
              },
              "×",
            ),
          );
        }),
      );
    }
    // #endregion

    // #region 组件：铃铛（会话头部右侧）
    function NotifyBell() {
      var settings = useSettings();
      var permission = usePermission();
      var panelOpen = useStoreValue(panelStore);
      var needsPermission = settings.enabled === true && permission !== "granted";
      return h(
        "button",
        {
          type: "button",
          className: "dshnod-bell" + (panelOpen ? " dshnod-bell-on" : ""),
          title: needsPermission ? "完成提醒：点这里开启桌面通知" : "完成提醒设置",
          "aria-label": "完成提醒设置",
          "aria-pressed": panelOpen,
          "data-dshnod": "bell",
          onClick: togglePanel,
        },
        h(BellIcon, { className: "dshnod-bell-icon" }),
        needsPermission ? h("span", { className: "dshnod-dot" }) : null,
      );
    }
    // #endregion

    // #region 组件：设置面板
    function Check(props) {
      return h(
        "label",
        { className: "dshnod-check" },
        h("input", {
          type: "checkbox",
          checked: props.checked === true,
          onChange: function (event) {
            props.onChange(event.target.checked);
          },
        }),
        h("span", null, props.label),
      );
    }

    function statusLine(permission) {
      if (permission === "granted") return "桌面通知已开启";
      if (permission === "default") return "还没授权浏览器通知";
      if (permission === "denied") return "浏览器已拒绝通知（要在站点设置里恢复）";
      return "当前环境不支持通知（需 https 或 localhost）";
    }

    function SettingsPanel(props) {
      var settings = props.settings;
      var permission = usePermission();

      // Esc / 点面板外关闭。
      react.useEffect(function () {
        var d = doc();
        if (!d) return undefined;
        var onPointerDown = function (event) {
          var target = event.target;
          if (!target || typeof target.closest !== "function") return;
          if (target.closest(".dshnod-panel") || target.closest("[data-dshnod='bell']")) return;
          setPanelOpen(false);
        };
        var onKeyDown = function (event) {
          if (event.key === "Escape") setPanelOpen(false);
        };
        d.addEventListener("pointerdown", onPointerDown, true);
        d.addEventListener("keydown", onKeyDown, true);
        return function () {
          d.removeEventListener("pointerdown", onPointerDown, true);
          d.removeEventListener("keydown", onKeyDown, true);
        };
      }, []);

      var testPayload = {
        title: PRODUCT + " · 测试通知",
        body: "看到这条，说明系统通知这条链路是通的。",
        tag: PLUGIN_ID + "-test",
        kind: "test",
        sessionId: "test",
      };

      var actions = [];
      if (permission === "default") {
        actions.push(
          h(
            "button",
            {
              key: "grant",
              type: "button",
              className: "dshnod-btn dshnod-btn-primary",
              onClick: function () {
                requestPermission().then(function (value) {
                  if (value === "granted") showSystemNotification(testPayload);
                });
              },
            },
            "授权并测试",
          ),
        );
      } else if (permission === "granted") {
        actions.push(
          h(
            "button",
            {
              key: "test",
              type: "button",
              className: "dshnod-btn",
              onClick: function () {
                showSystemNotification(testPayload);
              },
            },
            "发一条测试通知",
          ),
        );
      } else {
        actions.push(
          h(
            "button",
            {
              key: "fallback",
              type: "button",
              className: "dshnod-btn",
              onClick: function () {
                pushToast(testPayload);
                beep();
              },
            },
            "试试站内浮层 + 提示音",
          ),
        );
      }

      return h(
        "div",
        { className: "dshnod-panel", role: "dialog", "aria-label": "完成提醒设置" },
        h(
          "div",
          { className: "dshnod-head" },
          h("span", { className: "dshnod-head-title" }, "完成提醒"),
          h(
            "button",
            {
              type: "button",
              className: "dshnod-x",
              "aria-label": "关闭",
              onClick: function () {
                setPanelOpen(false);
              },
            },
            "×",
          ),
        ),
        h(
          "div",
          { className: "dshnod-status" },
          h("span", { className: "dshnod-status-dot dshnod-status-" + permission }),
          h("span", null, statusLine(permission)),
        ),
        actions,
        h(
          "div",
          { className: "dshnod-checks" },
          h(Check, {
            label: "对话完成后提醒",
            checked: settings.enabled,
            onChange: function (value) {
              writeSettings({ enabled: value });
            },
          }),
          h(Check, {
            label: "需要我确认时提醒（提问 / 审批）",
            checked: settings.notifyPending,
            onChange: function (value) {
              writeSettings({ notifyPending: value });
            },
          }),
          h(Check, {
            label: "只在窗口不在前台时提醒",
            checked: settings.onlyWhenUnfocused,
            onChange: function (value) {
              writeSettings({ onlyWhenUnfocused: value });
            },
          }),
          h(Check, {
            label: "没有系统通知时响一声",
            checked: settings.sound,
            onChange: function (value) {
              writeSettings({ sound: value });
            },
          }),
          h(Check, {
            label: "首次点击页面时自动申请通知权限",
            checked: settings.autoRequest,
            onChange: function (value) {
              writeSettings({ autoRequest: value });
            },
          }),
        ),
        h(
          "div",
          { className: "dshnod-hint" },
          "浏览器通知要求页面是 https 或 localhost；Windows 上还要在「设置 → 系统 → 通知」里允许这个浏览器通知。关掉标签页后不会再提醒。",
        ),
      );
    }
    // #endregion

    // #region 样式
    var CSS = [
      ".dshnod-bell{position:relative;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;flex:none;transition:background .12s ease,color .12s ease}",
      ".dshnod-bell:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-primary,#0f0f0f)}",
      ".dshnod-bell-on{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}",
      ".dshnod-bell-icon{width:15px;height:15px}",
      ".dshnod-dot{position:absolute;top:5px;right:5px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#4176e6);box-shadow:0 0 0 1.5px var(--dsw-alias-bg-base,#fff)}",
      ".dshnod-panel{position:fixed;top:calc(var(--dsh-frame-chrome-top,0px) + 44px);right:16px;width:296px;padding:14px;border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 16px 40px rgba(15,15,15,.18);z-index:70;pointer-events:auto;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#0f0f0f)}",
      ".dshnod-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}",
      ".dshnod-head-title{font-size:14px;font-weight:600}",
      ".dshnod-x{border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#61666b);cursor:pointer;font-size:18px;line-height:18px;padding:0 2px;border-radius:6px}",
      ".dshnod-x:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}",
      ".dshnod-status{display:flex;align-items:center;gap:7px;color:var(--dsw-alias-label-tertiary,#61666b);font-size:12px;margin-bottom:10px}",
      ".dshnod-status-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-label-caption,#a2a4a6)}",
      ".dshnod-status-granted{background:var(--dsw-alias-state-success-primary,#22c55e)}",
      ".dshnod-status-default{background:var(--dsw-alias-state-warn-primary,#f59e0b)}",
      ".dshnod-status-denied,.dshnod-status-unsupported{background:var(--dsw-alias-state-error-primary,#ef4444)}",
      ".dshnod-btn{display:inline-flex;align-items:center;justify-content:center;height:30px;padding:0 12px;margin-bottom:10px;border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));border-radius:9px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#0f0f0f);font-size:12px;cursor:pointer}",
      ".dshnod-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}",
      ".dshnod-btn-primary{border-color:transparent;background:var(--dsw-alias-state-business-primary,#4176e6);color:#fff}",
      ".dshnod-btn-primary:hover{filter:brightness(1.06)}",
      ".dshnod-checks{display:flex;flex-direction:column;gap:7px;margin-bottom:10px}",
      ".dshnod-check{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary,#61666b);font-size:12px;cursor:pointer}",
      ".dshnod-check input{accent-color:var(--dsw-alias-state-business-primary,#4176e6);margin:0;width:13px;height:13px}",
      ".dshnod-hint{color:var(--dsw-alias-label-caption,#a2a4a6);font-size:11px;line-height:16px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.05));padding-top:9px}",
      ".dshnod-toasts{position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;gap:8px;z-index:70;pointer-events:none;max-width:340px}",
      ".dshnod-toast{position:relative;pointer-events:auto;padding:10px 30px 10px 12px;border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));border-radius:11px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 12px 28px rgba(15,15,15,.16);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,#0f0f0f)}",
      ".dshnod-toast-title{font-weight:600;margin-bottom:2px}",
      ".dshnod-toast-body{color:var(--dsw-alias-label-tertiary,#61666b)}",
      ".dshnod-toast-x{position:absolute;top:6px;right:8px;border:0;background:transparent;color:var(--dsw-alias-label-caption,#a2a4a6);cursor:pointer;font-size:15px;line-height:15px}",
    ].join("\n");

    function injectStyle() {
      var d = doc();
      if (!d || !d.head || typeof d.createElement !== "function") return;
      if (d.querySelector("style[data-plugin-css='" + PLUGIN_ID + "']")) return;
      var style = d.createElement("style");
      style.dataset.plugin = PLUGIN_ID;
      style.dataset.pluginCss = PLUGIN_ID;
      style.textContent = CSS;
      d.head.appendChild(style);
    }

    injectStyle();
    // #endregion

    // #region 插件入口
    exports.name = PLUGIN_ID;

    exports.apply = function apply(ctx) {
      // shell.overlay：框架级浮层（root 列表槽，点击穿透，条目自己开 pointer-events）。
      ctx.slots.inject("shell.overlay", function () {
        return ctx.slots.register(
          { name: "shell.overlay", id: PLUGIN_ID + ".engine", order: 60 },
          NotifyEngine,
        );
      });
      // 会话头部右侧的铃铛：只在会话里出现，承担授权与设置入口。
      ctx.slots.inject("conversation.session.header.utilities", function () {
        return ctx.slots.register(
          { name: "conversation.session.header.utilities", id: PLUGIN_ID + ".bell", order: 30 },
          NotifyBell,
        );
      });
    };

    exports.inject = ["slots"];
    // #endregion

    // #region 测试挂点（仅单测使用）
    exports.__test = {
      DEFAULTS: DEFAULTS,
      components: {
        NotifyEngine: NotifyEngine,
        NotifyBell: NotifyBell,
        SettingsPanel: SettingsPanel,
        ToastStack: ToastStack,
        BellIcon: BellIcon,
        Check: Check,
      },
      formatDuration: formatDuration,
      titleOf: titleOf,
      pendingKindOf: pendingKindOf,
      collectRows: collectRows,
      advance: advance,
      decide: decide,
      deliver: deliver,
      isWindowFocused: isWindowFocused,
      currentPermission: currentPermission,
      showSystemNotification: showSystemNotification,
      claimNotification: claimNotification,
      pushToast: pushToast,
      readSettings: readSettings,
      writeSettings: writeSettings,
      settingsStore: settingsStore,
      toastStore: toastStore,
      panelStore: panelStore,
      setPanelOpen: setPanelOpen,
    };
    // #endregion

    return module.exports;
  },
});

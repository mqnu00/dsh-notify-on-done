# dsh-notify-on-done

dsh 网页端的「对话结束」提醒：一轮回答跑完（或者卡在等你确认）时弹一条**系统通知** ——
Windows 上就是右下角那条 toast，不用一直盯着页面。

```
┌────────────────────────────────────────────┐
│ dsh · 回答完成                              │
│ 「重构 webhook 重试」已完成 · 用时 2 分 5 秒   │
└────────────────────────────────────────────┘
```

## 为什么是「浏览器通知」，而不是宿主弹窗

dsh 的宿主进程可能在别的机器 / 容器 / 远程机上跑，宿主那边弹窗到不了你的屏幕；
**通知必须发生在你正在看的那个浏览器里**。所以这是个纯 client 插件：

- 宿主半（`lib/index.js`）只有一个空 `apply`，存在的意义是让 `clientModules` 扫到本包；
- 浏览器半（`lib/client.js`）用标准 `Notification` API，Windows 上由系统投递。

代价写在明处：**页面关掉就不再提醒**（没有任何后端推送）。

数据也不读 DOM，只用官方钩子：`useSessions`（列表快照：`running` / `title` / `blank` / `origin`）
和 `useSessionStatus`（会话 UI 状态：`running` / `pendingInteraction`），dsh 换样式不会把插件打断。

## 特性

- 一轮回答跑完 → `dsh · 回答完成`，正文带会话名和本轮用时；
- 出现等你处理的交互（提问 / 审批 / 计划复核）→ `dsh · 需要你的确认`；
- 子代理会话不打扰；页面刚打开时正在跑的对话不补报；同一会话多标签页只弹一次；
- 默认**只在窗口不在前台时**提醒（页面就在眼前时不打扰，可在面板里关掉）；
- 未授权 / 浏览器拒绝 / 环境不支持时，自动退到**站内浮层 + 提示音**，不会静默丢失。

## 安装

先确认 `DSH_HOME`：默认是 `~/.dsh`，下面以 web profile 为例（`$DSH_HOME/profiles/web`）。

### 方式一：从 GitHub 安装

```bash
dsh plugin --profile web add github:mqnu00/dsh-notify-on-done
```

然后把包名加进 profile 的 bundle 层（这是加载顺序的表，装包不会自动改）：

```jsonc
// $DSH_HOME/profiles/web/package.json
{
  "dsh": {
    "profile": {
      "bundles": [
        // ... 原有的
        "dsh-notify-on-done"
      ]
    }
  }
}
```

重启 dsh web。

### 方式二：本地开发（改代码即时生效）

```bash
cd $DSH_HOME/profiles/web
# package.json: dependencies 里加一行，bundles 里加包名
#   "dsh-notify-on-done": "link:/path/to/dsh-notify-on-done"
ln -sfn /path/to/dsh-notify-on-done node_modules/dsh-notify-on-done
```

`link:` 是软链，改 `lib/client.js` 后重启一次就能看到变化（浏览器 bundle 只在 boot 时进启动图）。

## 使用

重启后刷新页面，会话标题栏右侧（工具区）多一个**铃铛**：

- 第一次点击页面时浏览器会问一次「允许通知」，点允许；
- 点铃铛可以看权限状态、发一条测试通知、开关各项提醒；
- 蓝点是「还没授权」的提示，授权后消失。

面板里的五项开关：

| 开关 | 默认 | 作用 |
| --- | --- | --- |
| 对话完成后提醒 | 开 | 总开关 |
| 需要我确认时提醒 | 开 | 提问 / 审批 / 计划复核 |
| 只在窗口不在前台时提醒 | 开 | 前台时不打扰 |
| 没有系统通知时响一声 | 开 | 兜底听觉提示 |
| 首次点击页面时自动申请通知权限 | 开 | 免去手动点铃铛 |

设置存在 `localStorage`（键 `dsh-notify-on-done:settings`），换浏览器要重设。

## 什么时候会提醒

| 触发 | 行为 |
| --- | --- |
| `running` true → false | 「回答完成」，带本轮用时 |
| 出现待确认交互（提问 / 审批 / 计划复核） | 「需要你的确认」 |
| `origin=subagent` 的派生会话 | 跳过 |
| 页面刚打开时正在跑的对话 | 不补报（首次见到只记账） |
| 空会话跑完 | 跳过 |
| 同一会话多标签页 | 8 秒内只弹一次（`localStorage` 时间戳去重） |

## 兜底顺序

| 情况 | 表现 |
| --- | --- |
| 已授权 | 系统通知；点通知 → 窗口前置 |
| 未授权 / 浏览器拒绝 | 右下角站内浮层 + 两声提示音 |
| 环境不支持（非安全上下文） | 同上；面板里说明原因 |

系统通知自己带声音，所以**有 toast 时不再额外响**，只有落到兜底才响。

## 地址不是 localhost / https 怎么办

`Notification` 是 `[SecureContext]` 特性：`http://192.168.x.x:3080` 这类地址浏览器根本不让你申请权限，
面板会显示「当前环境不支持通知」。三条路，任选：

1. **SSH 隧道**（最快）：`ssh -N -L 3080:127.0.0.1:3080 user@host`，然后开 `http://localhost:3080` ——
   `localhost` 天生是安全上下文；
2. **真 https**：Tailscale `serve` / 反向代理 + 可信证书，用 `https://…` 访问；
3. **改浏览器**：Chromium 系把来源加进 `chrome://flags/#unsafely-treat-insecure-origin-as-secure`，
   Firefox 用 `about:config` 的 `dom.securecontext.allowlist`（这是按来源放宽安全边界，别当长期方案）。

换地址后权限是新的：origin 变了要重新授权一次。

## Windows 排障

1. 设置 → 系统 → 通知 → 允许 Chrome / Edge 通知；
2. 勿扰 / 专注助手开着时，toast 会被折进通知中心不弹出来；
3. 误点过「禁止」：地址栏站点图标 → 通知 → 允许，刷新页面；
4. 企业策略禁用通知时，页面里不会有权限弹窗，面板会一直显示「还没授权」。

## 开发

```bash
node --test test/*.test.mjs        # 21 个用例，不需要浏览器
node tools/verify-install.mjs      # 检查 profile 登记、解析、bundle 能否物化
```

测试覆盖的是最容易错的判断，不是渲染像素：

- **状态机**：首次基线不补报、子代理过滤、空会话跳过、待确认只报一次、同一帧跑完；
- **抑制矩阵**：前台 / 总开关 / 单项开关；
- **载荷**：用时格式、标题截断；
- **落地**：有权限走系统通知、没权限落浮层、多标签页去重；
- **组件**：真的把组件函数跑一遍（自带迷你 react），验按钮/勾选框接的回调对不对。

## 结构

```
lib/index.js             宿主半：空 apply
lib/client.js            浏览器半：__ModuleLoader__ CJS bundle，只 require('react')
cordis.patch.yml         bundle patch：把宿主半 insert 进 profile
test/bundle.test.mjs     vm + 假 window/Notification 的纯逻辑与接线测试
test/components.test.mjs 迷你 react 跑组件
tools/verify-install.mjs 安装自检
```

`lib/client.js` 分两层，改行为时先看这条边界：

- **纯逻辑** `collectRows` / `advance` / `decide` / `formatDuration`：输入快照 → 输出事件与载荷，可单测；
- **副作用** `deliver`：系统通知 / 浮层 / 提示音 / 去重。想加「同时推到 IM」只需在这里加一条分支。

## 兼容性

- dsh ≥ 0.2.0（web profile）；依赖的槽位是 `shell.overlay`（root 列表槽）与
  `conversation.session.header.utilities`（会话头部右侧列表槽），标准钩子是 `useSessions` / `useSessionStatus`；
- 槽位或钩子缺席时，`ctx.slots.inject` 等不到声明就不会注册 —— 插件静默不出现，不会让页面报错；
- bundle 只用基座播种的 `react`，无三方依赖，无构建步骤（源码即产物）。

## 卸载

从 profile 的 `dsh.profile.bundles` 和 `dependencies` 移除本包，删掉 `node_modules/dsh-notify-on-done`，重启。
浏览器里的样式与设置是惰性的，留着无影响。

## License

MIT

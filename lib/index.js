/**
 * dsh-notify-on-done — 宿主半。
 *
 * 本包是纯 client 插件：真正的逻辑全部在 browser 半（lib/client.js），由
 * clientModules 扫描本包的 `dsh.client` 声明后送进浏览器启动图。宿主这一条
 * 目存在的唯一意义，是让本包成为 Loader 里的一个活跃条目 —— client 半只会
 * 被「已加载的宿主条目」扫描到，没有它浏览器里就没有这个插件。
 *
 * 所以 apply 保持为空：不注册工具、不装设置页、不碰会话。
 */
export const name = 'dsh-notify-on-done';

/** Host 半无逻辑。 */
export function apply() {}

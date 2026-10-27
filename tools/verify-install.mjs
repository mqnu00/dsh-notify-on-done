#!/usr/bin/env node
/**
 * 安装自检：不重启 dsh 也能确认「装对了」。
 *
 * 检查三件事，任一不成立浏览器里就不会有这个插件：
 *   1. profile 的 package.json 里登记了本包，并且 dsh.profile.bundles 里有它；
 *   2. 从 profile 的 node_modules 能解析到本包，exports["./client"] 指向真实文件；
 *   3. 那个 bundle 能被 __ModuleLoader__ 收下、factory 能物化出 apply/inject。
 *
 * 用法: node tools/verify-install.mjs [profile名，默认 web]
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import vm from 'node:vm';

const PKG = 'dsh-notify-on-done';
const profileName = process.argv[2] || 'web';
const profileDir = join(homedir(), '.dsh', 'profiles', profileName);

const checks = [];
function check(label, fn) {
  try {
    const detail = fn();
    checks.push({ ok: true, label, detail });
  } catch (error) {
    checks.push({ ok: false, label, detail: error instanceof Error ? error.message : String(error) });
  }
}

check(`profile 目录存在（${profileDir}）`, () => {
  if (!existsSync(join(profileDir, 'package.json'))) throw new Error('找不到 package.json');
  return 'ok';
});

check('profile 已登记本包（dependencies + profile.bundles）', () => {
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
  const spec = manifest.dependencies?.[PKG];
  if (!spec) throw new Error('dependencies 里没有 ' + PKG);
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  if (!bundles.includes(PKG)) throw new Error('dsh.profile.bundles 里没有 ' + PKG);
  return spec;
});

check('从 profile 能解析到本包', () => {
  const require = createRequire(join(profileDir, 'package.json'));
  const manifestPath = require.resolve(PKG + '/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const clientRel = manifest.exports?.['./client'];
  const clientPath = resolve(dirname(manifestPath), typeof clientRel === 'string' ? clientRel : clientRel?.default ?? '');
  if (!existsSync(clientPath)) throw new Error('exports["./client"] 指向的文件不存在: ' + clientPath);
  if (!manifest.dsh?.client?.platform) throw new Error('package.json 缺少 dsh.client.platform');
  return clientPath;
});

check('client bundle 能被 __ModuleLoader__ 物化', () => {
  const require = createRequire(join(profileDir, 'package.json'));
  const manifestPath = require.resolve(PKG + '/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const clientPath = resolve(dirname(manifestPath), manifest.exports['./client']);

  let entry;
  const sandbox = { window: { __ModuleLoader__: { load: (value) => (entry = value) } }, console };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(clientPath, 'utf8'), sandbox, { filename: clientPath });
  if (!entry) throw new Error('bundle 没有调用 __ModuleLoader__.load');
  if (entry.id !== PKG) throw new Error('bundle id 是 ' + entry.id + '，应为 ' + PKG);

  const fakeReact = {
    Fragment: 'Fragment',
    createElement: () => null,
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
  };
  const exported = entry.factory((specifier) => {
    if (specifier !== 'react') throw new Error('bundle 请求了未播种的模块: ' + specifier);
    return fakeReact;
  });
  if (typeof exported.apply !== 'function') throw new Error('导出里没有 apply');
  if (!Array.isArray(exported.inject) || !exported.inject.includes('slots')) throw new Error('inject 里缺少 slots');
  return 'apply + inject 就绪';
});

let failed = 0;
for (const { ok, label, detail } of checks) {
  if (!ok) failed += 1;
  console.log((ok ? '✔' : '✖') + ' ' + label + (detail ? '  → ' + detail : ''));
}

if (failed > 0) {
  console.log('\n有 ' + failed + ' 项没通过：装上但没登记（或版本不匹配）时，浏览器里不会出现这个插件。');
  process.exit(1);
}
console.log('\n全部通过。插件只在 dsh web 启动时进浏览器启动图 —— 重启一次才生效：');
console.log('  dsh web                      # 或你自己的 restart 脚本');

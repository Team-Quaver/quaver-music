// Quaver — 开发态补齐 @team-quaver/liino-node 的 dist。
//
// ui/package.json 用 file: 依赖指向 vendor/Liino/node，而该子模块按上游习惯
// 不提交 tsc 产物。pnpm install 的 hoisted 布局会复制一份 package.json 指到
// dist/index.js 的目录；不先编译并同步，Electron 启动时只会看到
// ERR_MODULE_NOT_FOUND，然后静默回落到 mpv。
import { cpSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const uiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = resolve(uiDir, "../vendor/Liino/node");
const targetDir = join(uiDir, "node_modules/@team-quaver/liino-node");
const tsc = join(uiDir, "node_modules/typescript/bin/tsc");

if (!existsSync(join(sourceDir, "package.json"))) {
  console.warn("[liino-node] 跳过：vendor/Liino 子模块不存在");
  process.exit(0);
}

if (!existsSync(tsc)) {
  console.warn("[liino-node] 跳过：ui/node_modules/typescript 不存在，请先 pnpm install");
  process.exit(0);
}

const build = spawnSync(process.execPath, [tsc, "-p", join(uiDir, "tsconfig.liino-node.json")], {
  cwd: uiDir,
  stdio: "inherit",
});

if (build.status !== 0) {
  console.error(`[liino-node] 编译失败（exit ${build.status ?? "signal"}）`);
  process.exit(build.status ?? 1);
}

const sourceDist = join(sourceDir, "dist");
const targetDist = join(targetDir, "dist");

if (!existsSync(join(sourceDist, "index.js"))) {
  console.error(`[liino-node] 编译结束但缺少 ${join(sourceDist, "index.js")}`);
  process.exit(1);
}

if (!existsSync(targetDir)) {
  console.warn("[liino-node] 跳过同步：ui/node_modules 里没有 @team-quaver/liino-node，先 pnpm install");
  process.exit(0);
}

rmSync(targetDist, { recursive: true, force: true });

cpSync(sourceDist, targetDist, { recursive: true });

console.log("[liino-node] dist 已同步到 node_modules");

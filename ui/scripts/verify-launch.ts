// Quaver — 开发态启动与 cwd 解耦（vite 的 root）的单测护栏。
// 跑：  node scripts/verify-launch.ts
//
// 起因（真踩过）：`pnpm run app` 曾经会写一份开发态桌面项进 $XDG_DATA_HOME/applications/
// <ID>.desktop（开发态现在已改为**不自装**、只清历史条目，见 electron/linux-desktop.ts），
// Exec = 当前 electron + 仓库 ui/ 目录。用户从启动器点它时，进程 cwd 是 $HOME（那条 Exec 没带
// Path=），而主进程是用**程序化 API** 起 vite preview 的（electron/main.ts: preview({
// configFile })）—— vite 的 root 默认取 process.cwd()，于是 root 落到 $HOME，preview 去服务
// $HOME/dist（不存在），窗口拿到 404 白页。表现就是「.local/share/applications 里那个 Desktop
// 点不开」。修法只有一处：vite.config.ts 把 root 钉成绝对路径（本文件所在目录），dev / build /
// preview 从此与 cwd 无关 —— 对打包态（linux-desktop 自装）与历史遗留条目同样成立，护栏留效。
//
// 这里真跑一遍 resolveConfig（跟 preview 同一组参数）从**别的 cwd** 解析：root 必须还是 ui/，
// 出目录必须还是 ui/dist —— 谁把 root 改回 cwd 相对，这条立刻红。
import { resolveConfig } from "vite";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const UI = resolve(import.meta.dirname, "..");
const CONFIG = join(UI, "vite.config.ts");

let pass = 0, fail = 0;
const section = (t: string) => console.log(`\n=== ${t} ===`);
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/** 换到 dir 当 cwd 解析一次 vite 配置（preview 用的就是这组参数），随后还原 cwd。 */
async function resolveFrom(dir: string) {
  const back = process.cwd();
  process.chdir(dir);
  try {
    return await resolveConfig({ configFile: CONFIG }, "serve", "production", "production", true);
  } finally {
    process.chdir(back);
  }
}

section("root 与 cwd 解耦（preview 的真相）");
const fromUI = await resolveFrom(UI);
eq("cwd=ui → root 是 ui/", fromUI.root, UI);
const fromHome = await resolveFrom(tmpdir());
eq("cwd=/tmp（模拟启动器）→ root 仍是 ui/", fromHome.root, UI);
const fromRoot = await resolveFrom("/");
eq("cwd=/ → root 仍是 ui/", fromRoot.root, UI);

section("产物与静态目录跟着 root 走（不是 cwd）");
const outDir = resolve(fromHome.root, fromHome.environments.client.build.outDir);
eq("outDir 落在 ui/dist", outDir, join(UI, "dist"));
eq("publicDir 是 ui/public", fromHome.publicDir, join(UI, "public"));

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-launch: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

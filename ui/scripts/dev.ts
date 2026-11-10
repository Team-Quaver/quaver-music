// Quaver — dev server wrapper: ensure the Liino bindings exist, then hand the
// original CLI arguments to Vite. A plain `node ensure && vite` would make pnpm
// append the `--` separator to Vite's argv and silently ignore --port/--host.
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const uiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ensure = spawnSync(process.execPath, [join(uiDir, "scripts/ensure-liino-node.ts")], {
  cwd: uiDir,
  stdio: "inherit",
});

if (ensure.status !== 0) process.exit(ensure.status ?? 1);

const args = process.argv.slice(2);

if (args[0] === "--") args.shift();

const vite = spawnSync(process.execPath, [join(uiDir, "node_modules/vite/bin/vite.js"), ...args], {
  cwd: uiDir,
  stdio: "inherit",
});

process.exit(vite.status ?? 1);

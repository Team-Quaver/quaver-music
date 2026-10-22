# Vendored anti-slop Oxlint plugin

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit `13909c9e07590f5a85d93c62712259fe14a883f7`
(pristine snapshot taken 2026-10-22 via `git clone --depth 1` of `skills/install-anti-slop/assets/anti-slop`).

Installed path: `ui/tools/oxlint/anti-slop/`（渲染层/主进程/scripts 共用；由 `node <skill>/scripts/install.mjs` 复制）。

Registered in `.oxlintrc.json` as `jsPlugins[0]` (`name: "anti-slop"`), all generic rules enabled at
`"error"` together with the native companion `oxc/no-accumulating-spread`. The repository has no direct
Effect dependency, so the opt-in `anti-slop-effect` plugin was intentionally NOT installed.

Dependencies: `oxlint@1.89.0` + `@oxlint/plugins@1.89.0`（同版本精确钉住，devDependencies）。

## Intentional deviations（本地定制，更新上游时必须保留或重新评估）

- `vendor/eslint-stylistic/padding-line-between-statements.ts`（`verify()` 内）：新增同物理行豁免——
  与上一条语句共享同一物理行的语句不再强制空行。本仓大量使用紧凑单行控制流
  （`if (cond) { guard(); return; }`），上游引擎会把这种行从中间劈开（会打坏
  `verify-song-menu.ts` 的源码正则断言，实测踩过）。标记注释见代码内「本地定制（Quaver）」。
- 除此之外与上游快照逐字节一致。

## Vendored ESLint Stylistic provenance

See `vendor/eslint-stylistic/UPSTREAM.md` + `LICENSE` (MIT, commit `435c3ea0…`), carried along unchanged.

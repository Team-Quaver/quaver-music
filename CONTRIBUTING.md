# Quaver Music 贡献者协议和指南

Quaver Music 基于 AGPLv3 Only 协议自由开源，该协议作为辅助协议执行

## 影响部分

- Quaver Music
- Quaver Typhoeus Golang Backend (Typhoeus-go)
- Quaver Music MyGO Edition (Quaver Astra)
- Quaver Music Plugins / SDK (Quaver Sparkle)

## 开发流程

### 依赖

- Golang v1.27.0 以上版本
- PNPM 10.33.0 以上版本
- Node 24.22.1 以上版本
- Electron 43 及后续版本（龙芯）

### 快速开始

- 安装依赖：Go、PNPM、Node 和 Electron，版本要求见上文。
- 初始化子模块：

  ```shell
  git submodule update --init --depth 1 vendor/Sparkle vendor/Typhoeus-go vendor/Liino
  ```

- 安装前端依赖：

  ```shell
  cd ui
  pnpm install --frozen-lockfile
  ```

- 启动开发环境（Vite 开发服务器）：

  ```shell
  cd ui
  pnpm dev
  ```

### 构建

- 构建前端与 Electron 应用：

  ```shell
  cd ui
  pnpm app
  ```

- 构建 Typhoeus-go 后端（以 Linux x86_64 为例）：

  ```shell
  cd vendor/Typhoeus-go
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags "-s -w" \
    -o ../../dist-bin/quaver-server-x86_64 ./cmd/quaver-server
  ```

- 构建应用分发包：

  ```shell
  cd ui
  pnpm dist
  ```

  该命令基于 `packages/appimage/arm-x86.yml` 生成 AppImage；其他平台配置见 `packages/`。

### 常用脚本

以下命令均在 `ui/` 目录执行：

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 启动 Vite 开发服务器 |
| `pnpm build` | 类型检查并构建前端产物 |
| `pnpm preview` | 预览构建产物 |
| `pnpm app` | 构建后用 Electron 启动应用 |
| `pnpm typecheck` / `pnpm typecheck:node` | 分别检查渲染端与 Node 端类型 |
| `pnpm lint` / `pnpm lint:fix` | 运行 Oxlint 检查或自动修复 |
| `pnpm verify:static` | 运行静态护栏检查 |
| `pnpm verify:bundle` | 检查产物体积、首屏预算与懒加载边界 |
| `pnpm dist` | 构建并生成 AppImage |

### 项目结构

### 提交约定

- 注释：中/英都行
- 检查：需通过 `pnpm verify:static` 与 `pnpm verify:bundle`，以及 `pnpm lint` 的测试
- 提交信息：使用惯例提交法，`<提交类别>: <摘要>`，单行标题，推荐单次单一改动，单次提交，若一个提交有多个改动，请使用 ` Change A // Change B ` 方式，支持使用 Gitmoji。包括以下类别：`Feat` / `Fix` / `Refactor` / `Perf` / `Doc` / `CI` / `Chore` / `Other`

## 代码版权所属

1. Quaver Music 的代码版权，归该部分的代码撰写者所有。
2. Quaver Music 的代码版权受 AGPLv3 协议保护
3. 因此 Fork 后修改的代码需要同等协议开源，可选择贡献，或者自己维护自己的分支

## 贡献要求

- 主线分支为 main 分支，该分支是主要的开发分支
- 除特定情况/人在主线干活，其他情况请 Fork，有仓库权限的可在新分支干活
- 在未进入下一个版本周期前，请在 next 分支中进行干活

## RFC

在以下情况下，需要在 Issues/议题发起 RFC 进行讨论

- 更换技术栈（如 Electron -> Wails/Tauri, Go -> Rust 等）
- 引入重大变更
- 更换开源许可协议

## RFC 投票

以下人员拥有 RFC 投票权利

- 年满 18 周岁的成年人
- 近 3 个月内参与代码贡献的人士

记名记数法，在 Issues 里面，建立一个限制仅贡献者的投票子议题。

<!-- 如涉及代码 Pull Request 相关，在 PR 部分进行讨论，如代码进入稳定状态，而属于重大变更、更换技术栈 -->

## LLM 政策

本应用欢迎 LLM 贡献！要求如下：

- 最好是做过代码审核，检查代码部分是否有逻辑问题、类型问题（Review 代码后可提高一定的通过率）
- 必须实现后自己用一遍，去查询是否有什么前端的逻辑问题，有问题一定要修

## 不可抗力

若遇到 DMCA，维护者遇不可抗力情况。第二顺位的维护者（有管理权限的维护者）有权组织大局。
若在 RFC 投票阶段，有对应贡献者失联等不可抗力情况，将不参与计票。

// ui/electron/config.mjs（纯 Node JS 模块）的类型声明：仅供渲染层 dev 工具链
// （src/relay.ts 经 vite.config 在 Node 侧运行）解析目录规则用。完整的 INI 读写
// 与 schema 见 config.mjs 本体 —— 本文件只暴露渲染层实际消费的函数。
export declare function configDir(env?: unknown): string;
export declare function configFile(env?: unknown): string;

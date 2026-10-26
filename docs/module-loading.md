# 0.1.2：启用时的模块加载错误

用户反馈 Node 24.14.0 在 Pi Pocket 中启用扩展时只显示 `Unexpected token 'export'`。公司机器没有提供文件路径或堆栈，因此尚不能确认它的具体环境配置。

本机已用原始安装文件复现两个触发条件：

1. 安装目录最近的 `package.json` 声明 `"type": "commonjs"`。
2. 没有显式 ES 模块声明，并通过 `NODE_OPTIONS` 或 Node 命令行禁用模块自动识别。

Node 24.14.0 在 `user-messages.ts` 的 `export const pocketApi = 1` 处报相同语法错误。默认模块识别开启且没有 CommonJS 声明时可以正常加载；这不是版本最低要求不满足。

## 修复

`node scripts/install.mjs --force --esm` 显式设置 `extensions/package.json` 的 `type` 为 `module`，保留其余 JSON 字段，并将已有配置原样备份到 `extension-backups/`。普通安装不修改共享配置；已有 `type: module` 文件保持原字节。

模块声明会影响整个扩展目录，不能当作单个文件的开关。依赖 CommonJS 的其他自定义扩展需要先确认兼容；卸载本插件时不自动移除共享声明。上游 Pi Pocket 当前仅扫描顶层 `.ts` 入口，所以单纯把入口改名 `.mts` 不能解决发现与加载问题。

Node 会缓存包作用域。已确认同一进程中将 CommonJS 声明改成 module，再用不同查询参数重新 import，仍可能失败。**修复后需要重启 Pi Pocket 服务，再启用扩展。**

安装 CLI 现在用新的 Node 子进程加载实际安装入口，检查默认导出与 API 版本。如果失败，会明确报告文件已安装但加载失败，不再显示普通成功提示。`node scripts/check-install.mjs [--dir <data directory>]` 是只读诊断；它继承当前 Node、`NODE_OPTIONS` 和模块识别相关启动参数，不调用模型或读取账号配置。

## 验证

2026-10-26 在 Windows 执行：

```powershell
npm exec --yes --package=node@24.14.0 -- node --test test/*.test.js
$env:NODE_OPTIONS='--no-experimental-detect-module'
npm exec --yes --package=node@24.14.0 -- node --test test/integration.test.mjs
```

- 单元测试：41/41；集成测试：6/6；语法检查通过。
- 新回归测试先在修复前失败，捕获精确的 export 语法错误，再验证显式修复能加载。
- 覆盖真实安装后的子进程加载、CLI 失败与修复提示、配置字段保留、原字节备份、发布顺序、损坏或链接配置拒绝、创建/替换声明后的失败回滚。
- 集成测试使用 `--esm` 安装，Node 的模块自动识别保持关闭，再通过真实 Pi Pocket 加载器和 HTTP API 验证资源、205 条消息分页、权限、会话隔离及过期游标。
- CI 增加精确的 Node 22.19.0 和 24.14.0，保留最新 22 / 24，并覆盖 Windows / Linux。

公司机器尚待运行修复命令并重启后确认；本记录不把本机验证当作远程环境已恢复。

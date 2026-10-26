# Pi Pocket User Messages

A small, dependency-free Pi Pocket extension for browsing user prompts and jumping to a useful fork point.

为 [Pi Pocket](https://github.com/TannerMidd/pi-pocket) 增加 **Your messages**：只看当前会话中的用户消息，快速定位要继续或分叉的位置。对应 [issue #149](https://github.com/TannerMidd/pi-pocket/issues/149)，无需修改 Pi Pocket 核心。

## 功能

- 从菜单、启动器或会话顶部按钮打开消息列表。
- 按新到旧排列，显示短预览、时间和作者；包含本会话中其他参与者的用户消息。
- 输入多个词筛选已加载的消息。
- 分页加载较早消息，也可以加载全部；加载全部时可取消。
- 刷新列表；切换会话时清除旧会话的数据，并忽略过期请求结果。
- 点击一条消息，关闭列表并跳转、高亮原消息。桌面和手机均可使用。

插件只负责查找和跳转。要分叉，跳转后再次点击原消息，使用 Pi Pocket 已有的 **Edit and send again** 操作；插件不会直接发送消息或创建分叉。

## 要求

- Pi Pocket **0.21.0 或更新版本**（会话菜单分组从 0.21.0 起提供）。
- 在运行 Pi Pocket 的机器上安装；通过手机访问时，也安装到服务器的数据目录。
- 使用 Pi Pocket 支持的 Node.js 版本（当前要求 22.19 或更新版本）。

使用的是公开的 `pocket.messages`、`pocket.reveal` 和 `pocket.onConversation` 接口。这些接口目前标记为 experimental；升级 Pi Pocket 后建议检查一次列表与跳转功能。

## 安装

在运行 Pi Pocket 的机器上执行：

```sh
git clone https://github.com/mikyan/pi-pocket-user-messages.git
cd pi-pocket-user-messages
node scripts/install.mjs
```

也可[下载源码 ZIP](https://github.com/mikyan/pi-pocket-user-messages/archive/refs/heads/main.zip)，解压后在目录内运行安装脚本。

默认安装到 `${PI_POCKET_DIR}/extensions/`；未设置 `PI_POCKET_DIR` 时，使用 `~/.pi-pocket/extensions/`。也可以明确指定 **Pi Pocket 数据目录**：

```sh
node scripts/install.mjs --dir /path/to/pi-pocket-data
```

安装后，在 Pi Pocket 中打开 **Menu → Extensions → Installed**，找到 `user-messages` 并启用。若当前页面尚未显示入口，刷新页面。

不需要 `npm install` 或构建步骤。手动安装也可以：将下面两个项目复制到数据目录的 `extensions/` 下，保留它们的相邻关系。

```text
extensions/
├── user-messages.ts
└── user-messages/
    ├── index.js
    └── …
```

安装脚本会保护已存在的文件。需要替换已安装版本时，先检查本地修改，再显式使用 `--force`：

```sh
node scripts/install.mjs --force
```

旧版文件会备份到数据目录下的 `extension-backups/`，替换失败时自动恢复。

卸载时先在 Extensions 中关闭插件，再移除 `extensions/user-messages.ts` 和 `extensions/user-messages/`。不要删除其他扩展的文件。

## 使用

1. 打开一个会话，选择 **Your messages**。也可按 Ctrl+K / ⌘+K，在启动器中搜索它。
2. 浏览最新消息，或输入关键词筛选。
3. 查找较早的提示词时，选择加载更早消息或加载全部。筛选只覆盖已经加载的消息。
4. 点击目标消息返回会话，再使用原消息的编辑重发操作选择分叉点。

新增消息后可点击刷新，重新获取当前会话的消息列表。

## 数据范围与限制

- 只包含用户发给 Pi 的消息，不包含 Pi 的回复、工具调用或旁聊。
- `pocket.messages` 每条最多返回 **1000 个字符**。长消息会标注截断；筛选无法匹配这段摘录之外的内容。跳转后可以阅读原消息。
- 每次请求最多 200 条消息，插件通过分页读取更早记录。
- API 读取当前 transcript。使用 **New context** 之前、已经不在当前 transcript 中的消息不在列表内。
- 分页游标可能因会话上下文变化而失效，需要重新读取。消息已移出当前 transcript 时，跳转也可能失败。
- 列表展示的是会话中所有人的用户消息，并非只显示当前登录者的消息。
- 扩展对能查看所有会话的已登录用户开放；仅受邀访问单个会话的用户无法加载此类浏览器扩展，这是 Pi Pocket 的权限规则。分叉仍要求相应的操作权限。

消息只在列表打开期间保存在浏览器内存中；不写入浏览器持久存储，不请求外部服务，也不调用模型。访问范围由 Pi Pocket 自身检查。

## 开发与验证

```sh
npm run check
npm test
```

运行时和单元测试均不需要第三方 npm 依赖。自动化测试覆盖分页、会话切换与过期请求、取消、游标恢复、导航、安装备份、Windows junction 路径和失败回滚；CI 配置覆盖 Linux / Windows 上的 Node.js 22 和 24。

真实服务联调需要旁边有一份已安装依赖的 Pi Pocket 源码，默认路径为 `../pi-pocket`，也可通过 `PI_POCKET_SOURCE` 指定。

```sh
npm run test:integration
npm run test:serve -- --source /path/to/pi-pocket
```

前者运行真实 HTTP 集成测试并自动清理；后者启动本机测试实例并打印登录链接，供浏览器操作。两者均使用临时数据和本地脚本模型，不使用已有会话或模型账号。测试实例包含 205 条用户消息、中文、长消息、多位作者、另一会话及空会话；修改插件源码会自动同步到测试实例。按 Ctrl+C 关闭并清理临时数据。

2026-10-26 已在 Windows / Node.js 24.14.1 / Pi Pocket 0.21.0 上通过 28 项单元测试和 6 项真实服务集成测试，并在本机 Edge 完成分页、筛选、跳转、编辑重发分叉和只读权限联调。390×844 手机尺寸检查通过；尚未验证实体手机、iOS Safari 或移动端软键盘。详细证据和复现步骤见 [验证记录](docs/validation.md)。

实现背景、现成方案检索和接口依据见 [调研记录](docs/research.md)。

## 许可证

[MIT](LICENSE)。

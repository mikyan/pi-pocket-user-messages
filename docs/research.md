# 用户消息时间线：调研记录

核查日期：**2026-10-26**。

## Issue #149 的真实状态

[TannerMidd/pi-pocket #149](https://github.com/TannerMidd/pi-pocket/issues/149) 希望在长会话里提供只包含用户消息的紧凑列表：长消息用短预览，选中后跳转到原消息，支持桌面和手机，并方便找到分叉或编辑重发入口。

该 issue 已关闭，但不能据此判断功能已经内置。

- 作者的[第一条回复](https://github.com/TannerMidd/pi-pocket/issues/149#issuecomment-6387514672) 曾表示 0.22.0 提供了 **Your messages**，并提到 PR #150。
- 作者随后[明确更正](https://github.com/TannerMidd/pi-pocket/issues/149#issuecomment-6389345760)：**0.22.0 不内置该功能**，它应由扩展实现，所需扩展接口从 0.20.0 起已经提供。

本项目依据后面的更正及实际扩展接口实现，不将 issue 的关闭状态当作交付证明。

## 现成方案检查

Pi Pocket 默认扩展索引为 [TannerMidd/pi-pocket-extensions](https://github.com/TannerMidd/pi-pocket-extensions)，这一来源可在上游 [gallery.ts](https://github.com/TannerMidd/pi-pocket/blob/main/src/server/gallery.ts) 的 `DEFAULT_INDEX` 中核实。

核查当天的 [index.json](https://github.com/TannerMidd/pi-pocket-extensions/blob/main/index.json) 共 15 项（含主题），没有提供用户消息时间线或提示词跳转的扩展。Change Atlas 用于代码变更报告，Decision notebook 用于会话决策记录，均不满足此需求。

另做了以下公开检索：

- GitHub 代码搜索 `"pocket.messages("`：只找到上游文档中的示例调用。
- GitHub 代码搜索 `pocket.reveal`：相关命中为上游接口、实现和测试，没有发现独立的此类插件。
- 官方 gallery 的 messages / timeline issue 与 PR 搜索：未发现对应条目。
- 搜索引擎检索 Pi Pocket、user messages、Your messages、timeline extension 等组合：未找到可验证的独立实现。

GitHub 仓库名称搜索接口多次超时，公开搜索也有索引延迟。因此结论是“在已检查的官方索引与公开搜索结果中未找到”，而不是断言所有位置都不存在。

Pi CLI 的插件不能直接当作 Pi Pocket 插件安装：上游 [README 的 Limitations](https://github.com/TannerMidd/pi-pocket#limitations) 明确说明两者使用不同的扩展体系。

## 实现依据

扩展使用公开 API，不导入 Pi Pocket 内部网页模块，不依赖 DOM 选择器定位消息，也不直接访问数据库。

| 接口 | 用途 | 最低版本 |
| --- | --- | --- |
| `pocket.messages` | 分页读取当前会话的用户消息 | 0.20.0 |
| `pocket.reveal` | 加载所需历史，跳转并高亮原消息 | 0.20.0 |
| `pocket.onConversation` | 跟踪当前标签页的会话变化 | 0.20.0 |
| `pocket.menu` / `launcher` / `sheet` | 提供导航入口和列表界面 | 0.14.0 |

接口定义与示例见 [pocket reference](https://github.com/TannerMidd/pi-pocket/blob/release/0.22.0/docs/extensions/reference/pocket.md#messages)；扩展装载与清理约定见 [Browser modules](https://github.com/TannerMidd/pi-pocket/blob/release/0.22.0/docs/extensions/browser-modules.md)。`menu` 的 `group: "session"` 从 0.21.0 才提供，不能将其视为 0.20.0 的保证。

官方示例展示了如何获取最多 200 条消息并跳转，但没有完整分页、过滤和请求竞争处理，因此本项目提供独立实现。

## 必须保留的行为边界

依据 [messages 与 reveal 文档](https://github.com/TannerMidd/pi-pocket/blob/release/0.22.0/docs/extensions/reference/pocket.md#messages)：

1. 每页消息按旧到新返回；界面需要转换为新到旧。分页继续读取返回的 `before`，直到其为 `null`。
2. 每页至多 200 条，正文摘录至多 1000 字符；`clipped` 表示正文已截断。过滤范围应明确为已加载的摘录。
3. 请求属于发起时的会话。返回结果必须核对 `conversationId`，防止切换会话后展示上一会话的内容。
4. 过期游标返回 409，应从最新页重新读取。关闭界面或切换会话时应取消未完成请求。
5. 用户消息是任意文本，应当作为文本渲染，不能当作 HTML 执行；只在展示期间保存在内存中。
6. `reveal` 自动关闭 sheet，必要时加载较早历史；当消息不可用、会话变化或新的导航取代旧请求时，返回 `false`。
7. 当前 transcript 不含 **New context** 之前已退出上下文的消息。

该接口组合提供的是消息导航。分叉继续使用原消息已有的 **Edit and send again** 操作，不自行重建私有分叉 API，也不将截断摘录当成完整提示词发送。

## 分发方式

采用官方支持的 drop-in 布局：`user-messages.ts` 与 `user-messages/` 放在 Pi Pocket 数据目录的 `extensions/` 内，由所有者在 Extensions 中启用。详见 [Publishing to the gallery](https://github.com/TannerMidd/pi-pocket/blob/release/0.22.0/docs/extensions/publishing.md)。

本仓库包含源码和本地安装脚本；此文档不表示插件已经发布到官方 gallery。

# 0.1.1 本机验证记录

日期：2026-10-26。

## 环境与范围

- Windows，Node.js 24.14.1；本机 Microsoft Edge。
- Pi Pocket 0.21.0，源码提交 `7d6fbb0`。
- 使用 `scripts/serve-integration.mjs` 启动真实 Pi Pocket 服务、扩展加载器、HTTP 接口和网页；模型使用上游测试用的本地脚本模型。
- 使用独立临时数据目录。主实例的会话、账号配置和已安装扩展未改动。
- 手机检查使用 Edge 的 390×844 视口；不等同于实体手机测试，未覆盖 iOS Safari、触屏手势或软键盘。

## 自动化结果

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm test` | 28/28 通过，无跳过 |
| `npm run test:integration` | 6/6 通过，无跳过 |
| `git diff --check` | 通过 |

本次发现 Windows 路径检查只按 `/` 拆分，导致漏查父目录 junction。已改用平台分隔符，并用真实 junction 验证源码目录与目标目录的父级链接均被拒绝。新增回归测试在修复前失败、修复后通过。Windows 无权限创建文件 symlink 时，相关单元测试注入 `lstat` 边界；目录 junction 测试仍使用真实文件系统。

真实 HTTP 集成测试覆盖登录、扩展资源内容和 MIME、未登录和 viewer 访问、205 条消息按 100/100/5 分页、作者映射、Unicode 与长文本、不同会话及空会话，以及 New context 使旧游标返回 409。HTTP 原始消息没有浏览器 API 的 `clipped` 字段，摘录标记由下面的界面测试验证。

远程 [CI 40273422619](https://github.com/mikyan/pi-pocket-user-messages/actions/runs/40273422619) 已在提交 `4211adc` 上通过 Windows / Linux × Node.js 22 / 24 全部四项任务；每项执行语法检查与 28 项单元测试。真实服务集成测试及界面测试在本机执行。

## 真实界面结果

| 操作 | 实际结果 |
| --- | --- |
| 会话顶部入口 | 打开 Your messages，初始 100 条，最新消息在前 |
| 中文筛选 | `中文搜索` 匹配 Prompt 203，中文与 emoji 正常显示 |
| 作者筛选 | `Alex Example` 在最新 100 条中匹配 4 条 |
| 长消息 | Prompt 204 显示省略号和 excerpt 标记，不撑宽面板 |
| 分页 | Load older 后为 200 条；Load all 后为 205 条，较早消息入口消失 |
| 早期消息跳转 | 筛选 Prompt 001，点击后关闭面板、加载旧历史并定位到第一条消息 |
| 编辑重发 | 点击原消息 → Edit and send again → 修改文本 → Send in a new session，成功创建分叉并收到脚本模型回显 |
| 原会话保留 | 返回原会话，仍显示最新 Prompt 205，历史未被分叉修改 |
| 会话隔离 | 分叉列表只有新消息；第二个会话只有 violet lighthouse；空会话显示空状态 |
| 手机尺寸 | 390×844，面板 clientWidth/scrollWidth 均为 340px；检查到的操作按钮高度至少 46px |
| 手机导航 | 菜单入口、中文筛选、跳转后原生编辑入口正常；返回键回到上层菜单 |
| 只读用户 | 能打开列表并跳转；原消息菜单只有 Copy text，没有编辑重发操作 |
| 首页启动器 | Your messages 可打开，未选择会话时提示打开会话 |

未发现 Pi Pocket 或本插件的浏览器错误；日志中有用户已安装的翻译浏览器扩展自身报错，来源为 `chrome-extension://`，不属于此插件。

截图：[手机尺寸消息列表](images/mobile-outline.png)、[原生分叉成功](images/native-fork.png)。`artifacts/` 不入库，其中的测试登录元数据也不入库。

测试服务已停止。本次手动测试实例启动时使用了旧版退出顺序，停止后临时数据目录尚存；删除操作被自动审批检查拦截。脚本已修正为先关闭 app 连接再等待 HTTP 关闭，单独的启动/关闭验证及集成测试均正常退出和清理。

## 复现

1. 准备 Pi Pocket 0.21.0 源码并安装它的依赖；本插件本身无需安装依赖。
2. 执行 `npm run test:serve -- --source /path/to/pi-pocket`，打开终端打印的 owner 登录链接。
3. 打开以 Prompt 001 命名的会话，再打开 Your messages。
4. 筛选 `Prompt 001`，依次 Load older、Load all，确认已加载 205 条；点击唯一匹配项。
5. 点击原消息，选择 Edit and send again，修改提示词并发送到新会话；确认分叉和模型回显。
6. 检查第二会话、空会话、viewer 登录链接及手机尺寸，最后 Ctrl+C 清理。

自动化复现用 `npm run test:integration`；可通过 `PI_POCKET_SOURCE` 指定源码目录。集成测试自行申请随机端口、启动和清理，不依赖正在运行的测试实例。

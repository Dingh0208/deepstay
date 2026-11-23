# DeepSeek V4 Pro 联网搜索修复验收

## 问题与官方对照

用户截图中的接口拒绝源于工具协议混用：DeepSeek V4 Pro 被错误归入 Claude Opus 的兼容分支，声明 Anthropic `web_search_20250305`，同时仍携带 DeepSeek `safety_check`。该分支还会移除自动标题、`latest_reminder` 和已读网页的调用/结果块。

已对照官方 [deepseek-ai/chat-demo 的原始基线](https://github.com/deepseek-ai/chat-demo/blob/5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c/src/services/chat/store.ts) 与 [当前 main](https://github.com/deepseek-ai/chat-demo/blob/8ad7b56e196b87d8a3215dc09476d6d146ad3f0e/src/services/chat/store.ts)。两者均默认声明 `deepseek_read_url`，开启搜索时再添加 `deepseek_web_search`，保留安全审核及自动标题，没有针对 Pro 改用 Anthropic 搜索工具。

## 修改范围

仅从 Claude 兼容分支中移除 DeepSeek Pro；保留既有第三方协议分流。Pro、Pro 日期后缀和 Flash 遵循官方 DeepSeek 扩展链路；关闭搜索只移除搜索工具，保留阅读链接。同步修正把错误行为当作预期的测试，新增真实 store → API → SSE → IndexedDB 的协议回归。

`ACCEPTANCE_0.1.17.md` 中关于 Pro 使用 Anthropic 搜索及删除提醒的结论有误，本记录予以更正。

## 验证

- 修复前：新增官方工具断言在 `deepseek-v4-pro` 上失败，复现错误的 `web_search_20250305` 声明。
- 接口/状态回归：Pro 与 Flash、搜索开关、思考开关共 8 种组合；校验工具互斥、思考参数、安全审核、自动标题、结果块、引用、网页签名及继续聊天。
- 附件/上下文回归：Pro 保留历史读链接块；旧图片补传、纯文字图片误报、长会话整理及续写仍由已有回归覆盖。
- 类型检查、lint：通过。
- 两轮完整 `pnpm test` 均通过 52 套回归；`git -c core.whitespace=trailing-space,space-before-tab,cr-at-eol diff --check` 通过（保留既有测试文件 CRLF）。
- ego-browser 使用独立 loopback origin 和模拟接口，经过设置保存 Pro、开启搜索和思考、点击发送，确认只发起 1 次请求，工具为官方 DeepSeek 类型，正文、来源引用和自动标题正常，未出现错误提示。桌面及 390 × 844 手机视口完成截图检查。
- 正常接口模式的本地开发预览已在 `http://localhost:8091/` 启动；浏览器测试响应未注入该正常预览页面。

## 边界

测试使用合成会话、隔离存储和确定性接口响应，没有使用真实 Key，也没有发送用户历史或产生模型费用；不代表真实账号的在线搜索已验收。当前修改尚未发布新 APK 或 Release。

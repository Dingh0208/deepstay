# Deepstay 与 dsh-Go 用户功能对照

核验日期：2026-11-20。对照对象是用户指定的 [`ccch1mneyyy/dsh-Go`](https://github.com/ccch1mneyyy/dsh-Go)，固定提交 `971b0d895f16035e356315b8af08fa3a12afe87c`，不是 DeepSeek 官方手机 App，也不是只对照上游 DeepSeek Harness。

Deepstay 一列依据本地当前代码；dsh-Go 一列依据该提交的文档及已读取的源码，未运行其安装包。“未核实”表示现有证据不足，不能据此认定对方没有此功能。本表说明已有能力与差异，不替代本轮发布测试结果。

| 用户功能 | Deepstay 当前代码 | dsh-Go 已核实情况及差异 | dsh-Go 证据 |
| --- | --- | --- | --- |
| 聊天背景与图片选区 | 自定义背景，支持裁剪选区 | 已有壁纸，覆盖首页、对话、抽屉；可拖动、双指缩放取景，并设置模糊、提亮、压暗 | [外观][appearance] |
| 全局字体与字号 | 全局字体与字号设置，提供跟随系统及设置预览 | 已有四档**对话内容**字号；全局字体选择、字号和系统字体跟随**未核实** | [外观][appearance] |
| 收藏指定聊天消息 | 收藏夹，长按后多选消息收藏 | 指定消息收藏**未核实**；角色收藏不能视为消息收藏 | [对话][chat]；已检索的收藏条目主要指角色 |
| 置顶会话 | 会话菜单置顶，列表置顶分组 | 长按会话可置顶，并支持文件夹、归档、多选 | [对话：整理对话列表][chat] |
| 长按编辑、重新生成 | 消息长按操作，支持编辑、重新生成 | 长按自己的消息可编辑后重发，长按 AI 回复可重新回答；两者均在**新对话**继续，原对话保留。重新回答仅最后一条可用，带文件时不可用；编辑需重加附件 | [对话：复制、引用与重新回答][chat] |
| 按整轮删除消息 | 删除一轮用户消息及对应回复 | 已确认整条会话永久删除；**按消息轮次删除未核实**，不能将会话删除视为同一功能 | [对话：整理对话列表][chat] |
| 一次选择多个附件 | 文件选择支持多选 | 单条消息最多 9 个附件；已读取附件源码支持多文件选择。Remote 是否能传普通文件还取决于主机能力 | [对话：图片、文件与语音][chat]；[附件源码][attachments] |
| 自动更新与版本记录 | 启动检查更新、设置更新提示、版本记录和更新后提示 | 自动检查默认开启，打开时检查、每天最多一次；可查看新版本内容并选择安装。应用内全部历史版本页、最近三版首次弹窗**未核实** | [设置：帮助与关于][settings] |
| 语音输入与朗读 | 语音输入、回复朗读及自动朗读开关 | 已有语音输入、逐条朗读、语音通话；可选择朗读声音和识别方式。逐条朗读不等于默认自动朗读 | [对话：朗读与语音通话][chat]；[设置：通用][settings] |
| 查询 DeepSeek 余额 | 接口设置可查询余额 | 设置顶部账号/API Key 卡展示余额；已有余额入口与查询异常状态处理 | [设置：顶部卡片][settings]；已核验 `app/lib/ui/chat/balance_widgets.dart` 搜索片段 |
| 历史导入预览与选择 | 显示待导入会话，可选择导入，保留原有本地记录，增量去重并展示进度 | 已有 Remote 对话备份与恢复，可选单条或整个工作区；每次恢复新建完整快照，不合并后续消息且不含附件。**DeepSeek 导出文件预览、选择及增量去重导入未核实** | [本机引擎与远程主机：对话备份与恢复][hosts] |
| 文件上传、重复读取与费用 | 本轮候选改动：文档默认文字识别，付费解析前确认；复用已有文件 ID；同文件引用去重；可暂停引用；失效文档不自动重新付费解析；大图生成安全副本 | 普通附件上传至 DSH 主机工作目录，再由主机工具按需读取；图片可直接供模型查看。它与 Deepstay 的云端文档解析、`file_id` 引用机制不同，不能直接照搬。两者后续读取/输入是否计费仍由服务商与请求内容决定 | [对话：图片、文件与语音][chat]；[附件源码][attachments]；[聊天状态源码][chat-state] |

当前可借鉴的做法是：清楚区分“上传到工作目录”和“交给模型读取”，只在明确的能力不支持时采用兼容路径，保留上传失败状态，避免业务失败后静默重传。Deepstay 本轮已围绕其云端接口采用独立实现，并未复制 dsh-Go 代码。

dsh-Go 主体代码为 AGPL-3.0，`sdk/`、`examples/` 另有 MIT 范围；若以后计划移植代码，需要按具体文件许可证处理。功能对照本身不构成代码移植。

[chat]: https://github.com/ccch1mneyyy/dsh-Go/blob/971b0d895f16035e356315b8af08fa3a12afe87c/docs/guide/zh/01-chat.md
[appearance]: https://github.com/ccch1mneyyy/dsh-Go/blob/971b0d895f16035e356315b8af08fa3a12afe87c/docs/guide/zh/09-appearance.md
[settings]: https://github.com/ccch1mneyyy/dsh-Go/blob/971b0d895f16035e356315b8af08fa3a12afe87c/docs/guide/zh/10-settings.md
[hosts]: https://github.com/ccch1mneyyy/dsh-Go/blob/971b0d895f16035e356315b8af08fa3a12afe87c/docs/guide/zh/03-engine-hosts.md
[attachments]: https://github.com/ccch1mneyyy/dsh-Go/blob/971b0d895f16035e356315b8af08fa3a12afe87c/app/lib/state/attachments.dart
[chat-state]: https://github.com/ccch1mneyyy/dsh-Go/blob/971b0d895f16035e356315b8af08fa3a12afe87c/app/lib/state/chat_state.dart

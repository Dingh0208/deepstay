# DSH Go 逻辑适配执行清单

核查日期：2026-11-20。对照固定到 DSH Go [`489346ac93f06ee3dec493a1c7d134882daebad2`](https://github.com/ccch1mneyyy/dsh-Go/commit/489346ac93f06ee3dec493a1c7d134882daebad2)，不追逐后续移动的 main。DeepStay 基线为 `a1d3b0a`（公开 v0.1.13）。本轮只有源码静态审查，没有运行 DSH Go；DeepStay 实测结果由各批验收记录补充。

用户要求是根据现有功能移植适用逻辑，沿用 DeepStay 界面，每三个改进发布一次。此处把“适用”限定为现有聊天、附件、导入、人物、设置、统计、存储和更新流程中有源码证据的缺口，不把另一应用的所有独立产品线视作待办，也不为凑三个重写已有实现。最后不足三个的剩余项作为尾批处理。

## 本轮确定的实施项

| ID | 批次 | 改进与来源 | 基线缺口 | 验收标准 | 状态 |
| --- | --- | --- | --- | --- | --- |
| P01 | 第一批 | 安装包更新完整性；用户优先故障，参考 [Go 的版本/文件/hash 绑定][update] | 原生下载和安装接受相等 versionCode；没有把清单目标版本绑定到 APK；固定缓存文件可能保留上次包 | 同版、旧版、清单目标不符、hash/包名/签名不符都不能进入更新安装；缓存恢复、重复点击、授权返回不换包；发布端核对真实 APK 元数据 | 已发布 v0.1.14 |
| P02 | 第一批 | 按渠道与模型保存上下文容量；[模型上下文页][model-context] | 全局 contextTokens 在不同 API 地址与模型间混用 | 同名模型在不同渠道隔离；重启保留；旧设置只迁移到原路由；压缩预算、发送预算与占用分母采用同一值 | 已发布 v0.1.14 |
| P03 | 第一批 | 文字草稿重启恢复；[草稿状态][drafts] | `drafts.ts` 只有进程内 Map，重启丢失输入 | 最近会话文字、新对话文字可恢复；发送/删除/清空后不复活；启动时新输入优先；附件仍按当前内存流程，不自动上传恢复附件 | 已发布 v0.1.14 |
| P04 | 第二批 | 下一次请求上下文预测与最近实测区分；[用量状态][usage] | 界面优先展示最近回复的请求样本；改系统设定、压缩或编辑历史后样本可能过时；无样本估算遍历完整可见历史而不应用已保存记忆 | 预测标明估算；最近实际值保留独立口径；复用现有记忆/请求选择规则；压缩后预测下降；分支、设定和附件引用变化能反映；不发模型请求、不触发收费解析 | 实施中 |
| P05 | 第二批 | 保留并正确标识最近成功余额；[余额控制器][balance] | 刷新和暂时网络失败直接替换成功结果，重新开窗每次都发查询 | 相同凭据下显示最近成功结果并标明刷新/过期状态；失败不能伪装为实时成功；换 Key/渠道不显示前一账号余额；并发与短时间重复查询复用；不把 Key 写日志或持久化缓存 | 实施中 |
| P06 | 第二批 | 诊断导出增加白名单运行环境；[诊断报告][diagnostics] | 只有 app 名、格式和 200 条操作代码，缺少版本及运行环境，难以定位旧 APK/WebView 差异 | 导出和分享包含同一份有限环境元数据；未知环境可省略；无 API Key、接口 URL、对话正文、附件路径或设备唯一标识 | 实施中 |
| P07 | 尾批 | 人物卡保留多开场并选择后开聊；[卡片映射][cards]、[开场选择][character-page]、[创建会话][engine-greeting] | 导入仅取一个 first_mes/alternate_greetings，其他文字被丢弃，导出无法恢复 | JSON/PNG/CHARX 的候选开场可预览和选择；导出导入往返保留；新聊天只写入选定开场；旧人物兼容；旧聊天人物快照不被模板修改影响 | 实施中 |

P01 的故障判断来自 DeepStay 当前代码，不把 Go 参考当作用户故障已复现的证明。P06 的 Go 字段主要是 App 版本、Host 运行时 ABI/引擎/Node 版本、连接与设置状态；DeepStay 没有 Host，适配为自身版本、平台及有限 WebView/浏览器环境，字段不会照搬。

各批必须完成专项回归、两轮全量回归与适当的网页/Android 验收，再递增版本和 versionCode 发布。Release、APK 元数据、签名、SHA-256、国内清单及完整下载校验需留下实际记录。不能把“代码已写”标成“已发布”。

## 已有功能覆盖与保留理由

| 覆盖面 | DSH Go 已核实机制与证据 | DeepStay 对照判断 |
| --- | --- | --- |
| 历史搜索覆盖 | Host 搜索，备用读取用户正文和助手预览；[搜索源码][search] | DeepStay 扫描全部本机会话、用户/助手正文及未选中分支，保留更完整覆盖，不改成预览搜索或 20 会话上限 |
| 搜索匹配与片段 | 全半角、大小写折叠，多词匹配，原文偏移与代理对边界；[搜索源码][search] | v0.1.13 已采用同等行为与回归，不重复移植 |
| 搜索排序与定位 | 标题更新时间、正文相关性排名；[搜索源码][search] | 用户已明确按消息时间排序并定位具体消息，保留现有行为，不覆盖成 Go 相关性排名 |
| 搜索请求生命周期 | 250ms 防抖、世代失效；[搜索控制器][search-control] | Sider 已 250ms 防抖、AbortController、忽略过期结果、取消与错误状态，保留 |
| 模型快速切换及异步隔离 | 精确 provider+model；选择器绑定主机/连接世代；[模型状态][models] | 输入区已有快速切换；useApiKeyForm 地址/Key 变更会中止并以控制器身份屏蔽迟到模型结果；单个当前连接下无需重建 Host 路由层；容量差距单列 P02 |
| 测试连接、模型列表与手填 | 按兼容协议拉取目录，缺模型时手填；[模型指南][model-guide] | 已有两种协议、测试、拉取、选择和自填；测试只读列表，不调用生成；保留 |
| 生成参数和全局设定 | Host 渠道/模型参数，酒馆生成预设；[模型指南][model-guide] | 已有 system、temperature、top-p、输出限制等，保持当前 API 协议适配；不引入酒馆完整预设引擎 |
| 手动/自动压缩和状态清理 | Host 执行 /compact；[压缩状态][pulse] 的 end/turn-end 清理；酒馆有独立提示装配链 | DeepStay 已有 /compact、详情页手动压缩、自动开关、批次进度、停止与 finally 清理，不把 Host RPC 的超时或事件模型强搬进直连 API |
| 会话内记忆与上下文选取 | 普通聊天压缩算法在锁定 Host 依赖内；酒馆 [提示准备][prompt-preparation] 还包括世界书、脚本、宏等 | 保留已实现的 Hermes 增量记忆、原文引用验证、分支隔离、开头/近期原文与失败冷却。未证明 Go 的事实/情感记忆质量更好，不以 UI 同名替换算法；统计差距单列 P04 |
| 缓存命中率与单轮 token | [SessionUsage][usage] 用会话累计 uncached/cache-read/cache-write 计算 | 当前使用最近一轮最终 usage，生成中待结算，缺字段不冒充 0%。两者口径不同，保留用户已经验收的单轮口径，不混入累计数 |
| 流式 usage、截断、200 错误 | 酒馆 [model_client][model-client] 先解析顶层 usage，支持空 choices 尾包，识别错误及截断 | DeepStay 已有同等 SSE/usage 合并、错误分类和截断回归，保留独立实现 |
| 流式渲染与长列表 | [chat_state][chat-state] 约 32ms 批次刷新及行缓存 | 已有 animation frame 合并、让出主线程、24/48 条窗口、memo、来源数组与 Markdown AST 复用，不把固定 32ms 变成高刷限制 |
| 会话写入与失败处理 | 普通会话保存在 Host，未知发布结果有单独处理；本次前述存储补丁详见 [旧机制审查](DSH_GO_COMPARISON.md) | IndexedDB strict 原子事务、摘要按需恢复、失败保留未保存会话并重试；无需移植 Node fsync 或整个事件存储；文字草稿漏持久化单列 P03 |
| ZIP 历史导入 | 酒馆 [DeepSeek 导入][deepseek-import] 串行、来源 ID 去重、保留分支，重复导入打开已有 | DeepStay 已有预览选择、进度、串行暂存/事务提交和增量去重，保留本地已有会话与用户后续消息；不退化为仅跳过旧来源 |
| 大文件导入 | 酒馆文件解析使用 Isolate，另将导入操作串行排队；[导入源码][deepseek-import] | 用户已明确保留官方串行新增导入+进度条，不重新引入多 CPU 并发/后台导入；DeepStay 已流式 ZIP 和有界暂存，保留 |
| 附件多选与失败重试 | [附件状态][attachments] 与 [附件视图][attachment-view]，上传到 Host 工作目录 | 已有多选、失败状态、明确重试；Files API 与 Host 工作目录协议不同，不能直接换协议 |
| 文件费用和重复引用 | Host 工具按需读取；酒馆/普通聊天路径不同 | v0.1.13 已有文字优先、解析确认、file_id 复用与去重、暂停/恢复引用、失效文档禁止静默付费重传，不承诺后续模型输入免费 |
| 大图与原件 | Host 图片可直接查看，附件路径与媒体类型分离 | 已有发送副本限边、原件在 IndexedDB/导出保留，尺寸和不支持图片错误分类保留；不为了同名功能替换处理链 |
| 人物模板与会话隔离 | 酒馆创建/生成依赖当前角色库，删人物可删其聊天；[engine][engine-greeting] | DeepStay 会话持有人物快照、删模板保留聊天符合既有需求，保留此语义；多开场文字漏保留单列 P07 |
| 长按编辑、重新生成和版本 | 普通 Host 通过 fork 后重发；[regenerate][regenerate]；酒馆另有树分支 | 已有原会话分支、编辑/重生成、版本切换及选中位置保持；不改成新建独立会话，不删除附件能力 |
| 单轮删除、多选与收藏夹 | 普通会话删除，酒馆单条/此后删除及书签；[消息菜单][message-menu] | 已有按整轮删、选多条收藏/删及跨会话收藏夹，覆盖此前明确需求，保留 |
| 会话置顶和时间分组 | Go 另有文件夹/归档，列表由 [sessions_state][sessions] 管理 | DeepStay 已有置顶分组、按时间分组、菜单取消置顶，保留；文件夹/归档是新整理方式，不为移植现有置顶而附加 |
| 自定义背景与选区 | [壁纸状态][wallpaper]、[渲染][wallpaper-render] 支持拖动/缩放、亮度/模糊与烘焙 | 已有选区、缩放、输出尺寸限制、本地存储和背景覆盖；Go 视觉配色/模糊/瓦片设计不在“只移植逻辑、UI不换”的范围 |
| 字体、字号与系统跟随 | [外观指南][appearance-guide] 只承诺四档对话字号 | DeepStay 已有全局字体、字号预览与系统跟随，覆盖更广；不倒退为仅聊天四档字体 |
| 高刷新率 | [refresh_rate][refresh-rate] 有自动/最高/系统模式，Flutter 帧回调 | DeepStay 已按用户要求请求当前分辨率最高刷新率、Web 使用 RAF，无固定 60fps 上限；Flutter 帧事件不适合原样移植，不追加新的性能设置 |
| 朗读与语音输入 | [聊天指南][chat-guide] 支持逐条朗读、语音输入及通话 | 已有语音输入、逐条朗读和自动朗读开关、切会话/后台停止、凭据变化取消；保留；通话与本地ASR引擎属新产品能力 |
| 更新记录和发现更新 | [update_state][update] 绑定发布目标与下载文件、检查节流和错误状态 | DeepStay 已启动/前台检查、设置提示、完整更新历史与近三版弹窗；继续按用户要求每次进入检查，不照搬每天一次；安装绑定差距列 P01 |
| 导出和分享诊断 | [诊断页][diagnostics] 包含运行状态、白名单设置及脱敏 | 已有最近 200 条日志、原生/网页导出分享，保持不含正文与凭据的范围；环境信息差距列 P06 |
| 设置分组 | [设置指南][settings-guide] 按 AI/能力/外观/通用/主机/帮助分组 | DeepStay 已按本项目功能分组；主机、手机操控等不存在的模块不加空分类。Go 的设置搜索/全部功能面板是新入口，未作为已有设置逻辑缺陷 |

## 不移植的结构和行为

- Host RPC、远程主机、Linux/终端、手机操控、权限系统、插件市场、定时 Agent、工作区、社区、分享服务、宠物、生成图片/视频、订阅登录是独立架构或新产品能力，当前直接调用模型与本地 IndexedDB 不需要这些依赖。
- 世界书、脚本、正则执行、群聊、游戏/MVU、跨会话记忆、动态全局人物追随不在当前人物文字预设范围；用户此前明确只需会话内记忆。
- 不采用删除人物级联删除历史、不采用正文相关性取代时间排序、不用 Go 默认自动收起思考替代用户已确认“思考功能默认关、开启后默认展开”。
- 根代码许可仍为 AGPL-3.0；搜索、诊断页等少量文件有独立 MIT 头。各适配项依据行为独立实现，不把 AGPL 核心代码或品牌素材复制进当前 MIT 工程。既有 `docs/DSH_GO_COMPARISON.md` 保留旧固定版本的历史证据，本清单用于新固定版本的本轮执行。

## 审查证据与边界

已读取固定 SHA 的完整目录树，并读取以下相关源码/文档：models、model-context、usage、update-state/version/release/downloader、balance、drafts、search、run-pulse、chat-state、regenerate、sessions、session-deletion、read-list-cache、appearance、wallpaper-state/render、attachments/state/view、message-menu、diagnostics、refresh-rate、酒馆 card-codec/character-page/engine/deepseek-import/prompt-preparation/model-client，以及中文聊天/模型/外观/设置/酒馆/全部功能指南、LICENSE、ASSETS。源文件只读缓存位于本机验收目录，未进入公开仓库。

未把“看起来相同”视作实测通过，也未断言另一应用的主机存储和记忆算法已经在此设备验证。此清单的完成条件是 P01–P07 都有对应实现、回归与发布记录；“保留”行表示已审查并有具体理由，不是尚未完成的隐藏待办。

[update]: https://github.com/ccch1mneyyy/dsh-Go/blob/489346ac93f06ee3dec493a1c7d134882daebad2/app/lib/state/update_state.dart#L254
[model-context]: https://github.com/ccch1mneyyy/dsh-Go/blob/489346ac93f06ee3dec493a1c7d134882daebad2/app/lib/ui/providers/model_context_page.dart#L1
[drafts]: https://github.com/ccch1mneyyy/dsh-Go/blob/489346ac93f06ee3dec493a1c7d134882daebad2/app/lib/state/draft_store.dart#L34
[usage]: https://github.com/ccch1mneyyy/dsh-Go/blob/489346ac93f06ee3dec493a1c7d134882daebad2/app/lib/state/usage_state.dart#L69
[balance]: https://github.com/ccch1mneyyy/dsh-Go/blob/489346ac93f06ee3dec493a1c7d134882daebad2/app/lib/state/balance_state.dart#L224
[diagnostics]: https://github.com/ccch1mneyyy/dsh-Go/blob/489346ac93f06ee3dec493a1c7d134882daebad2/app/lib/ui/settings/diagnostics_page.dart#L41
[cards]: https://github.com/ccch1mneyyy/dsh-Go/blob/489346ac93f06ee3dec493a1c7d134882daebad2/packages/dsh_tavern/lib/src/io/card_codec.dart#L168
[character-page]: https://github.com/ccch1mneyyy/dsh-Go/blob/489346ac93f06ee3dec493a1c7d134882daebad2/app/lib/ui/tavern/tavern_character_page.dart#L84
[engine-greeting]: https://github.com/ccch1mneyyy/dsh-Go/blob/489346ac93f06ee3dec493a1c7d134882daebad2/packages/dsh_tavern/lib/src/engine.dart#L1272
[search]: https://github.com/ccch1mneyyy/dsh-Go/blob/489346ac93f06ee3dec493a1c7d134882daebad2/app/lib/state/session_search.dart
[search-control]: https://github.com/ccch1mneyyy/dsh-Go/blob/489346ac93f06ee3dec493a1c7d134882daebad2/app/lib/state/session_search.dart#L897
[models]: https://github.com/ccch1mneyyy/dsh-Go/blob/489346ac93f06ee3dec493a1c7d134882daebad2/app/lib/state/models_state.dart#L72
[model-guide]: https://github.com/ccch1mneyyy/dsh-Go/blob/489346ac93f06ee3dec493a1c7d134882daebad2/docs/guide/zh/02-models.md
[pulse]: https://github.com/ccch1mneyyy/dsh-Go/blob/489346ac93f06ee3dec493a1c7d134882daebad2/app/lib/state/run_pulse.dart#L309
[prompt-preparation]: https://github.com/ccch1mneyyy/dsh-Go/blob/489346ac93f06ee3dec493a1c7d134882daebad2/packages/dsh_tavern/lib/src/engine_prompt_preparation.dart
[model-client]: https://github.com/ccch1mneyyy/dsh-Go/blob/489346ac93f06ee3dec493a1c7d134882daebad2/packages/dsh_tavern/lib/src/llm/model_client.dart#L377
[chat-state]: https://github.com/ccch1mneyyy/dsh-Go/blob/489346ac93f06ee3dec493a1c7d134882daebad2/app/lib/state/chat_state.dart#L1157
[deepseek-import]: https://github.com/ccch1mneyyy/dsh-Go/blob/489346ac93f06ee3dec493a1c7d134882daebad2/packages/dsh_tavern/lib/src/engine_deepseek_import.dart
[attachments]: https://github.com/ccch1mneyyy/dsh-Go/blob/489346ac93f06ee3dec493a1c7d134882daebad2/app/lib/state/attachments.dart
[attachment-view]: https://github.com/ccch1mneyyy/dsh-Go/blob/489346ac93f06ee3dec493a1c7d134882daebad2/app/lib/ui/chat/widgets/attachments.dart
[regenerate]: https://github.com/ccch1mneyyy/dsh-Go/blob/489346ac93f06ee3dec493a1c7d134882daebad2/app/lib/state/regenerate.dart
[message-menu]: https://github.com/ccch1mneyyy/dsh-Go/blob/489346ac93f06ee3dec493a1c7d134882daebad2/app/lib/ui/chat/widgets/message_menu.dart
[sessions]: https://github.com/ccch1mneyyy/dsh-Go/blob/489346ac93f06ee3dec493a1c7d134882daebad2/app/lib/state/sessions_state.dart
[wallpaper]: https://github.com/ccch1mneyyy/dsh-Go/blob/489346ac93f06ee3dec493a1c7d134882daebad2/app/lib/state/wallpaper_state.dart
[wallpaper-render]: https://github.com/ccch1mneyyy/dsh-Go/blob/489346ac93f06ee3dec493a1c7d134882daebad2/app/lib/wallpaper/wallpaper_render.dart
[appearance-guide]: https://github.com/ccch1mneyyy/dsh-Go/blob/489346ac93f06ee3dec493a1c7d134882daebad2/docs/guide/zh/09-appearance.md
[refresh-rate]: https://github.com/ccch1mneyyy/dsh-Go/blob/489346ac93f06ee3dec493a1c7d134882daebad2/app/lib/performance/refresh_rate.dart
[chat-guide]: https://github.com/ccch1mneyyy/dsh-Go/blob/489346ac93f06ee3dec493a1c7d134882daebad2/docs/guide/zh/01-chat.md
[settings-guide]: https://github.com/ccch1mneyyy/dsh-Go/blob/489346ac93f06ee3dec493a1c7d134882daebad2/docs/guide/zh/10-settings.md


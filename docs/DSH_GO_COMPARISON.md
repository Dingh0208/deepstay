# DSH Go 与 DeepStay：已验证的重叠功能比较

核查日期：2026-11-20。DSH Go 固定提交为 [`971b0d895f16035e356315b8af08fa3a12afe87c`](https://github.com/ccch1mneyyy/dsh-Go/commit/971b0d895f16035e356315b8af08fa3a12afe87c)，默认分支 main，当次最新提交时间为 2026-11-20 11:26:33 UTC。下列 GitHub 链接全部固定到该提交。DeepStay 对照基线为 `41ceb5cd6317aad323d37110371c9f8c5ec99af7` 加本轮附件修复工作区；本文件只做静态实现审查，不宣称已运行 DSH Go。

## 结论与适用边界

重叠功能采用行为参考、适配当前架构。DeepStay 已覆盖更完整的地方保留现有实现；不能因功能同名就重写。DSH Go 普通聊天是 Flutter 界面连接 DSH Host，引擎负责上下文、会话存储与模型请求；DeepStay 是 React/Capacitor 直接调用模型，使用 IndexedDB 保存本机会话。DSH Go 的 RPC、原生文件系统、Riverpod 和 Flutter 组件不适合直接替换这里的服务层。

DSH Go 还存在独立的酒馆引擎 `packages/dsh_tavern`，它和普通 DSH Host 聊天不能混为同一条实现链。下表在引用酒馆代码时明确标出。

背景、字体、收藏、置顶、编辑、更新、语音、余额及导入等用户功能另见[功能清单对照](DSH_GO_FEATURES.md)。

## 许可核查

- 根目录 [LICENSE](https://github.com/ccch1mneyyy/dsh-Go/blob/971b0d895f16035e356315b8af08fa3a12afe87c/LICENSE) 为 AGPL-3.0；README 明确 `sdk/`、`examples/` 保持 MIT，第三方文件依自身声明。DeepStay 当前根许可为 MIT，因此直接复制 AGPL 实现需要先处理衍生代码的许可和声明，不能只加一个来源链接就继续当 MIT 发布。
- 搜索模块 [`app/lib/state/session_search.dart` 第 1–3 行](https://github.com/ccch1mneyyy/dsh-Go/blob/971b0d895f16035e356315b8af08fa3a12afe87c/app/lib/state/session_search.dart#L1) 单独声明 `SPDX-License-Identifier: MIT`、版权 DeepSeek。[THIRD_PARTY_NOTICES 的 DeepSeek Harness 段](https://github.com/ccch1mneyyy/dsh-Go/blob/971b0d895f16035e356315b8af08fa3a12afe87c/THIRD_PARTY_NOTICES.md#L82) 确认它的结果合并逻辑来自官方 `@deepseek-ai/dsh-client-ui-workspace`。这部分可以在保留 MIT 版权与许可的前提下单独评估，不能据此把整个仓库视为 MIT。
- [ASSETS.md](https://github.com/ccch1mneyyy/dsh-Go/blob/971b0d895f16035e356315b8af08fa3a12afe87c/ASSETS.md) 将名称、品牌、Deepy、鲸娘等素材排除在代码许可之外，本项目不移植这些资源。README 说明“提前联系作者”是协作请求，不是对代码许可证追加的限制；本次只读研究没有向作者发送消息。

## 重叠功能矩阵

| 功能 | DSH Go 的已验证机制 | DeepStay 的当前机制 | 判断与适配方式 | 代码证据、许可 |
| --- | --- | --- | --- | --- |
| 1. 历史搜索覆盖 | 普通 Host 可调用 `session/search`；不可用时扫描用户文本和助手预览的投影缓存。备用搜索默认只返回 20 个会话，并返回 `hasMore`。 | 逐个读取本机全部会话正文，检查用户和助手文本，覆盖未选中分支；每条命中带消息 ID。 | 保留 DeepStay 的全正文与分支覆盖，不用预览或 20 个会话上限替代。 | [Go 搜索备用实现 L505](https://github.com/ccch1mneyyy/dsh-Go/blob/971b0d895f16035e356315b8af08fa3a12afe87c/app/lib/state/session_search.dart#L505)、[Host 搜索协议 L405](https://github.com/ccch1mneyyy/dsh-Go/blob/971b0d895f16035e356315b8af08fa3a12afe87c/packages/dsh_client/lib/src/session_api.dart#L405)；前者 MIT，后者根许可。DeepStay：`src/services/chat/historySearch.ts`。 |
| 2. 搜索匹配与原文片段 | 忽略大小写、折叠全角 ASCII/全角空格；UTF-16 长度保持不变，匹配位置仍指向原文；空白分词后支持多词匹配。 | 本轮已独立实现全半角、大小写折叠与同条消息多词 AND；片段仍来自原文，边缘不截断表情代理对。 | 采用该匹配行为，保留原文偏移、全会话覆盖与时间排序。新增中文多词、全半角、长度变化大小写及表情测试。 | [Go `foldForSearch` L32](https://github.com/ccch1mneyyy/dsh-Go/blob/971b0d895f16035e356315b8af08fa3a12afe87c/app/lib/state/session_search.dart#L32)，MIT。DeepStay：`historySearch.ts`。 |
| 3. 搜索排序与定位 | 标题命中按会话更新时间；正文备用搜索依次按命中用户/助手层级、出现次数、长度、更新时间排名，一会话一个片段。 | 所有消息命中按消息时间倒序，可定位到具体消息，符合此前明确要求。 | 保留当前时间排序和消息定位；不照搬 Go 相关性排序覆盖用户已确认需求。可参考片段窗口边界处理。 | [Go 结果合并 L218](https://github.com/ccch1mneyyy/dsh-Go/blob/971b0d895f16035e356315b8af08fa3a12afe87c/app/lib/state/session_search.dart#L218)、[备用排名 L648](https://github.com/ccch1mneyyy/dsh-Go/blob/971b0d895f16035e356315b8af08fa3a12afe87c/app/lib/state/session_search.dart#L648)，MIT。 |
| 4. 模型快速切换 | 使用精确 `provider + model` 路由；选择器绑定当前主机/连接世代，重连时使选择失效，避免旧回调改写新主机。 | 输入区已有模型选择，连接设置保存当前地址、协议、模型列表；发送时固定本次请求配置。 | 现有快速切换不重写。未来增加多渠道后，参考路由标识与过期响应保护，不能只凭模型同名合并。 | [Go `modelSelectionScopeProvider` L72](https://github.com/ccch1mneyyy/dsh-Go/blob/971b0d895f16035e356315b8af08fa3a12afe87c/app/lib/state/models_state.dart#L72)、[`findModel` L117](https://github.com/ccch1mneyyy/dsh-Go/blob/971b0d895f16035e356315b8af08fa3a12afe87c/app/lib/state/models_state.dart#L117)，未见单独许可，按根许可。DeepStay：`ChatInput.tsx`、`settings.ts`、`chat/store.ts`。 |
| 5. 模型上下文参数 | 能按 `route.modelOverrides.modelId.contextWindow` 覆盖上下文窗口；注释明确同时影响引擎压缩和用量显示，下次请求生效。 | 自定义上下文容量是全局生成参数，缺省 1M；遇到接口 token 上限会学习当前路由预算并裁剪发送历史。 | 值得后续把上下文容量按渠道/模型保存，统一显示、自动压缩与请求预算；本轮不把它变成只影响进度环的展示参数。 | [Go 模型窗口页 L1](https://github.com/ccch1mneyyy/dsh-Go/blob/971b0d895f16035e356315b8af08fa3a12afe87c/app/lib/ui/providers/model_context_page.dart#L1)，根许可。DeepStay：`api/generation.ts`、`chat/contextLimit.ts`、`chat/store.ts`。 |
| 6. 手动上下文压缩 | `/compact` 经 Host `commands/execute`；客户端给它 30 分钟专用 RPC 时限，避免普通请求超时取消压缩。 | `/compact` 和上下文详情页均可压缩当前分支；使用独立辅助模型请求、停止按钮和结果持久化。 | 保留 DeepStay 实现。Go 是长任务 RPC，不应把其 30 分钟直接设成这里所有模型请求超时。 | [Go `executeCommand` L850](https://github.com/ccch1mneyyy/dsh-Go/blob/971b0d895f16035e356315b8af08fa3a12afe87c/packages/dsh_client/lib/src/session_api.dart#L850)，根许可。DeepStay：`contextMemory.ts`、`store.ts`、`docs/CONTEXT_COMPACTION.md`。 |
| 7. 压缩状态显示 | 读取 `compaction/start`、`compaction/end`，`turn/end` 也能清理残留压缩状态，避免一直显示进行中。 | 有“正在进行上下文压缩，请稍等”和批次进度；finally 清理准备状态。 | 参考完整状态生命周期与中断后清理测试；已有文字与进度保留，不因同名重写。 | [Go `compactingAfter` L309](https://github.com/ccch1mneyyy/dsh-Go/blob/971b0d895f16035e356315b8af08fa3a12afe87c/app/lib/state/run_pulse.dart#L309)，根许可。DeepStay：`chat/store.ts`。 |
| 8. 会话记忆与自动压缩算法 | 已读 Go 代码证明压缩由 Host 执行，运行时依赖锁定 `@deepseek-ai/dsh@0.2.2-rc.1`；Go 状态层未包含可直接证明的完整自动触发阈值、摘要提示和事实抽取算法。酒馆又是另一套引擎。 | 当前分支内记录、来源引用校验、原文召回、保留开头与近期原文；增量 checkpoint、至少四新轮次和失败冷却。 | 不能声称 DSH Go 记忆更好，也不凭 UI 的 `/compact` 就替换 Hermes 方案。若要进一步比较算法，必须另审该锁定 Host 版本及酒馆实际生成链，验证情感和事实保留。 | [Go 依赖锁输入](https://github.com/ccch1mneyyy/dsh-Go/blob/971b0d895f16035e356315b8af08fa3a12afe87c/runtime/locks/dsh-0.2.2-rc.1/package.json)、上行 RPC；DeepStay：`contextMemory.ts`、`memoryRecords.ts`、`memoryRecall.ts`，MIT。 |
| 9. 缓存命中率口径 | `SessionUsage` 使用整个会话累计数：`cacheRead / (uncachedInput + cacheRead + cacheWrite)`，不是单轮百分比。 | 使用最新完成回复的最终 usage；生成中不展示临时 cache 计数，以免结束瞬间跳变。 | 两边口径不同。保留当前单轮最终口径；若以后增加累计统计，另列“本轮/累计”，不能混算或把缺省当 0%。 | [Go `SessionUsage` L62](https://github.com/ccch1mneyyy/dsh-Go/blob/971b0d895f16035e356315b8af08fa3a12afe87c/app/lib/state/usage_state.dart#L62)、[累计 UI L549](https://github.com/ccch1mneyyy/dsh-Go/blob/971b0d895f16035e356315b8af08fa3a12afe87c/app/lib/ui/chat/usage_sheet.dart#L549)，根许可。DeepStay：`replyMetrics.ts`、`api/usage.ts`。 |
| 10. 上下文占用显示 | 明确区分最近请求占用 `pressureTokens` 与下一次请求预测 `projectedTokens`，优先显示预测；详情页标记来自哪种口径。 | 有实际最终 usage 与本地请求估算、系统/工具/消息拆分；文档估算不能当作真实解析 token。 | 值得参考“最近实际/下次估算”明确标记，避免旧回复统计被误读成修改附件后的下一请求成本。不能从 Go 的 Host 投影字段凭空得到这里的附件真实 token。 | [Go 占用字段 L69](https://github.com/ccch1mneyyy/dsh-Go/blob/971b0d895f16035e356315b8af08fa3a12afe87c/app/lib/state/usage_state.dart#L69)、[UI 口径 L442](https://github.com/ccch1mneyyy/dsh-Go/blob/971b0d895f16035e356315b8af08fa3a12afe87c/app/lib/ui/chat/usage_sheet.dart#L442)，根许可。DeepStay：`replyMetrics.ts`、`contextMemory.ts`。 |
| 11. 流式用量与错误 | 酒馆模型适配器在处理 choices 前读取顶层 usage，支持 `choices: []` 的尾部计数；HTTP 200 body.error 仍抛错误；缺 finish/DONE 时不当作成功。 | OpenAI 适配已有尾部 usage 合并、显式缓存计数优先、HTTP 200 错误体识别和截断流错误。本轮再补尺寸错误的 HTTP 200 分类。 | 行为一致，保留现有实现与回归；不复制另一套 Dart SSE 解析器。可借其“usage 与 choices 独立”的边界案例。 | [Go 酒馆适配 L377](https://github.com/ccch1mneyyy/dsh-Go/blob/971b0d895f16035e356315b8af08fa3a12afe87c/packages/dsh_tavern/lib/src/llm/model_client.dart#L377)、[截断检查 L425](https://github.com/ccch1mneyyy/dsh-Go/blob/971b0d895f16035e356315b8af08fa3a12afe87c/packages/dsh_tavern/lib/src/llm/model_client.dart#L425)，根 AGPL。DeepStay：`api/openai.ts`、`api/http.ts`。 |
| 12. 流式刷新性能 | 普通聊天使用约 32ms 批量刷新；记录/投影与显示状态分离，另有聊天行缓存。 | 增量在 animation frame 提交，并在大批事件后让出浏览器；长列表另有按窗口渲染。 | 借鉴缓存边界和只刷新尾部的测试思想，不把32ms照搬成全局30帧限制，避免损害高刷设备。 | [Go `chat_state.dart` L1157](https://github.com/ccch1mneyyy/dsh-Go/blob/971b0d895f16035e356315b8af08fa3a12afe87c/app/lib/state/chat_state.dart#L1157)，根许可。DeepStay：`chat/store.ts`、消息列表组件。 |
| 13. 会话持久化与未知写入结果 | 普通会话由 Host 存储；仓库补丁对 rename 后目录 fsync 失败产生 `unknown-state`，并把对应 storage unit 标为不可继续使用，避免把“不知道是否持久化”当成功。App 的 SharedPreferences 主要保存当前主机/会话选择。 | IndexedDB strict 事务原子保存会话、摘要、附件与记忆版本；保存失败记录未保存会话并显示重试入口。 | 参考错误注入和恢复验收，不移植 Node fsync/文件锁来替代 IndexedDB。两边机制不同，静态阅读不能证明任一方真机永不丢数据。 | [Go 存储补丁](https://github.com/ccch1mneyyy/dsh-Go/blob/971b0d895f16035e356315b8af08fa3a12afe87c/runtime/patches/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-storage-json-postpublish.diff)、[当前会话选择 L947](https://github.com/ccch1mneyyy/dsh-Go/blob/971b0d895f16035e356315b8af08fa3a12afe87c/app/lib/state/sessions_state.dart#L947)，补丁上游为MIT包，Go修改按根许可单独评估。DeepStay：`chat/db.ts`、`chat/store.ts`。 |
| 14. 文件与费用（本轮） | 不能把 Go 的本机 Host/工具工作区读取，与官方 Files API 的按页解析、file_id 模型输入当作同一个计费协议。附件专项由另一份核查负责。 | 本轮默认文字解析、用户主动选图文解析、解析前确认、复用 file_id、文档暂停/恢复引用、请求内同file_id去重、收费文档不静默重传。 | 采用与当前官方协议兼容的设计；图片安全预处理和按次重试约束保留。用户提“参考 Go”不构成改用另一文件协议或承诺上传后永不计费。 | DeepStay：`attachments.ts`、`chat/reply.ts`、`chat/store.ts`、`imageUpload.ts`。Go架构证据：[architecture §5](https://github.com/ccch1mneyyy/dsh-Go/blob/971b0d895f16035e356315b8af08fa3a12afe87c/docs/architecture.md)。 |

## 建议采用的顺序

1. 本轮交付附件上传与费用修复，并参考 Go 增加全半角/多词搜索；保留用户已确认的消息时间排序、单轮最终 usage、会话内分支记忆和 IndexedDB 事务。
2. 后续可评估明确的实际/估算上下文标签、按渠道和模型保存窗口容量；它们涉及统计口径与配置归属，不能直接照搬 Host 字段。
3. 持久化事件日志、大型 Host 引擎和跨会话记忆涉及架构及产品范围，不能因为对方有同名模块就纳入本轮。

## 验证范围

本次通过官方 GitHub 连接器读取固定提交的 README、LICENSE、ASSETS、THIRD_PARTY_NOTICES、完整目录树，以及上表列出的实现文件。没有运行或构建 DSH Go，没有调用用户真实模型接口，没有把“README 宣称”当作性能、记忆质量或稳定性的实测证据。本轮功能测试以 DeepStay 的自动化回归及浏览器/Android 验收记录为准。

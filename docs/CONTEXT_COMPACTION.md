# 压缩触发、预算和记忆保留

DeepStay 默认关闭自动上下文压缩。在聊天中单独发送 `/compact` 可以主动整理当前分支。它占用与发送共用的停止按钮，不创建问题或回复。关闭自动压缩后，后续发送仍会复用当前分支已成功保存的压缩结果。

自动模式首次在估算输入达到约 24,000 tokens 时准备压缩。成功后保存最近原文的起点和当时最后一轮的标记，后续用保留的对话估算压力。此后至少有四个新的完整轮次并且再次接近预算，才发起下一次自动整理。整理一次只发起一个辅助请求，历史原文样本约 6,000 估算 tokens，输出上限 2,048 tokens，关闭思考。接口超时、取消、抽取失败后，同一会话和路由在本次应用运行中五分钟内不自动重试。用户可主动再输入命令。

模型收到开场用户原话节选、最近的完整原文轮次、已核验的会话记忆与相关原文。整理提示优先保留称呼、自称、人物和关系设定、互动边界、情绪脉络、约定和更正。已整理的片段不重复提交；超长记录只抽样整理，缺少覆盖时不会把历史记录认作最新事实。原始消息和附件可在当前会话中查看。真实模型对语气和记忆的表现仍会受模型及对话内容影响。

这套设计参考 Hermes 保留开头和尾部、留出后续输入空间、区分持久记忆和会话摘要的做法。DeepStay 把原文检索和事实校验限定在当前会话的当前分支，并复用已经验证的分段而无需重写一份总摘要。参考 [Hermes 上下文压缩与缓存](https://hermesagent.org.cn/docs/developer-guide/context-compression-and-caching)、[官方压缩器源码](https://github.com/NousResearch/hermes-agent/blob/main/agent/context_compressor.py)和 [Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)。

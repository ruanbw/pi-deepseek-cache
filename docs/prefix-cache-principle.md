# 前缀缓存（Prefix Cache）原理

> 本文提炼自 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 全库的文档、代码注释与官方 API 文档，解释 DeepSeek 前缀缓存为何能让长会话的大部分输入按缓存命中费率结算，以及在 Harness / Pi 扩展中如何保住它。
>
> 官方 Ground Truth：[Context Caching — DeepSeek API Docs](https://api-docs.deepseek.com/guides/kv_cache)（本文第 2 章逐字摘录 /tmp/kv.html，原站 Docusaurus v3.1.0 渲染页）

---

## 1. 原理

### 1.1 KV Cache 本质 — Transformer Key/Value 复用

Transformer 自回归推理时，每个 token 的注意力计算都需要历史 token 的 **Key / Value** 向量。首轮推理（prefill）会为 prompt 中所有 token 计算并缓存 KV；后续生成只计算新 token 的 Q，与缓存的 KV 做注意力。

- **逐 token 增量**：若第 N 轮请求的前缀与第 N-1 轮完全一致，服务端可直接复用已计算的 KV，无需重新做 prefill。
- **前缀增量追加**：Harness 以 Message 数组追加式会话为单位，system 到历史 messages 到 tools 构成请求前缀（见 packages/llm/llm/src/types.ts 的 GenerateOptions），历史只增不改，天生适合 prefix cache。

> 依据：docs/subsystems/llm-streaming.md 将 Message/ContentBlock 定义为每个请求与持久化历史共享的同一表示；所有可重用前缀注释遍布数十个包的 KV Cache effect 小节。

### 1.2 DeepSeek 服务端磁盘缓存机制

DeepSeek 在 API 侧实现 **Context Caching on Disk**（硬盘缓存），与常见的显存 KV Cache 不同：

| 特性 | 说明 |
|------|------|
| 默认开启 | 无需改代码、无需传参即生效（api-docs.deepseek.com/guides/kv_cache） |
| 硬盘持久化 | 每次请求触发一次硬盘缓存构建；后续请求须**完整匹配**某个已落盘的 cache prefix unit 才计为 cache hit |
| 前缀单元独立完整 | 受 Sliding Window Attention 机制影响，每个已缓存前缀是独立完整的单元，不存在“任意重叠即复用” |
| 不要求显式会话 ID | 命中不依赖会话标识，只取决于请求前缀字节序列 |
| 输出仍需推理 | 缓存只加速输入的 prefill，输出仍通过计算生成，受 temperature 等参数影响 |
| Best-effort | 不保证 100% 命中；未使用的缓存条目数小时至数日内自动清理 |

> 官方原文摘录（api-docs.deepseek.com/guides/kv_cache 为当前口径；news0802 为 2024 首发口径，部分表述已被前者取代）：
> - The DeepSeek API Context Caching on Disk Technology is enabled by default for all users.
> - Each user request will trigger the construction of a hard disk cache. If subsequent requests have overlapping prefixes with previous requests, the overlapping part will only be fetched from the cache, which counts as a cache hit. 〔首段总述，仍成立〕
> - Due to the Sliding Window Attention mechanism, the storage and matching of cached prefixes differs from before. Each cached prefix is an independent, complete unit. A subsequent request can only hit the cache if it **fully matches** a cache prefix unit. 〔当前口径；与上方“任意重叠即复用”相反，以本条为准〕
> - The cache system works on a best-effort basis and does not guarantee a 100% cache hit rate.
> - The cache system uses 64 tokens as a storage unit; content less than 64 tokens will not be cached. 〔仅见于 news0802，现行 kv_cache 指南已不再列出此条，见 3.3〕

---

## 2. 官方原文逐字摘录（Ground Truth）

> 本章为 /tmp/kv.html 中 https://api-docs.deepseek.com/guides/kv_cache 页面正文的精确摘录，已去除 Docusaurus 导航与样式，仅保留语义。引用时请以线上官方文档为准。

### 2.1 概述

> The DeepSeek API Context Caching on Disk Technology is enabled by default for all users, allowing them to benefit without needing to modify their code.
>
> Each user request will trigger the construction of a hard disk cache. If subsequent requests have overlapping prefixes with previous requests, the overlapping part will only be fetched from the cache, which counts as a cache hit.

来源：https://api-docs.deepseek.com/guides/kv_cache 首段。

### 2.2 Cache Persistence and Hit Rules（缓存持久化与命中规则）

> A cache hit requires that the corresponding prefix has already been persisted (written to the disk cache). Due to the Sliding Window Attention mechanism, the storage and matching of cached prefixes differs from before. Each cached prefix is an independent, complete unit. A subsequent request can only hit the cache if it fully matches a cache prefix unit.

#### 2.2.1 三种持久化时机（When cache prefixes are persisted）

官方列出三种互补的持久化策略，任意一条均可产生一个独立的 cache prefix unit：

1. **Persistence at request boundaries（请求边界持久化）**
   > Each request will produce two cache prefix units at the end position of the user input and the end position of the model output. A subsequent request can hit the cache if it fully matches them.

2. **Common prefix detection persistence（公共前缀检测持久化）**
   > When the system detects a common prefix across multiple requests, it will persist that common prefix as an independent cache prefix unit. A subsequent request can hit the cache if it fully reuses that cache prefix unit.

3. **Persistence at fixed token intervals（固定 token 间隔持久化）**
   > For long inputs or long outputs, the system will carve out cache prefix units at fixed token intervals, to avoid long prefixes from being completely uncacheable due to never reaching an end position.

> 要点：每个 cache prefix unit 都是独立完整的；命中要求后续请求的输入完整相等某个已持久化的单元，而非前缀包含或模糊匹配。这是 Sliding Window Attention 引入后的关键变化。

### 2.3 官方两示例（Example 1 / Example 2）

#### Example 1：Multi-round Conversation（多轮对话，最理想的命中路径）

> A user first-round request is A + B, and the second-round request is A + B + C. The second request can fully match the cache prefix unit A + B, hitting the cache for A + B.

具体消息形态（官方 JSON）：

**First Request**
```json
messages: [
    {"role": "system", "content": "You are a helpful assistant"},
    {"role": "user", "content": "What is the capital of China?"}
]
```

**Second Request**
```json
messages: [
    {"role": "system", "content": "You are a helpful assistant"},
    {"role": "user", "content": "What is the capital of China?"},
    {"role": "assistant", "content": "The capital of China is Beijing."},
    {"role": "user", "content": "What is the capital of the United States?"}
]
```

> In this example, the second request can fully reuse the cache prefix unit from the first request, which will count as a cache hit.

解读：第二轮在第一轮的 system + A + B 边界上自然追加 C，请求边界持久化的 A+B 被完整复用，是 Harness 追加式会话的典型收益。

#### Example 2：Long Text Q and A（长文本问答，公共前缀检测的价值）

> A user first-round request is A + B, and the second-round request is A + C. The second request cannot hit the cache, because A + C does not fully match the first round cache prefix unit (A + B). However, at this point the system will detect that the two requests share a common prefix A, and persist A as a cache prefix unit. When a third-round request A + D arrives, it can fully match the cache prefix unit A, hitting the cache for A.

具体形态：

**First Request**
```json
messages: [
    {"role": "system", "content": "You are an experienced financial report analyst..."},
    {"role": "user", "content": "<financial report content> Please summarize the key information of this financial report."}
]
```

**Second Request**（仅尾部指令不同）
```json
messages: [
    {"role": "system", "content": "You are an experienced financial report analyst..."},
    {"role": "user", "content": "<financial report content> Please analyze the profitability of this financial report."}
]
```

**Third Request**
```json
messages: [
    {"role": "system", "content": "You are an experienced financial report analyst..."},
    {"role": "user", "content": "<financial report content> Please analyze the ratio of revenue to expenses."}
]
```

> In the above example, the first two requests will not hit the cache. After the first two requests are completed, the system will identify the system message + financial report content in the user message as a cache prefix unit and persist it. In the third request, since it fully matches the previously persisted cache prefix unit, it can hit the cache.

解读：前两轮因尾部不同而 miss，但系统通过公共前缀检测将 A = system + 财报正文 单独物化；第三轮起即可稳定命中 A。这解释了为何把大块稳定内容放前面、易变指令放最后是最佳实践。

### 2.4 Checking Cache Hit Status（命中状态查询）

官方在响应 usage 中新增两个字段（见 https://api-docs.deepseek.com/guides/kv_cache#checking-cache-hit-status）：

1. prompt_cache_hit_tokens：The number of tokens in the input of this request that resulted in a cache hit.
2. prompt_cache_miss_tokens：The number of tokens in the input of this request that did not result in a cache hit.

约束（Harness 侧亦校验）：

```
prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens
```

> 兼容形态：OpenAI 兼容网关另以 prompt_tokens_details.cached_tokens 暴露同一含义；Harness 中 cached_tokens 优先于 prompt_cache_hit_tokens（见第 3 章）。

### 2.5 Hard Disk Cache and Output Randomness

> The hard disk cache only matches the prefix part of the user input. The output is still generated through computation and inference, and it is influenced by parameters such as temperature, introducing randomness.

含义：命中仅加速输入的 prefill；输出不受缓存束缚，仍受采样参数影响。

### 2.6 Additional Notes（最佳努力与清理策略）

> 1. The cache system works on a best-effort basis and does not guarantee a 100% cache hit rate.
> 2. Cache construction takes seconds. Once the cache is no longer in use, it will be automatically cleared, usually within a few hours to a few days.

含义：即使前缀完全一致，也可能因 best-effort 调度、构建延迟或数小时未使用而 miss；不要将缓存视为强一致存储。

---

## 3. 命中条件（Harness 视角的工程约束）

命中需同时满足三条（任一条不满足即从首个差异处起全部 miss）：

### 3.1 Model route 一致

同一 provider + model 路由。Harness 中 provider 为适配器注册名（如 deepseek-official），model 为透传的 wire model 字符串。

- 证据：packages/session/session-persistence/README.md:79 — A resumed loop can reuse provider cache only when its reconstructed history, current envelope, and model route match.
- packages/compaction/compaction-basic/README.md:156 — Routing the summarizer to a different provider/model forgoes this reuse.
- 实测：packages/core/agent-loop/tests/request-cache.e2e.ts:72 以 provider deepseek-official, model deepseek-v4-flash 固定路由验证首轮之后每轮 cacheReadTokens > 0。

### 3.2 前缀逐字节一致（byte-for-byte）

- 包含 system prompt、tools（JSON Schema 序列）、messages 三部分的完整序列化必须字节相等。
- 任何字符级差异（多一个空格、工具顺序变化、时间戳、随机 ID）都会截断可复用前缀。
- Harness 的 e2e 测试注释明确写道 The first request has nothing to hit; every later one shares its predecessor as a byte-identical prefix（request-cache.e2e.ts:91）。

### 3.3 粒度口径：现行「固定 token 间隔」取代旧「64 token 存储单元」

- **现行口径（api-docs.deepseek.com/guides/kv_cache）**：受 Sliding Window Attention 影响，不再以 64 token 为存储单元，而是以「独立完整的 cache prefix unit」为单位，并在长输入/长输出上**按固定 token 间隔切分**出额外单元（Persistence at fixed token intervals），避免长前缀因永远到不了结束位置而完全无法缓存。
- **旧口径（news0802，2024）**：The cache system uses 64 tokens as a storage unit; content less than 64 tokens will not be cached. 该表述仅存于首发公告，现行指南已不再列出。
- 工程含义不变的部分：过短的前缀仍可能不产生可复用单元，静态前缀（system + tools）应保持稳定且足够长。
- 引用纪律：涉及粒度时以现行指南的三种落盘时机为准，不得把 64 token 当作当前硬约束。

> 历史说明：本文早期版本与 Harness e2e 测试注释均沿用 64 token 粒度（comfortably spans the provider cache-block granularity）。这属于旧口径的历史遗留描述，不代表现行服务端行为。

---

## 4. 计量模型

### 4.1 Wire 层：折叠计数

DeepSeek 线上协议（api/create-chat-completion）返回：

```ts
// packages/llm/llm-deepseek/src/types.ts:157
interface WireUsage {
  prompt_tokens: number                          // 总输入 = hit + miss
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number } // OpenAI 兼容写法
  completion_tokens: number
}
```

约束：

```
prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens
```

### 4.2 Harness 层：DISJOINT 计数

packages/llm/llm/src/types.ts:130 与 docs/subsystems/llm-streaming.md 统一规定 TokenUsage 为不相交计数：

```ts
interface TokenUsage {
  inputTokens: number        // 仅未命中部分
  outputTokens: number
  cacheReadTokens?: number   // 命中部分（单独计费，约 0.1 倍单价）
  cacheWriteTokens?: number  // DeepSeek 不报告写入量
  reasoningTokens?: number   // 已含在 outputTokens 内，勿重复累加
}
// 计费输入 = inputTokens + cacheReadTokens + cacheWriteTokens
```

适配器在 packages/llm/llm-deepseek/src/translate.ts:45 显式做减法：

```ts
// DeepSeek prompt_tokens INCLUDES cache hits
// (prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens,
//  api/create-chat-completion); the harness TokenUsage convention is
// DISJOINT counts, so cache reads are subtracted out of inputTokens.
export function mapUsage(usage: WireUsage): TokenUsage {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens
                 ?? usage.prompt_cache_hit_tokens
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
  }
}
```

优先级：prompt_tokens_details.cached_tokens 优先于 prompt_cache_hit_tokens（见 translate.spec.ts:303）。

观测点：assistant/message 事件上的 usage 即为生产环境可信的缓存观测（request-cache.e2e.ts:17 称为 per-step usage recorded on assistant/message events is the production observable）。

### 4.3 计费含义与本项目计价

- 缓存命中与未命中按**不同单价**计费，两者的差额即节省额。
- **官方现行价目表**（[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)，每百万 token，美元）：

  | 模型 | 命中 peak | 命中 off-peak | 未命中 peak | 未命中 off-peak |
  |---|---|---|---|---|
  | `deepseek-flash`（= DeepSeek-V4.1-Flash） | 0.006 | 0.003 | 0.30 | 0.15 |
  | `deepseek-v4-pro` | 0.044 | 0.022 | 1.32 | 0.66 |

  峰值为 01:00-04:00 / 06:00-10:00 UTC 周一至五（官方注(2) 另排除中国公共假期），其余为谷值 = 峰值 / 2。

- ⚠️ **但 v4-pro 行已不适用于实际结算**：官方公告 [Introducing DeepSeek-V4.1-Flash](https://www.deepseek.com/en/news/deepseek-v4-1-flash/) 明确 ——

  > Starting at 04:00 UTC on Sept 14, 2026, all deepseek-v4-pro requests will route to V4.1-Flash at V4.1-Flash rates. This will continue until V4.1-Pro launches.

  即自 2026-09-14 起，`deepseek-v4-pro` 的请求实际由 V4.1-Flash 服务并按 **Flash 价**结算；pricing 页面的 v4-pro 列是尚未下线的历史价。本扩展统计的是实际结算额，故**按公告口径取 Flash 价**，V4.1-Pro 上线后需单独加价。

- 官方注(1)：legacy 名 `deepseek-v4-flash` 仍受理，但模型已退役，请求由 DeepSeek-V4.1-Flash 服务并按 Flash 价计费。
- 官方已于 **2026-07-24** 停用 `deepseek-chat` / `deepseek-reasoner`（二者从未是独立模型，只是 `deepseek-v4-flash` 的思考 / 非思考模式别名）；本项目保留同价映射仅供旧会话与自建代理兜底。

- **本项目实现**（`index.ts` `DEEPSEEK_PRICING` / `isPeakWindow` / `currentPricing`）：
  - 按当前 wire model 选价目表，未知模型取保守下界（flash 谷值）而非高估；
  - 按调用时刻判断 peak / off-peak，谷值自动减半；
  - `saved = cacheRead / 1e6 * (miss − hit)`；
  - `/cache-stats` 同时展示当前模型、时段与单价，避免黑盒数字。

> 历史说明：本文早期版本与 v0.2.1 代码曾使用 0.027/0.27（后改为 0.014/0.44），二者均不对应现行价目表（0.014 是 2024 年 news0802 的首发 cache-hit 价，0.44 约为 pi-ai 中 `deepseek-v4-pro` 的 input 成本，与注释标称的 flash 不符）。已按官方价目表重写。

---

## 5. 破坏因素（Cache Breakers）

以下任一变化都会使可复用前缀在变化点截断，之后全部按 miss 计费：

| 类别 | 典型例子 | 说明 |
|------|----------|------|
| **System 变化** | persona/prompt 模板改动、动态时间戳注入 | Harness 中 system 来自 ctx.systemPrompt，一旦 persona 切换即新前缀 |
| **Tools 变化** | 工具增删、JSON Schema 字段顺序变化 | 工具数组序列化参与前缀比较 |
| **历史重写** | 编辑/重排已发送的 message、compaction 替换 head | compaction-basic 明确标记 Replacing rather than append-only. Each checkpoint invalidates reuse from the first replaced history token |
| **路由变化** | 切换 provider/model | 见命中条件 3.1 |
| **易变内容前置** | 将时间戳、随机 ID、大块非确定性工具输出放在靠前位置 | 使可复用单元变短；按官方现行口径，需**完整匹配**某个已落盘单元才能命中，故稳定内容应尽量越过所有易变段 |
| **非追加式写入** | 持久化修复重写较早历史（Harness 已规避：修复结果 append） | 多个包文档强调 append without rewriting earlier history |

> 设计原则：把稳定内容放前、易变内容放后、只追加不重写。

---

## 6. Harness 五重强制手段

> 本章逐条给出为何强制、怎么做、证据在哪里。所有路径以 harness 安装根 @deepseek-ai/dsh 为基准，行号来自已安装版本（fnm v24.18.0）。若仓库源码路径不同，请在 packages/.../src 下搜索同名符号。

### 6.1 固定 System Prompt（PromptSection.order, assemble, append-only）

**为何强制**：system 是请求前缀的第一个字节；任何顺序抖动或中途重写都会使后续所有 token 的缓存失效。

**怎么做**：
- 以 PromptSection { name, order, text, complete? } 注册，order 决定拼接顺序（约定：-100 为 harness 身份、0 为部署 persona、100-199 为工具引导），同一层内重名或非有限 order 直接抛错。
- SystemPrompt.assemble() 将 global + scoped 的 sections 按 order 升序合并，仅在末尾以两次换行连接；若存在 complete: true 的段，则在 waterfall 之后将其作为唯一段恢复，保证字节确定性。

**证据链**：

| 证据 | 路径与行号 | 关键行 |
|------|------------|--------|
| 类型定义 | node_modules/@deepseek-ai/dsh-system-prompt/lib/types/index.d.ts:47 | export interface PromptSection { readonly name: string; readonly order: number; readonly text: string | ((context: AssembleContext) => string); readonly complete?: boolean; } |
| 顺序拼接 | node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:263 | const sectionDefinitions = [...sectionByName.values()].sort((a, b) => a.order - b.order); |
| 组装入口 | node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:240 | async assemble(context = {}) { // 收集 sections/contexts/tools/variables 到 orderTools 到 waterfall } |
| 完整段唯一性 | node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:265 | if (completeSections.length > 1) throw new Error(multiple complete prompt sections are active); |
| 工具排序接入 | node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:280 | tools: orderTools(collected, this.toolOrder, knownNames), |

> 源码对照：上游仓库 packages/core/system-prompt/src/index.ts 中同名 assemble / orderTools 逻辑一致；本文行号以安装产物为准，仓库源码行号可能偏移数行，请以符号搜索为准。

### 6.2 工具字典序（orderTools / compareToolNames / sameSchema）

**为何强制**：tools 数组的 JSON 序列化直接参与前缀比较；不同机器、不同注册顺序若导致工具顺序不同，则 system 之后的首个字节即分叉。

**怎么做**：
- 未配置 toolOrder 时，orderTools 回退为按 compareToolNames 的码点（code-unit）字典序排序——与 locale 无关，保证跨机器一致。
- 已配置 toolOrder 时，未列名工具在其锚点位置按字典序插入；列名未知或重复直接抛错。
- 判等时 sameSchema 使用 JSON.stringify 逐项比对，且 headerEquals 要求工具数组按顺序逐项相等，任何顺序差异即判定为 header 变化。

**证据链**：

| 证据 | 路径与行号 | 关键行 |
|------|------------|--------|
| 排序入口 | node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:44 | function orderTools(tools, toolOrder, knownNames) { if (toolOrder === void 0) return tools.sort(compareToolNames); ... } |
| 字典序比较 | node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:54 | function compareToolNames(a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; } |
| 未列名插入 | node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:50 | const rest = tools.filter((tool) => !listed.has(tool.name)).sort(compareToolNames); |
| 模式判等 | node_modules/@deepseek-ai/dsh-session/lib/types/request-header.js:29 | function sameSchema(a, b) { return JSON.stringify(a) === JSON.stringify(b); } |
| 顺序敏感判等 | node_modules/@deepseek-ai/dsh-session/lib/types/request-header.js:38 | export function headerEquals(a, b) { ... return at.length === bt.length && at.every((tool, i) => sameSchema(tool, bt[i])); } |

### 6.3 Wire 确定性序列化（serializeMessages）

**为何强制**：即使 harness 内存中 Message 数组顺序一致，若 wire 序列化时对 tool-result 拆分、文本拼接或空消息处理不一致，线上字节仍会分叉。

**怎么做**：
- serializeMessages(messages) 将每个 harness message 按角色确定性映射：system 到单条 system；assistant 到单条 assistant（含 tool-call）；user 到文本 user + 每条 tool-result 各一条 role tool 消息；空文本与 (no output) 兜底均有明确分支。
- serializeRequest / serializeRequestWithImages 在其上先压入 system（若有），再追加 serializeMessages 结果，保证 wire 顺序与 harness 顺序一一对应；图片路径经 offloadRequestImages 与 serializeMessagesWithImages 确定性落盘。

**证据链**：

| 证据 | 路径与行号 | 关键行 |
|------|------------|--------|
| 文本序列化 | node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js:117 | function serializeMessages(messages) { const wire = []; for (const message of messages) { ... } return wire; } |
| 声明 | node_modules/@deepseek-ai/dsh-llm-deepseek/lib/types/serialize.d.ts:33 | export declare function serializeMessages(messages: Message[]): WireMessage[]; |
| 请求组装 | node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js:241 | function serializeRequest(options, defaults = {}) { const messages = []; if (options.system !== void 0) messages.push({ role: system, content: options.system }); messages.push(...serializeMessages(options.messages)); return requestWithMessages(options, messages, defaults); } |
| 图片确定性 | node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js:155 | async function serializeMessagesWithImages(messages, attachments, signal) { ... } |

### 6.4 请求头折叠与冻结（canonicalHeader, deepFreeze, callConfigEquals, foldRequestHeader）

**为何强制**：DeepSeek 的命中要求前缀已持久化且完全匹配。Harness 用 request/header 事件记录非历史的请求封装（config + system + tools + adapterDefaults），并通过折叠与冻结保证内存中用于发请求的 envelope 与日志中用于重建的 envelope 字节一致，避免静默漂移。

**怎么做**：
- **规范化**：canonicalHeader 将空 system / 空 tools 归一为缺省字段，使空与缺省在日志与比较中同一表示。
- **变更检测**：callConfigEquals 对 provider/model/reasoningEffort/temperature/maxTokens/stop 逐字段判等（stop 逐元素比对）；headerEquals 在其上叠加 system 与有序 tools 的 sameSchema 比对，仅当真实变化时才记录新 request/header 快照。
- **折叠重建**：foldRequestHeader(events) 遍历日志，取最后一条 request/header 的规范化结果；任何持有日志的人（包括离线回放）都能重建该请求构建时生效的 envelope。
- **冻结所有权**：deepFreeze 以迭代式、抗环、跳过 AbortSignal 的方式深度冻结请求对象；LlmRuntime.prepareCall 与 agent-loop invariant 要求 loop 构建的请求必须已冻结、messages 数组已冻结、且 JSON.stringify(messages) 与 session.deriveMessages() 的重建结果一致，否则直接 fail。

**证据链**：

| 证据 | 路径与行号 | 关键行 |
|------|------------|--------|
| 规范化 | node_modules/@deepseek-ai/dsh-session/lib/types/request-header.js:17 | export function canonicalHeader(header) { ... header.system !== undefined && header.system.length > 0 ? { system: header.system } : {} ... } |
| 配置判等 | node_modules/@deepseek-ai/dsh-llm/lib/index.js:68 | function callConfigEquals(a, b) { if (a.provider !== b.provider || a.model !== b.model || ... ) return false; ... } |
| 冻结 | node_modules/@deepseek-ai/dsh-llm/lib/index.js:98 | function deepFreeze(value) { const seen = new WeakSet(); const pending = [{ kind: visit, node: value }]; ... Object.freeze(node); ... } |
| 准备调用冻结 | node_modules/@deepseek-ai/dsh-llm/lib/index.js:1391 | const resolvedConfig = deepFreeze(structuredClone(resolved.config)); const adapterDefaults = deepFreeze({ ... }); |
| 折叠 | node_modules/@deepseek-ai/dsh-session/lib/types/request-header.js:57 | export function foldRequestHeader(events, from) { let state = from; for (const event of events) if (event.type === request/header) state = canonicalHeader(event.data.header); return state; } |
| 不变量校验 | node_modules/@deepseek-ai/dsh-agent-loop/lib/invariant.js:15 | ctx.on(llm/stream, (options, next) => { if (!isAgentLoopRequest(options)) return next(); if (!Object.isFrozen(options)) fail(a loop-built request must be frozen); ... const header = foldRequestHeader(events); if (JSON.stringify(options.messages) !== JSON.stringify(expected)) fail(...); ... } |

### 6.5 Compaction verbatim 回放（summarizer 回放 system+tools+shadowed messages）

**为何强制**：compaction 若用独立的总结专用 system 或重排历史，会使辅助调用的前缀与上一轮路由请求的前缀分叉，浪费 warm KV cache；同时 checkpoint 本身若非位姿精确替换，会破坏后续请求的公共前缀检测。

**怎么做**：
- 默认总结器 summarizeWithLlm verbatim 回放会话自身的 system、tools 与被遮蔽区消息前缀，仅在末尾追加 COMPACTION_INSTRUCTION 作为最后一条 user 消息，使辅助调用成为上一轮路由请求的真前缀扩展，复用 warm cache。
- 总结输出经 summaryText 过滤仅保留文本，frameSummary 以 CHECKPOINT_PREAMBLE + compacted-summary 标签包装后作为替换型 user 消息落盘；后续请求将该 checkpoint 视为已确立背景继续追加。

**证据链**：

| 证据 | 路径与行号 | 关键行 |
|------|------------|--------|
| 指令设计注释 | node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:212 | The summarization directive, delivered as the FINAL user message after the replayed conversation rather than as a distinct summarizer system prompt. Keeping the conversation own system prompt, tools, and message prefix in front of it makes the auxiliary call a genuine prefix of the last routed request, so the provider KV cache is reused instead of invalidated. |
| verbatim 回放 | node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:280 | const messages = [...input.messages, createUserMessage({ content: [{ type: text, text: COMPACTION_INSTRUCTION }], source: { kind: plugin, plugin: dsh-compaction-basic } })]; |
| 透传 system/tools | node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:294 | const options = { provider: target.provider, model: target.model, messages, ...input.system === void 0 ? {} : { system: input.system }, ...input.tools === void 0 ? {} : { tools: [...input.tools] }, maxTokens: config.maxTokens, sessionId: agent.session.id, purpose: compaction, ... } |
| 包装落盘 | node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:322 | function frameSummary(summary) { return [{ type: text, text: CHECKPOINT_PREAMBLE + summary_open_tag }, ...summary, { type: text, text: SUMMARY_CLOSE_TAG }]; } |

---

## 7. Pi 插件对照

> Pi（@earendil-works/pi-coding-agent）的扩展点与 Harness 的五重手段一一对应；本项目（pi-deepseek-cache）在其上追加三项强制点，进一步收敛字节确定性与可观测性。

### 7.1 三钩子如何复刻 Harness 手段

| Pi 钩子 | 触发时机 | 复刻的 Harness 手段 | 本项目做法 |
|---------|----------|---------------------|------------|
| context | 每次组装上下文、即将并入请求前 | 固定 System Prompt 的易变内容后置与 append-only | 过滤 customType volatile-scratch 的易变消息，使其不进入 wire 前缀（index.ts:687 pi.on(context, ...)），避免时间戳/草稿截断稳定前缀 |
| before_provider_request | provider payload 已组装、尚未发送 | 工具字典序 + Wire 确定性序列化 + 请求头折叠的发送前最后一致性门 | 见 7.2 |
| session_before_compact | 压缩前，允许扩展接管总结 | Compaction verbatim 回放（**未对齐**，见 7.4） | 以 `deepseek-flash`（兼容 legacy 名 `deepseek-v4-flash`）@ temperature 0 做确定性总结，结果按 SHA-256 去重并落盘 summary-cache.json |

#### context — 易变内容隔离

```ts
// index.ts:687
pi.on("context", async (event, ctx) => {
  const msgs = Array.isArray((event as any).messages) ? (event.messages as CachedMessage[]) : [];
  const onWire = msgs.filter((m) => m?.customType !== "volatile-scratch");
  return { messages: onWire };
});
```

效果：易变草稿仅在 UI 侧可见，不参与 serializeMessages 的 wire 字节，从而不截断 canonicalHeader 所保护的稳定前缀。

#### before_provider_request — 发送前一致性门

```ts
// index.ts:698 — 节选
pi.on("before_provider_request", (event, ctx) => {
  const payload = event.payload as Record<string, unknown>;
  if (Array.isArray(payload.tools) && payload.tools.length > 1) {
    // 码点字典序排序（localeCompare 依赖 ICU/locale，跨环境可能不同序）
    const sorted = [...payload.tools].sort((a, b) => {
      const na = getToolName(a), nb = getToolName(b);
      return na < nb ? -1 : na > nb ? 1 : 0;
    });
    // 仅在顺序确实改变时替换
    if (sorted.some((t, i) => t !== payload.tools![i])) next = { ...payload, tools: sorted };
  }
  // system + tools + messages 三段指纹（tools 为独立顶层字段，必须单独覆盖）
  const fp: PrefixFingerprint = {
    tools: hashMessages(Array.isArray(next.tools) ? next.tools : null),
    messages: hashMessages(msgs),
    len: msgs.length,
  };
  // 追加式 = 命中任一已知指纹且 tools 未变
});
```

对应 Harness：orderTools/compareToolNames 的字典序 + callConfigEquals/headerEquals 的真实变化才记录 + deepFreeze 的冻结后不可改写。Pi 钩子在冻结前做最后一次归一化与诊断。

#### session_before_compact — 缓存友好的确定性总结

```ts
// index.ts:754
pi.on("session_before_compact", async (event, ctx) => {
  flushPendingWrites();
  const { messagesToSummarize, firstKeptEntryId, tokensBefore, previousSummary } = event.preparation;
  const history = serializeConversation(convertToLlm(messagesToSummarize));
  const text = previousSummary ? "【上次摘要】" + previousSummary + "【新增历史】" + history : history;
  const key = createHash("sha256").update(text).digest("hex");
  let summary = summaryCache.get(key);
  if (!summary) {
    summary = await summarizeWithFlash(text, ctx, signal); // deepseek-v4-flash, temperature 0
    setSummaryCache(summaryCache, key, summary);
    saveSummaryCache(summaryCache);
  }
  return { compaction: { summary, firstKeptEntryId, tokensBefore, details: { summarizer: "deepseek-v4-flash" } } };
});
```

#### 7.4 未对齐项：compaction 并非 verbatim 回放

**Harness 的做法（见 6.5）**：总结器逐条回放会话自身的 `system`、`tools` 与被遮蔽区消息，仅在末尾追加一条 `COMPACTION_INSTRUCTION` 作为最后一条 user 消息，使辅助调用成为上一轮路由请求的**真前缀扩展**，从而复用 warm KV cache。

**本项目的做法**（`index.ts` `summarizeWithFlash`）：把 `serializeConversation(...)` 的历史**序列化为单条 user 消息文本**，与指令拼接后一次发出；不传 `system`、不传 `tools`、不按消息逐条回放。

**差异与后果**（不得再声称 parity）：

| 维度 | Harness verbatim 回放 | 本项目 |
|---|---|---|
| 前缀形态 | 上一轮请求的真前缀扩展 | 全新前缀，与上一轮无字节重合 |
| 缓存效果 | 复用 warm cache，仅 prefill 新增的指令 | 每次 compaction 冷启动，全量 prefill 整段历史 |
| 稳定内容 | 指令置于最后，历史变动不影响前缀 | 指令与历史拼接在同一段文本内，历史一变即全量重算 |
| 路由 | 透传原 provider/model | 固定走 `deepseek-flash`（官方注(1)：legacy 名已退役但仍受理） |

补充：摘要缓存 key 为 `sha256(序列化历史全文)`，需历史**逐字节相同**才能命中。因此“跨会话复用”在实践中几乎不会发生（跨会话历史必然不同），真实命中场景是同会话内对同一压缩集合重复总结。

> 若要真正对齐 Harness 6.5，需要改为按消息逐条回放 `system + tools + messages`、把指令作为最后一条 user 消息追加，并透传原会话的 provider/model。当前实现是**独立冷调用**，属于刻意的工程权衡（隔离主请求路由、保证 temperature 0 的确定性），而非等价实现。

### 7.2 本项目新增的三个强制点

- **问题**：Pi 侧不同扩展注册工具的顺序不确定；若直接透传，wire 字节在 tools 段即分叉。
- **做法**：在 before_provider_request 中对 payload.tools 按 getToolName 的码点字典序排序，仅在顺序确实改变时以 `{...payload, tools: sorted}` 非破坏性返回替换（index.ts:698）。
- **与 Harness 一致性**：与 dsh-system-prompt/lib/index.js:44 orderTools 的回退分支语义一致（未配置 toolOrder 时按 compareToolNames 排序）；Pi 侧同样使用码点比较（localeCompare 依赖 ICU/locale，跨环境可能不同序，已弃用）。
- **可观测**：排序先于指纹计算，诊断基于归一化后的字节。

#### 2. 前缀包含检测（Prefix Containment Check）

- **问题**：官方要求完整匹配已持久化的 cache prefix unit，但开发期更关心本轮请求是否仍是上一轮的追加——非追加即可能 miss。
- **覆盖面（重要）**：指纹必须同时覆盖 `system`、`tools`、`messages` 三段。pi-ai 的 `openai-completions` `buildParams` 把 `system` 并入 `messages`，但 **`tools` 是独立顶层字段**；早期实现只哈希 `messages`，导致工具增删或 schema 变更击穿缓存时零告警。现已对 `tools` 单独取 `stableStringify` + SHA-256 并纳入比对。
- **做法**：对完整 messages 列表（含最后一条，对齐官方 cache unit 落盘边界——用户输入末尾）与归一化后的 tools 分别做 stableStringify + SHA-256，组成 `PrefixFingerprint { tools, messages, len }`；本轮为追加式 = 消息列表以某个已知指纹开头**且 tools 指纹未变**，否则 `prefixBreaks++` 并 `ctx.ui.notify` 告警（index.ts:698）。
- **多指纹集合**：官方 unit 独立完整、可并存，且未使用的条目数小时至数日内才清理。因此判定“是否破坏前缀”不能只看上一轮——回落到早期已落盘前缀仍是有效命中（官方 Example 2）。实现保留有界集合（`MAX_KNOWN_PREFIXES = 8`），命中任一即视为追加式。
- **与 Harness 一致性**：Harness 以 foldRequestHeader + headerEquals 判断 envelope 是否变化，以 session.deriveMessages() 重建历史；本项目在 wire 侧以哈希等价实现前缀包含检测，二者互补——前者保 envelope（含 system/tools），后者保 messages 前缀的追加性。
- **序列化稳定性**：使用 stableStringify（键按字典序排序，数组保持原序，递归稳定）避免同一语义因键序抖动而误报 break（index.ts:126）。

#### 3. 原子落盘（Atomic Persistence）

- **问题**：统计与摘要缓存若以非原子写落盘，崩溃时可能产生半截 JSON，导致下次启动误判或丢失命中归因。
- **做法**：atomicWriteJson 先写入 path.pid.tmp，再 renameSync 原子替换（index.ts:147）；所有持久化（stats.json / summary-cache.json / hitRateHistory）均经此路径，配合 session_shutdown 与 session_before_compact 前的 flushPendingWrites()，保证退出必 flush与压缩前必 flush。
- **与 Harness 一致性**：Harness 会话存储（JSONL/SQLite）亦保证 Persistence does not mutate live request prefixes 且修复结果 append 而非重写；本项目在扩展侧以原子文件语义延续同一不变量。

### 7.3 遥测与可视化（P1）

| 能力 | 实现 |
|------|------|
| 监听 message_end 累积 cacheRead / input / cacheWrite / turns，并记录 wire model | index.ts message_end 处理 |
| 落盘 ~/.pi/agent/extensions/deepseek-cache/stats.json | atomicWriteJson |
| 状态栏实时显示 cache xx.x% · Nt（累计口径） | index.ts status bar |
| /cache-stats 同时展示**累计**命中率与**本轮**命中率（官方为按请求逐次统计口径，两者不同） | index.ts `StatsView.lastTurnHitRate` |
| 节省额按当前模型 + peak/off-peak 时段计价（`saved = cacheRead/1e6 * (miss − hit)`），并展示所用模型、时段与单价；小额用 4 位小数避免丢失有效信息 | index.ts `currentPricing` / `buildStatsView` |
| 官方 usage 无 cache write 字段，未观测到非零写入时隐藏「缓存写入」行（避免恒为 0 的死 UI） | index.ts `reportsCacheWrite` |

---

## 8. 参考链接

- **DeepSeek 官方**
  - [Context Caching — DeepSeek API Docs](https://api-docs.deepseek.com/guides/kv_cache) — 硬盘缓存总述、三种持久化、两示例、计费二字段、best-effort（本文第 2 章 Ground Truth 来源）
  - [API Introduces Context Caching on Disk — News 2024-08-02](https://api-docs.deepseek.com/news/news0802) — 首次发布。**旧口径参考**：其中 “cache hit $0.014/M、miss $0.14/M” 与 “64 token 存储单元” 均为 2024 年首发价与旧粒度，已被现行价目表与现行缓存粒度取代（见 3.3 / 4.3）
  - [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) — 现行价目表、peak/off-peak 规则（官方注(2)）、legacy 模型名说明（官方注(1)）；本项目按该表与时段计价

- **Harness 源码（相对 deepseek-harness 仓库根；安装产物路径见第 6 章表格）**
  - packages/llm/llm-deepseek/README.md — deepseek-official 路由与适配器
  - packages/llm/llm-deepseek/src/types.ts:150 — WireUsage 定义与 prompt_tokens = hit + miss 约束
  - packages/llm/llm-deepseek/src/translate.ts:45 — mapUsage 的 DISJOINT 减法与注释
  - packages/llm/llm-deepseek/src/translate.ts:54 — prompt_tokens_details.cached_tokens 优先
  - docs/subsystems/llm-streaming.md#TokenUsage — TokenUsage 不相交计量契约
  - packages/compaction/compaction-basic/src/summarizer.ts:72 — replay verbatim to reuse warm prefix cache
  - packages/compaction/compaction-basic/README.md:18,101,152-156 — 总结的前缀复用与 KV Cache effect
  - packages/core/agent-loop/tests/request-cache.e2e.ts — 真实 API 的 cacheReadTokens > 0 证明（其中 64-token 粒度注释属旧口径，见 3.3）
  - packages/session/session-persistence/README.md:79 — 持久化不改前缀、命中需 history + envelope + route 一致
  - node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:44,54,240,263,280 — PromptSection/orderTools/compareToolNames/assemble
  - node_modules/@deepseek-ai/dsh-session/lib/types/request-header.js:17,29,38,57 — canonicalHeader/sameSchema/headerEquals/foldRequestHeader
  - node_modules/@deepseek-ai/dsh-llm/lib/index.js:68,98,1391 — callConfigEquals/deepFreeze/prepareCall
  - node_modules/@deepseek-ai/dsh-agent-loop/lib/invariant.js:15 — foldRequestHeader + deepFreeze 不变量校验
  - node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js:117,241 — serializeMessages/serializeRequest
  - node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:212,267,280,294 — COMPACTION_INSTRUCTION / summarizeWithLlm verbatim 回放

- **本项目**
  - index.ts:126 — stableStringify 字节稳定序列化
  - index.ts:147 — atomicWriteJson 原子落盘
  - index.ts:33 — DEEPSEEK_PRICING 官方价目表（含 peak/off-peak 与 legacy 名）
  - index.ts:687 — context 易变隔离
  - index.ts:698 — before_provider_request 工具排序 + system/tools/messages 三段前缀指纹
  - index.ts:754 — session_before_compact 确定性总结与摘要缓存
  - index.ts:795 — summarizeWithFlash 独立冷调用（非 verbatim 回放，见 7.4）
  - README.md — 功能总览与 [DeepSeek Context Caching docs](https://api-docs.deepseek.com/guides/kv_cache) 入口

---

*最后更新：2026-09-29（对齐官方现行 kv_cache 口径与现行价目表）· 维护者：pi-deepseek-cache*
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

| 特性              | 说明                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| 默认开启          | 无需改代码、无需传参即生效（api-docs.deepseek.com/guides/kv_cache）                                 |
| 硬盘持久化        | 每次请求触发一次硬盘缓存构建；后续请求须**完整匹配**某个已落盘的 cache prefix unit 才计为 cache hit |
| 前缀单元独立完整  | 受 Sliding Window Attention 机制影响，每个已缓存前缀是独立完整的单元，不存在“任意重叠即复用”        |
| 不要求显式会话 ID | 命中不依赖会话标识，只取决于请求前缀字节序列                                                        |
| 输出仍需推理      | 缓存只加速输入的 prefill，输出仍通过计算生成，受 temperature 等参数影响                             |
| Best-effort       | 不保证 100% 命中；未使用的缓存条目数小时至数日内自动清理                                            |

> 官方原文摘录（api-docs.deepseek.com/guides/kv_cache 为当前口径；news0802 为 2024 首发口径，部分表述已被前者取代）：
>
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
  prompt_tokens: number; // 总输入 = hit + miss
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number }; // OpenAI 兼容写法
  completion_tokens: number;
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
  inputTokens: number; // 仅未命中部分
  outputTokens: number;
  cacheReadTokens?: number; // 命中部分（单独计费，约 0.1 倍单价）
  cacheWriteTokens?: number; // DeepSeek 不报告写入量
  reasoningTokens?: number; // 已含在 outputTokens 内，勿重复累加
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
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
  };
}
```

优先级：prompt_tokens_details.cached_tokens 优先于 prompt_cache_hit_tokens（见 translate.spec.ts:303）。

观测点：assistant/message 事件上的 usage 即为生产环境可信的缓存观测（request-cache.e2e.ts:17 称为 per-step usage recorded on assistant/message events is the production observable）。

### 4.3 计费含义与本项目计价

- 缓存命中与未命中按**不同单价**计费，两者的差额即节省额。
- **官方现行价目表**（[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)，每百万 token，美元）：

  | 模型                                      | 命中 peak | 命中 off-peak | 未命中 peak | 未命中 off-peak |
  | ----------------------------------------- | --------- | ------------- | ----------- | --------------- |
  | `deepseek-flash`（= DeepSeek-V4.1-Flash） | 0.006     | 0.003         | 0.30        | 0.15            |
  | `deepseek-v4-pro`                         | 0.044     | 0.022         | 1.32        | 0.66            |

  峰值为 01:00-04:00 / 06:00-10:00 UTC 周一至五，**并排除中国公共假期**（官方注(2)），其余为谷值 = 峰值 / 2。

- ✅ **v4-pro 仍按自身价目表结算**（2026-09-10 更正）：

  v0.3.0 曾依据 [Introducing DeepSeek-V4.1-Flash](https://www.deepseek.com/en/news/deepseek-v4-1-flash/) 的以下表述，把 `deepseek-v4-pro` 按 Flash 价计费：

  > Starting at 04:00 UTC on Sept 14, 2026, all deepseek-v4-pro requests will route to V4.1-Flash at V4.1-Flash rates. This will continue until V4.1-Pro launches.

  但该计划**已被官方撤销**。官方 [Change Log](https://api-docs.deepseek.com/updates) 在 **2026-09-10**（即原定切换日 09-14 之前）写明：

  > In response to user demand, we have decided to continue providing API services for DeepSeek V4 Pro after September 14, 2026, with the billing method remaining unchanged.

  即 `deepseek-v4-pro` **从未实际切换**到 Flash 价，继续按上表 v4-pro 行结算（模型版本 DeepSeek-V4-Pro-0813）。因此 "按 Flash 价结算" 会把 v4-pro 用户的节省额**少算约 7 倍**（1.32 / 0.30 ≈ 4.4 倍未命中价、0.044 / 0.006 ≈ 7.3 倍命中价），现已改回官方价目表。pi 自身的模型目录 `@earendil-works/pi-ai/providers/data/deepseek.json` 同样是 `cacheRead 0.044 / input 1.32`，与此一致。

- 官方注(1)：legacy 名 `deepseek-v4-flash` 与 `deepseek-v4-flash-vision-exp` 仍受理，但对应模型已退役，请求由 DeepSeek-V4.1-Flash 服务并按 Flash 价计费。
- 官方已于 **2026-07-24** 停用 `deepseek-chat` / `deepseek-reasoner`（二者从未是独立模型，只是 `deepseek-v4-flash` 的思考 / 非思考模式别名）；本项目保留同价映射仅供旧会话与自建代理兜底。

- **本项目实现**（`index.ts` `resolvePricing` / `costToTier` / `DEEPSEEK_PRICING` / `CN_PUBLIC_HOLIDAYS` / `isPeakWindow`）——v0.5 起按 provider 分成两条路径：

  | provider           | 单价来源                                                                                          | 峰谷                                                                    |
  | ------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
  | 官方 `deepseek`    | 官方价目表（`DEEPSEEK_PRICING`，含 legacy 名与已停用名）；表中没有该模型才退回模型目录            | 按调用时刻判断 peak / off-peak，谷值减半；峰值窗口排除中国公共假期      |
  | 其他（第三方部署） | **模型目录的 `cost`**（`models.json` / pi 内置目录）：`hit = cost.cacheRead`、`miss = cost.input` | **不适用**：第三方按 flat 价结算，折半即把节省额算错一半（v0.4 的行为） |

  解析顺序为 **目录 `cost` → 官方价目表 → unpriced → 保守下界**：

  - 目录里有该模型但 `input` 为 0（免费 / 未标价）→ `unpriced`，**不估算节省**（`/cache-stats` 显示 `—`），避免给免费模型编出一笔钱；
  - 目录里根本没有该模型 → 取官方 flash 谷值作保守下界，宁少不多；
  - pi 内置目录里 `deepseek-flash` 为 0.006/0.3、`deepseek-v4-pro` 为 0.044/1.32，与官方价目表**峰值**一致，因此官方 provider 不论走哪条来源结果都相同；
  - `saved = cacheRead / 1e6 * (miss − hit)`；`/cache-stats` 标明**单价来源**（模型目录价 / 官方价目表 · 峰谷 / 保守下界（无价目数据） / 模型目录未标价）与单价，避免黑盒数字。

> 历史说明：本文早期版本与 v0.2.1 代码曾使用 0.027/0.27（后改为 0.014/0.44），二者均不对应现行价目表（0.014 是 2024 年 news0802 的首发 cache-hit 价，0.44 约为 pi-ai 中 `deepseek-v4-pro` 的 input 成本，与注释标称的 flash 不符）。已按官方价目表重写。

---

## 5. 破坏因素（Cache Breakers）

以下任一变化都会使可复用前缀在变化点截断，之后全部按 miss 计费：

| 类别             | 典型例子                                                  | 说明                                                                                                                                                                                                                     |
| ---------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **System 变化**  | persona/prompt 模板改动、动态时间戳注入                   | Harness 中 system 来自 ctx.systemPrompt，一旦 persona 切换即新前缀                                                                                                                                                       |
| **Tools 变化**   | 工具增删、JSON Schema 字段顺序变化                        | 工具数组序列化参与前缀比较                                                                                                                                                                                               |
| **历史重写**     | 编辑/重排已发送的 message、compaction 替换 head           | compaction-basic 明确标记 Replacing rather than append-only. Each checkpoint invalidates reuse from the first replaced history token                                                                                     |
| **路由变化**     | 切换 provider/model                                       | 见命中条件 3.1                                                                                                                                                                                                           |
| **实例漂移**     | router 把同一会话发到另一个后端副本                       | 自建引擎（vLLM/SGLang 等）的 prefix cache 通常**按实例**，换副本等于换缓存；这一点与「前缀被改写」在 wire 字节上不可区分，本项目的前缀诊断分不出两者。会话亲和（如 magpie 的 `compat.sendSessionAffinityHeaders`）可规避 |
| **易变内容前置** | 将时间戳、随机 ID、大块非确定性工具输出放在靠前位置       | 使可复用单元变短；按官方现行口径，需**完整匹配**某个已落盘单元才能命中，故稳定内容应尽量越过所有易变段                                                                                                                   |
| **非追加式写入** | 持久化修复重写较早历史（Harness 已规避：修复结果 append） | 多个包文档强调 append without rewriting earlier history                                                                                                                                                                  |

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

| 证据         | 路径与行号                                                          | 关键行                                                                                                |
| ------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 类型定义     | node_modules/@deepseek-ai/dsh-system-prompt/lib/types/index.d.ts:47 | export interface PromptSection { readonly name: string; readonly order: number; readonly text: string | ((context: AssembleContext) => string); readonly complete?: boolean; } |
| 顺序拼接     | node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:263        | const sectionDefinitions = [...sectionByName.values()].sort((a, b) => a.order - b.order);             |
| 组装入口     | node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:240        | async assemble(context = {}) { // 收集 sections/contexts/tools/variables 到 orderTools 到 waterfall } |
| 完整段唯一性 | node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:265        | if (completeSections.length > 1) throw new Error(multiple complete prompt sections are active);       |
| 工具排序接入 | node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:280        | tools: orderTools(collected, this.toolOrder, knownNames),                                             |

> 源码对照：上游仓库 packages/core/system-prompt/src/index.ts 中同名 assemble / orderTools 逻辑一致；本文行号以安装产物为准，仓库源码行号可能偏移数行，请以符号搜索为准。

### 6.2 工具字典序（orderTools / compareToolNames / sameSchema）

**为何强制**：tools 数组的 JSON 序列化直接参与前缀比较；不同机器、不同注册顺序若导致工具顺序不同，则 system 之后的首个字节即分叉。

**怎么做**：

- 未配置 toolOrder 时，orderTools 回退为按 compareToolNames 的码点（code-unit）字典序排序——与 locale 无关，保证跨机器一致。
- 已配置 toolOrder 时，未列名工具在其锚点位置按字典序插入；列名未知或重复直接抛错。
- 判等时 sameSchema 使用 JSON.stringify 逐项比对，且 headerEquals 要求工具数组按顺序逐项相等，任何顺序差异即判定为 header 变化。

**证据链**：

| 证据         | 路径与行号                                                           | 关键行                                                                                                                       |
| ------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 排序入口     | node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:44          | function orderTools(tools, toolOrder, knownNames) { if (toolOrder === void 0) return tools.sort(compareToolNames); ... }     |
| 字典序比较   | node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:54          | function compareToolNames(a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; }                                   |
| 未列名插入   | node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:50          | const rest = tools.filter((tool) => !listed.has(tool.name)).sort(compareToolNames);                                          |
| 模式判等     | node_modules/@deepseek-ai/dsh-session/lib/types/request-header.js:29 | function sameSchema(a, b) { return JSON.stringify(a) === JSON.stringify(b); }                                                |
| 顺序敏感判等 | node_modules/@deepseek-ai/dsh-session/lib/types/request-header.js:38 | export function headerEquals(a, b) { ... return at.length === bt.length && at.every((tool, i) => sameSchema(tool, bt[i])); } |

### 6.3 Wire 确定性序列化（serializeMessages）

**为何强制**：即使 harness 内存中 Message 数组顺序一致，若 wire 序列化时对 tool-result 拆分、文本拼接或空消息处理不一致，线上字节仍会分叉。

**怎么做**：

- serializeMessages(messages) 将每个 harness message 按角色确定性映射：system 到单条 system；assistant 到单条 assistant（含 tool-call）；user 到文本 user + 每条 tool-result 各一条 role tool 消息；空文本与 (no output) 兜底均有明确分支。
- serializeRequest / serializeRequestWithImages 在其上先压入 system（若有），再追加 serializeMessages 结果，保证 wire 顺序与 harness 顺序一一对应；图片路径经 offloadRequestImages 与 serializeMessagesWithImages 确定性落盘。

**证据链**：

| 证据       | 路径与行号                                                             | 关键行                                                                                                                                                                                                                                                                              |
| ---------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文本序列化 | node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js:117            | function serializeMessages(messages) { const wire = []; for (const message of messages) { ... } return wire; }                                                                                                                                                                      |
| 声明       | node_modules/@deepseek-ai/dsh-llm-deepseek/lib/types/serialize.d.ts:33 | export declare function serializeMessages(messages: Message[]): WireMessage[];                                                                                                                                                                                                      |
| 请求组装   | node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js:241            | function serializeRequest(options, defaults = {}) { const messages = []; if (options.system !== void 0) messages.push({ role: system, content: options.system }); messages.push(...serializeMessages(options.messages)); return requestWithMessages(options, messages, defaults); } |
| 图片确定性 | node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js:155            | async function serializeMessagesWithImages(messages, attachments, signal) { ... }                                                                                                                                                                                                   |

### 6.4 请求头折叠与冻结（canonicalHeader, deepFreeze, callConfigEquals, foldRequestHeader）

**为何强制**：DeepSeek 的命中要求前缀已持久化且完全匹配。Harness 用 request/header 事件记录非历史的请求封装（config + system + tools + adapterDefaults），并通过折叠与冻结保证内存中用于发请求的 envelope 与日志中用于重建的 envelope 字节一致，避免静默漂移。

**怎么做**：

- **规范化**：canonicalHeader 将空 system / 空 tools 归一为缺省字段，使空与缺省在日志与比较中同一表示。
- **变更检测**：callConfigEquals 对 provider/model/reasoningEffort/temperature/maxTokens/stop 逐字段判等（stop 逐元素比对）；headerEquals 在其上叠加 system 与有序 tools 的 sameSchema 比对，仅当真实变化时才记录新 request/header 快照。
- **折叠重建**：foldRequestHeader(events) 遍历日志，取最后一条 request/header 的规范化结果；任何持有日志的人（包括离线回放）都能重建该请求构建时生效的 envelope。
- **冻结所有权**：deepFreeze 以迭代式、抗环、跳过 AbortSignal 的方式深度冻结请求对象；LlmRuntime.prepareCall 与 agent-loop invariant 要求 loop 构建的请求必须已冻结、messages 数组已冻结、且 JSON.stringify(messages) 与 session.deriveMessages() 的重建结果一致，否则直接 fail。

**证据链**：

| 证据         | 路径与行号                                                           | 关键行                                                                                                                                                                                                                                                                                               |
| ------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 规范化       | node_modules/@deepseek-ai/dsh-session/lib/types/request-header.js:17 | export function canonicalHeader(header) { ... header.system !== undefined && header.system.length > 0 ? { system: header.system } : {} ... }                                                                                                                                                         |
| 配置判等     | node_modules/@deepseek-ai/dsh-llm/lib/index.js:68                    | function callConfigEquals(a, b) { if (a.provider !== b.provider                                                                                                                                                                                                                                      |     | a.model !== b.model |     | ... ) return false; ... } |
| 冻结         | node_modules/@deepseek-ai/dsh-llm/lib/index.js:98                    | function deepFreeze(value) { const seen = new WeakSet(); const pending = [{ kind: visit, node: value }]; ... Object.freeze(node); ... }                                                                                                                                                              |
| 准备调用冻结 | node_modules/@deepseek-ai/dsh-llm/lib/index.js:1391                  | const resolvedConfig = deepFreeze(structuredClone(resolved.config)); const adapterDefaults = deepFreeze({ ... });                                                                                                                                                                                    |
| 折叠         | node_modules/@deepseek-ai/dsh-session/lib/types/request-header.js:57 | export function foldRequestHeader(events, from) { let state = from; for (const event of events) if (event.type === request/header) state = canonicalHeader(event.data.header); return state; }                                                                                                       |
| 不变量校验   | node_modules/@deepseek-ai/dsh-agent-loop/lib/invariant.js:15         | ctx.on(llm/stream, (options, next) => { if (!isAgentLoopRequest(options)) return next(); if (!Object.isFrozen(options)) fail(a loop-built request must be frozen); ... const header = foldRequestHeader(events); if (JSON.stringify(options.messages) !== JSON.stringify(expected)) fail(...); ... } |

### 6.5 Compaction verbatim 回放（summarizer 回放 system+tools+shadowed messages）

**为何强制**：compaction 若用独立的总结专用 system 或重排历史，会使辅助调用的前缀与上一轮路由请求的前缀分叉，浪费 warm KV cache；同时 checkpoint 本身若非位姿精确替换，会破坏后续请求的公共前缀检测。

**怎么做**：

- 默认总结器 summarizeWithLlm verbatim 回放会话自身的 system、tools 与被遮蔽区消息前缀，仅在末尾追加 COMPACTION_INSTRUCTION 作为最后一条 user 消息，使辅助调用成为上一轮路由请求的真前缀扩展，复用 warm cache。
- 总结输出经 summaryText 过滤仅保留文本，frameSummary 以 CHECKPOINT_PREAMBLE + compacted-summary 标签包装后作为替换型 user 消息落盘；后续请求将该 checkpoint 视为已确立背景继续追加。

**证据链**：

| 证据              | 路径与行号                                                      | 关键行                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 指令设计注释      | node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:212 | The summarization directive, delivered as the FINAL user message after the replayed conversation rather than as a distinct summarizer system prompt. Keeping the conversation own system prompt, tools, and message prefix in front of it makes the auxiliary call a genuine prefix of the last routed request, so the provider KV cache is reused instead of invalidated. |
| verbatim 回放     | node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:280 | const messages = [...input.messages, createUserMessage({ content: [{ type: text, text: COMPACTION_INSTRUCTION }], source: { kind: plugin, plugin: dsh-compaction-basic } })];                                                                                                                                                                                              |
| 透传 system/tools | node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:294 | const options = { provider: target.provider, model: target.model, messages, ...input.system === void 0 ? {} : { system: input.system }, ...input.tools === void 0 ? {} : { tools: [...input.tools] }, maxTokens: config.maxTokens, sessionId: agent.session.id, purpose: compaction, ... }                                                                                 |
| 包装落盘          | node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:322 | function frameSummary(summary) { return [{ type: text, text: CHECKPOINT_PREAMBLE + summary_open_tag }, ...summary, { type: text, text: SUMMARY_CLOSE_TAG }]; }                                                                                                                                                                                                             |

---

## 7. Pi 插件对照

> Pi（@earendil-works/pi-coding-agent）的扩展点与 Harness 的五重手段一一对应；本项目（pi-deepseek-cache）在其上追加三项强制点，进一步收敛字节确定性与可观测性。

### 7.1 三钩子如何复刻 Harness 手段

| Pi 钩子                 | 触发时机                          | 复刻的 Harness 手段                                             | 本项目做法                                                                                                                                                                                                                      |
| ----------------------- | --------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| context                 | 每次组装上下文、即将并入请求前    | 固定 System Prompt 的易变内容后置与 append-only                 | 过滤 customType volatile-scratch 的易变消息，使其不进入 wire 前缀（index.ts:1258 pi.on(context, ...)），避免时间戳/草稿截断稳定前缀                                                                                             |
| before_provider_request | provider payload 已组装、尚未发送 | 工具字典序 + Wire 确定性序列化 + 请求头折叠的发送前最后一致性门 | 见 7.2                                                                                                                                                                                                                          |
| session_before_compact  | 压缩前，允许扩展接管总结          | Compaction verbatim 回放（**未对齐**，见 7.4）                  | 以官方 `deepseek-flash`（兼容 legacy 名 `deepseek-v4-flash`）@ temperature 0 做确定性总结；官方模型不存在时按「当前模型已是 flash 档 → 当前 provider 的 flash 档 → 当前模型」回退，结果按 SHA-256 去重并落盘 summary-cache.json |

#### context — 易变内容隔离

```ts
// index.ts:1258
pi.on("context", async (event, ctx) => {
  if (!Array.isArray(event.messages)) return undefined;
  const onWire = event.messages.filter(
    (m) => (m as unknown as { customType?: unknown }).customType !== "volatile-scratch",
  );
  return { messages: onWire };
});
```

效果：易变草稿仅在 UI 侧可见，不参与 serializeMessages 的 wire 字节，从而不截断 canonicalHeader 所保护的稳定前缀。

#### before_provider_request — 发送前一致性门

```ts
// index.ts:1274 — 节选
pi.on("before_provider_request", (event, ctx) => {
  const payload = event.payload as Record<string, unknown>;
  if (Array.isArray(payload.tools) && payload.tools.length > 1) {
    // 码点字典序排序（localeCompare 依赖 ICU/locale，跨环境可能不同序）
    const sorted = [...payload.tools].sort((a, b) => {
      const na = getToolName(a),
        nb = getToolName(b);
      return na < nb ? -1 : na > nb ? 1 : 0;
    });
    // 仅在顺序确实改变时替换
    if (sorted.some((t, i) => t !== payload.tools![i])) next = { ...payload, tools: sorted };
  }
  // system + tools + messages 三段指纹（tools 为独立顶层字段，必须单独覆盖）
  const fp: PrefixFingerprint = {
    tools: hashMessages(Array.isArray(next.tools) ? next.tools : null),
    messages: hashMessages(msgs),
    head: msgs.length > 1 ? hashMessages(msgs.slice(0, -1)) : "",
    len: msgs.length,
  };
  // 追加式 = 命中任一已知指纹且 tools 未变；末条是临时注入块时走宽松分支
});
```

对应 Harness：orderTools/compareToolNames 的字典序 + callConfigEquals/headerEquals 的真实变化才记录 + deepFreeze 的冻结后不可改写。Pi 钩子在冻结前做最后一次归一化与诊断。

#### session_before_compact — 缓存友好的确定性总结

```ts
// index.ts:1336
pi.on("session_before_compact", async (event, ctx) => {
  flushPendingWrites();
  const { messagesToSummarize, firstKeptEntryId, tokensBefore, previousSummary } =
    event.preparation;
  const history = serializeConversation(convertToLlm(messagesToSummarize));
  const text = previousSummary
    ? "【上次摘要】" + previousSummary + "【新增历史】" + history
    : history;
  const key = createHash("sha256").update(text).digest("hex");
  let summary = summaryCache.get(key);
  if (!summary) {
    summary = await summarizeWithModel(text, ctx, signal); // resolveSummarizerModel 选定, temperature 0
    setSummaryCache(summaryCache, key, summary);
    saveSummaryCache(summaryCache);
  }
  return {
    compaction: {
      summary,
      firstKeptEntryId,
      tokensBefore,
      details: { summarizer: "deepseek-v4-flash" },
    },
  };
});
```

#### 7.4 未对齐项：compaction 并非 verbatim 回放

**Harness 的做法（见 6.5）**：总结器逐条回放会话自身的 `system`、`tools` 与被遮蔽区消息，仅在末尾追加一条 `COMPACTION_INSTRUCTION` 作为最后一条 user 消息，使辅助调用成为上一轮路由请求的**真前缀扩展**，从而复用 warm KV cache。

**本项目的做法**（`index.ts` `summarizeWithModel` + `resolveSummarizerModel`）：把 `serializeConversation(...)` 的历史**序列化为单条 user 消息文本**，与指令拼接后一次发出；不传 `system`、不传 `tools`、不按消息逐条回放。模型选择也不再写死官方 provider：官方候选名（`deepseek-flash` / legacy `deepseek-v4-flash`）→ 当前模型已是 `flash` 档则直接用当前模型 → 当前 provider 的 `flash` 档（优先名字含 `deepseek`）→ 当前模型。

**差异与后果**（不得再声称 parity）：

| 维度     | Harness verbatim 回放                  | 本项目                                                                                                                                             |
| -------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 前缀形态 | 上一轮请求的真前缀扩展                 | 全新前缀，与上一轮无字节重合                                                                                                                       |
| 缓存效果 | 复用 warm cache，仅 prefill 新增的指令 | 每次 compaction 冷启动，全量 prefill 整段历史                                                                                                      |
| 稳定内容 | 指令置于最后，历史变动不影响前缀       | 指令与历史拼接在同一段文本内，历史一变即全量重算                                                                                                   |
| 路由     | 透传原 provider/model                  | v0.5 起：官方 `deepseek` provider 上的 `deepseek-flash`（legacy 名回退）→ 当前模型已是 `flash` 档时直接用 → 当前 provider 的 `flash` 档 → 当前模型 |

补充：摘要缓存 key 为 `sha256(序列化历史全文)`，需历史**逐字节相同**才能命中。因此“跨会话复用”在实践中几乎不会发生（跨会话历史必然不同），真实命中场景是同会话内对同一压缩集合重复总结。

> 若要真正对齐 Harness 6.5，需要改为按消息逐条回放 `system + tools + messages`、把指令作为最后一条 user 消息追加，并透传原会话的 provider/model。当前实现是**独立冷调用**，属于刻意的工程权衡（隔离主请求路由、保证 temperature 0 的确定性），而非等价实现。

### 7.2 本项目新增的三个强制点

- **问题**：Pi 侧不同扩展注册工具的顺序不确定；若直接透传，wire 字节在 tools 段即分叉。
- **做法**：在 before_provider_request 中对 payload.tools 按 getToolName 的码点字典序排序，仅在顺序确实改变时以 `{...payload, tools: sorted}` 非破坏性返回替换（index.ts:1274）。
- **与 Harness 一致性**：与 dsh-system-prompt/lib/index.js:44 orderTools 的回退分支语义一致（未配置 toolOrder 时按 compareToolNames 排序）；Pi 侧同样使用码点比较（localeCompare 依赖 ICU/locale，跨环境可能不同序，已弃用）。
- **可观测**：排序先于指纹计算，诊断基于归一化后的字节。

#### 2. 前缀包含检测（Prefix Containment Check）

- **问题**：官方要求完整匹配已持久化的 cache prefix unit，但开发期更关心本轮请求是否仍是上一轮的追加——非追加即可能 miss。
- **覆盖面（重要）**：指纹必须同时覆盖 `system`、`tools`、`messages` 三段。pi-ai 的 `openai-completions` `buildParams` 把 `system` 并入 `messages`，但 **`tools` 是独立顶层字段**；早期实现只哈希 `messages`，导致工具增删或 schema 变更击穿缓存时零告警。现已对 `tools` 单独取 `stableStringify` + SHA-256 并纳入比对。
- **做法**：对完整 messages 列表（含最后一条，对齐官方 cache unit 落盘边界——用户输入末尾）与归一化后的 tools 分别做 stableStringify + SHA-256，组成 `PrefixFingerprint { tools, messages, head, len }`；本轮为追加式 = 消息列表以某个已知指纹开头**且 tools 指纹未变**，否则 `prefixBreaks++` 并 `ctx.ui.notify` 告警（index.ts:1320）。
- **尾部临时注入块（勿误报）**：有些扩展为不击穿 provider 前缀缓存，会把每轮才生成、**不落历史**的临时块（`@wbline/pi-plan-build` 的计划状态、todo 状态）追加到消息数组**末尾**；下一轮该位置被真实历史（助手回复）取代，严格全量比对必然失败 → 每轮刷一次告警，而真实命中率毫无变化。因此追加式判断分两级：先全量严格比对（语义不变）；失败后再比“忽略上一份末条”，由 `head`（存入时算一次的去掉末条哈希）直接命中，**且仅当本轮 `messages.length` 变大时启用**。等长而末条被改写、历史被压缩变短、中间任意位置被改写、tools 增删/schema 变化，四种情况两条比对同时失败 → 照常告警。
- **为何不改成让注入方打标记**：要求每个做尾部注入的扩展都配合改 `customType`，且内容格式一改就静默失效；追加式判据本身才是错的那个（`volatile-scratch` 过滤只覆盖带 `customType` 的自定义消息，见 1 节）。
- **多指纹集合**：官方 unit 独立完整、可并存，且未使用的条目数小时至数日内才清理。因此判定“是否破坏前缀”不能只看上一轮——回落到早期已落盘前缀仍是有效命中（官方 Example 2）。实现保留有界集合（`MAX_KNOWN_PREFIXES = 8`），命中任一即视为追加式。
- **与 Harness 一致性**：Harness 以 foldRequestHeader + headerEquals 判断 envelope 是否变化，以 session.deriveMessages() 重建历史；本项目在 wire 侧以哈希等价实现前缀包含检测，二者互补——前者保 envelope（含 system/tools），后者保 messages 前缀的追加性。
- **序列化稳定性**：使用 stableStringify（键按字典序排序，数组保持原序，递归稳定）避免同一语义因键序抖动而误报 break（index.ts:466）。
- **哈希对象是 wire payload 而非重建历史**：指纹直接哈希即将发送的 `payload.messages`，因此凡是会影响前缀的字段（包括 pi 按 `requiresReasoningContentOnAssistantMessages` 回放的 `reasoning_content`、`content` 数组形态的图片块等）无需特例即被覆盖。两端边界需知情：
  - 官方 [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)：携带 `tools` 时历史 `reasoning_content` 会拼接进上下文（因此变动它就是真实击穿，告警正确）；不携带 `tools` 时它被忽略，此时因它变动而告警属误报。pi 的模型目录对两个 DeepSeek 模型都标为 `requiresReasoningContentOnAssistantMessages: true`，且 pi 恒发工具，故实际不会命中误报分支。
  - `user_id` 是官方文档明列的 KVCache 隔离维度（[Rate Limit & Isolation](https://api-docs.deepseek.com/quick_start/rate_limit)），但 pi 不发送该字段，因此本扩展未将其纳入指纹；若将来 pi 开始发送按会话轮换的 `user_id`，需同步加入，否则会出现“前缀完全一致但命中率骤降”的哑否。

#### 3. 原子落盘（Atomic Persistence）

- **问题**：统计与摘要缓存若以非原子写落盘，崩溃时可能产生半截 JSON，导致下次启动误判或丢失命中归因。
- **做法**：atomicWriteJson 先写入 path.pid.tmp，再 renameSync 原子替换（index.ts:505）；所有持久化（stats.json / summary-cache.json / hitRateHistory）均经此路径，配合 session_shutdown 与 session_before_compact 前的 flushPendingWrites()，保证退出必 flush与压缩前必 flush。
- **与 Harness 一致性**：Harness 会话存储（JSONL/SQLite）亦保证 Persistence does not mutate live request prefixes 且修复结果 append 而非重写；本项目在扩展侧以原子文件语义延续同一不变量。

### 7.3 遥测与可视化（P1）

| 能力                                                                                                                                                       | 实现                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 监听 message_end 累积 cacheRead / input / cacheWrite / turns，**按模型（provider + id）分桶**（v0.5）                                                      | index.ts message_end 处理                     |
| 落盘 ~/.pi/agent/extensions/deepseek-cache/stats.json（v2 = `byModel[]`；v1 的扁平累计读取时归入 `unknown` 桶）                                            | `normalizeStats` / atomicWriteJson            |
| 状态栏实时显示 cache xx.x% · Nt（**当前模型**口径；切模型不继承上一个模型的数字）                                                                          | index.ts status bar                           |
| /cache-stats 头部为当前模型，另有「全部模型累计」与按 token 量排序的按模型明细（最多 3 行，弹窗不滚动）                                                    | index.ts `buildStatsView` / `MAX_BUCKET_ROWS` |
| 同时展示**累计**命中率与**本轮**命中率（官方为按请求逐次统计口径，两者不同）                                                                               | index.ts `StatsView.lastTurnHitRate`          |
| 节省额按**模型目录单价**计价（`saved = cacheRead/1e6 * (miss − hit)`），仅官方 `deepseek` provider 套用峰谷折半；展示单价来源、模型与单价；小额用 4 位小数 | index.ts `resolvePricing` / `buildStatsView`  |
| 目录零价（免费 / 未标价模型）时不估算节省，显示 `—`（v0.5）                                                                                                | index.ts `PricingResolution.available`        |
| 官方 usage 无 cache write 字段，未观测到非零写入时隐藏「缓存写入」行（避免恒为 0 的死 UI）                                                                 | index.ts `reportsCacheWrite`                  |

### 7.4 Compaction 取舍（P3）与原生续命对齐（P4）

**P3 为什么不是 verbatim 回放。** 宿主 compaction 的输入是「被替换掉的历史」，与下一次真实请求的前缀不重合；要复用 warm 前缀就得连 `system + tools + shadowed messages` 一起回放（Harness `compaction-basic/summarizer.ts` 的做法），代价是摘要请求本身变大、且摘要器一旦不是同一路由就前功尽弃。本项目改用「一次性冷调用 + SHA-256 摘要缓存」：命中缓存时零请求，未命中时也不指望命中前缀。这一取舍自 v0.3 起未变。

**与 pi 1.4.0 的对齐点**（宿主契约变了，自定义压缩必须自己跟上，否则是静默行为差异）：

| 宿主契约                                                                | 本项目做法                                                       | 不跟上的后果                                                     |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| `/compact <指令>` 经 `event.customInstructions` 传入（pi 1.4.0 #11058） | 以 `Additional focus: ...` 并入摘要 prompt，**并计入摘要缓存键** | 用户的定向压缩指令被静默丢弃；换指令还会命中旧摘要               |
| 摘要不再设 `maxTokens`，改用模型输出上限（pi 1.4.0 #9512）              | 不传 `maxTokens`                                                 | 长 reasoning 摘要仍会 `stopReason: "length"`，而截断摘要会被拒收 |
| 一次性摘要请求 `cacheRetention: none`                                   | 同样传 `none`                                                    | 在按写入计费的 provider 上为一次性摘要白付缓存写入费             |
| `event.reason`（manual / threshold / overflow）                         | 写进 `compaction.details.reason`                                 | 事后无法区分「手动压」与「撑爆才压」的检查点                     |

**P4 为什么不自己实现续命。** pi 0.86.0 起自带成本感知续命：刷新 = 重放原请求 + 1 个输出 token，代价是「一次 cache read + 1 token」，并且只在 `expectedSavings ≥ $0.05` 时执行。这套模型对 DeepSeek 同样成立（命中按 cacheRead 计费、无写入费），重复实现没有价值。

**P4 的两个实际问题**：

1. **资格缺失**：pi 只在模型声明了 `promptCache` 生命期时才续命，而内置 deepseek 目录一条都没声明 → 对 DeepSeek 等于永久关闭。官方只说明「长时间不用的缓存会自动清空」（社区实测数小时至数日），所以 `/cache-warm` 给的是保守端 `short: 3600`，并明确要求用 `/cache-stats` 复核。
2. **否决权**：自建实例常按副本缓存、router 会扇出到不同副本、缓存也可能被关。这类环境下续命每次都要付费却不可能换来命中，因此当某模型在 `turns >= 3` 内没有任何 cache read 时，扩展把 `cache_warming_decision` 覆写为 `stop`（只影响本轮，下一次真实请求会重新裁决）。

---

## 8. 参考链接

- **DeepSeek 官方**
  - [Context Caching — DeepSeek API Docs](https://api-docs.deepseek.com/guides/kv_cache) — 硬盘缓存总述、三种持久化、两示例、计费二字段、best-effort（本文第 2 章 Ground Truth 来源）
  - [API Introduces Context Caching on Disk — News 2024-08-02](https://api-docs.deepseek.com/news/news0802) — 首次发布。**旧口径参考**：其中 “cache hit $0.014/M、miss $0.14/M” 与 “64 token 存储单元” 均为 2024 年首发价与旧粒度，已被现行价目表与现行缓存粒度取代（见 3.3 / 4.3）
  - [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) — 现行价目表、peak/off-peak 规则（官方注(2)）、legacy 模型名说明（官方注(1)）；官方 `deepseek` provider 按该表与时段计价（第三方部署按模型目录价，见 4.3 / README「第三方部署」一节）

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
  - index.ts:466 — stableStringify 字节稳定序列化
  - index.ts:505 — atomicWriteJson 原子落盘
  - index.ts:46 — DEEPSEEK_PRICING 官方价目表（含 peak/off-peak、v4-pro 独立价与 legacy 名）；v0.5 起为**兜底**，优先取模型目录 cost（见 4.3）
  - index.ts:88 — CN_PUBLIC_HOLIDAYS 中国公共假期（峰值窗口排除）
  - index.ts:105 — isPeakWindow 峰值/谷值判定
  - index.ts:1258 — context 易变隔离
  - index.ts:1274 — before_provider_request 工具排序 + system/tools/messages 三段前缀指纹（含尾部注入块的两级追加式判定）
  - index.ts:1336 — session_before_compact 确定性总结与摘要缓存
  - index.ts:1538 — summarizeWithModel 独立冷调用（非 verbatim 回放，见 7.4）
  - README.md — 功能总览与 [DeepSeek Context Caching docs](https://api-docs.deepseek.com/guides/kv_cache) 入口

---

_最后更新：2026-10-15（v0.5.0：第三方部署计价与摘要器、按模型分桶）· 维护者：pi-deepseek-cache_

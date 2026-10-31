<div align="center">

# 🚀 pi-deepseek-cache

**充分发挥 [Pi](https://pi.dev) 编码代理中 DeepSeek 上下文缓存的能力。**

稳定的提示前缀 · 更高的缓存命中率 · 实时缓存统计 — 让长会话的大部分输入按*缓存命中*费率结算。

[![npm version](https://img.shields.io/npm/v/pi-deepseek-cache.svg)](https://www.npmjs.com/package/pi-deepseek-cache)
[![npm downloads](https://img.shields.io/npm/dm/pi-deepseek-cache.svg)](https://www.npmjs.com/package/pi-deepseek-cache)
[![license](https://img.shields.io/npm/l/pi-deepseek-cache.svg)](./LICENSE)

[English](./README.md) | [中文](./README.zh.md)

</div>

---

## ✨ 为什么需要这个

DeepSeek API 内置了**磁盘上下文缓存**：任何提示**前缀**与已持久化的 cache prefix unit 完全匹配的请求，都按更便宜的*缓存命中*费率计费。但前提是——提示前缀必须**跨轮次稳定**，逐 token 一致。

在长时间的代理会话中，这出乎意料地困难：

- 系统提示或工具列表在各轮之间微妙变化
- 对话历史不断增长和偏移
- 大型 / 非确定性的工具输出破坏前缀
- 重复的元数据块未对齐

**`pi-deepseek-cache`** 让你的 DeepSeek 提示保持缓存友好，并精确展示效果 —— 无论你走的是官方 API，还是[任何把 DeepSeek 放在 OpenAI 兼容端点后面的第三方部署](#-第三方部署openai-兼容)。

## 🎯 功能特性

- **前缀守卫** — 从上下文中剥离 `volatile-scratch` 消息，保持提示前缀跨轮次稳定
- **稳定工具排序** — 在 `before_provider_request` 中按字典序排序 `tools`（对齐 Harness `orderTools`），工具顺序抖动不再击穿缓存
- **缓存破坏诊断** — 对 `system` + `tools` + `messages` 三段做稳定 JSON + SHA-256 指纹，仅在既有前缀被改写时告警，正常追加不打扰（末尾追加不落历史的临时块——如 `@wbline/pi-plan-build` 的计划状态——也不算断链）；回落到任意仍存活的早期前缀视为有效命中（官方 unit 可并存）；空/未知 payload 静默跳过
- **命中率遥测** — 从每次响应中**按模型**累计 `cacheRead` / `input` / `cacheWrite` / `turns` 并持久化到磁盘；切模型不会把两个相差几十倍的单价混成一个数字
- **实时状态栏** — 每条消息后在 Pi 底栏显示***当前模型***的累计命中率与轮次
- **ASCII 趋势图** — 使用 `/cache-graph` 可视化**全部模型累计**口径的命中率趋势（平坦率特判 + 定点标签）
- **成本节省估算** — 按**模型目录**（`models.json` / pi 内置目录）里当前模型的 `cost` 计价 —— 这才是官方与第三方部署都成立的真源。只有 provider 是官方 `deepseek` 时才额外套用官方 [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) 价目表与 peak/off-peak 时段；目录里零价的模型显示 `—` 而不是编一个数字。`/cache-stats` 同时展示累计/本轮命中率、所用模型、**单价来源**、单价，以及按模型的明细
- **缓存友好的 compaction** — 存在官方 `deepseek-flash`（legacy 名 `deepseek-v4-flash` 回退）时优先用它；否则当前模型本身已是 `flash` 档时直接用当前模型；否则用**当前 provider** 的 `flash` 档模型；再否则用当前模型。统一 temperature 0；结果按 SHA-256 缓存并跨会话复用（LRU 上限 64）。已对齐 pi 1.4.0：`/compact <指令>` 会作为 `Additional focus` 带进摘要 prompt 并计入缓存键；不再传 `maxTokens`（吃模型输出上限）；一次性摘要请求 `cacheRetention: none`。注意：这是**独立冷调用**，**并非**对路由请求的 verbatim 回放 —— 详见 [§7.4](./docs/prefix-cache-principle.md)
- **缓存续命桥接** — pi 原生的成本感知续命（`cacheWarming` / `cache_warming_decision`）对 DeepSeek 默认永久关闭：内置目录里的 deepseek 模型没有声明 `promptCache` 生命期。`/cache-warm` 报出当前模型的续命资格，并直接给出让它生效的 `models.json` 片段；同时当某模型连续数轮没有任何 cache read（自建副本、router 扇出、缓存被关）时，扩展会**否决**本轮续命，避免为不会被复用的缓存付费
- **原子持久化** — `tmp + rename` 原子写入 + 防抖异步落盘 + `session_start`/`session_shutdown` 生命周期保障，无撕裂 JSON
- **`/cache-reset`** — 一条命令清空所有统计、历史和摘要缓存

## 📦 安装

需要 [Pi](https://pi.dev) 和 Node.js ≥ 18。

```bash
pi install npm:pi-deepseek-cache
```

或从 Git 安装：

```bash
pi install git:github.com/ruanbw/pi-deepseek-cache
```

## 🚦 快速开始

1. 确保已配置 DeepSeek provider（设置 `DEEPSEEK_API_KEY`）。
2. 选择 DeepSeek 模型，如 `deepseek/deepseek-v4-flash`。
3. 开始编码——扩展会自动激活并在底栏显示缓存统计。

```bash
export DEEPSEEK_API_KEY=sk-...
pi --model deepseek/deepseek-v4-flash
```

用的是第三方部署（OpenRouter / 自建端点 / 本地 router）？不需要 DeepSeek API Key，也不需要 `deepseek` provider —— 见下一节。

## 🔌 第三方部署（OpenAI 兼容）

所有钩子都与 provider 无关：遥测读的是端点自己上报的 `usage.cacheRead` / `usage.input`，前缀守卫与破坏诊断作用于即将发出的 wire payload。因此自建 vLLM/SGLang、托管 router、本地网关服务的 DeepSeek 模型同样适用 —— 扩展不关心你前面挂的是什么 provider id。

与官方 API 的差别：

| 层                               | 官方 `deepseek` provider                               | 第三方部署                                                                                                                          |
| -------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| 命中率遥测                       | `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` | 端点只要上报命中 token（如 `prompt_tokens_details.cached_tokens`）就能测；完全不上报时每轮都看起来是 miss                           |
| 计价                             | 官方价目表 + peak/off-peak 折半                        | 取模型目录里当前模型的 `cost`，**flat 价** —— 峰谷是 DeepSeek 的计费策略，不是宿主的。目录无价 → `—` 而非猜测                       |
| 前缀守卫 · 工具字典序 · 破坏诊断 | 相同                                                   | 相同 —— 字节稳定的前缀对任何前缀缓存实现都有益                                                                                      |
| compaction 摘要器                | `deepseek-flash`（legacy `deepseek-v4-flash` 回退）    | 当前模型已是 `flash` 档则直接用当前模型；否则取**当前 provider** 里第一个 `flash` 档模型（优先名字含 `deepseek`）；再否则用当前模型 |

两条第三方宿主特有的注意事项：

- **实例亲和（instance affinity）**：自建引擎的 prefix cache 通常是**按实例**的，因此一次 miss 可能是“router 把这一轮发到了另一个副本”，而不是“前缀被改写”。破坏诊断分不出这两种情况。如果你的 router 能把会话固定到同一后端（magpie 通过 `compat.sendSessionAffinityHeaders` 做到），保持开启。
- **计费跟随宿主，不跟随 DeepSeek**：各宿主对缓存输入的折扣方式不同（打折 / 免费 / 完全不打折）。节省额按你在目录里配置的单价估算，因此请把 `models.json` 里的 `cost.input` / `cost.cacheRead` 填准 —— 对非官方 provider，这是扩展唯一信任的计价依据。

```jsonc
// ~/.pi/agent/models.json —— 一个第三方 DeepSeek 部署
{
  "providers": {
    "my-router": {
      "api": "openai-completions",
      "baseUrl": "https://my-router.example/v1",
      "apiKey": "...",
      "models": [
        {
          "id": "deepseek-v4.1-flash",
          "name": "DeepSeek V4.1 Flash (my-router)",
          "contextWindow": 1000000,
          "maxTokens": 384000,
          "cost": { "input": 0.15, "output": 0.28, "cacheRead": 0.003, "cacheWrite": 0 },
        },
      ],
    },
  },
}
```

```bash
pi --model my-router/deepseek-v4.1-flash
```

## 🧩 命令

| 命令           | 说明                                                                        |
| -------------- | --------------------------------------------------------------------------- |
| `/cache-stats` | 弹窗显示命中率、缓存命中/未命中 token、轮次、预估节省、单价来源与按模型明细 |
| `/cache-graph` | 弹窗显示**全部模型累计**口径的缓存命中率 ASCII 趋势图                       |
| `/cache-warm`  | 当前模型的缓存续命资格，并给出让它生效的 `models.json` 片段                 |
| `/cache-reset` | 重置所有统计、历史和摘要缓存（同时清除内存和磁盘）                          |

## 🔍 工作原理

| 层                  | 说明                                                                                                                                                                                                                                                                                                                   | Harness 谱系                                                                                                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1 — 遥测**       | 在 `message_end` 事件中**按模型**（provider + id）累计 `cacheRead` / `input` / `cacheWrite` / `turns`，原子持久化到 `~/.pi/agent/extensions/deepseek-cache/stats.json`（可用 `PI_DEEPSEEK_CACHE_DIR` 改目录）；节省额按模型目录计价，仅官方 `deepseek` provider 额外套用官方价目表 + 峰谷时段                          | `TokenUsage` DISJOINT（`translate.ts:mapUsage`）—— `input = prompt_tokens - cacheRead`                                                                                                                |
| **P2 — 前缀守卫**   | 在 `context` 中过滤 `volatile-scratch`；在 `before_provider_request` 中按字典序排序 `tools`；对 `system` + `tools` + `messages` 三段做稳定 JSON 指纹，与有界的已知前缀集合做包含检测                                                                                                                                   | `orderTools` / `sameSchema` / `canonicalHeader` / `headerEquals`（`packages/core/system-prompt`、`packages/core/session`）                                                                            |
| **P3 — Compaction** | 在 `session_before_compact` 时将历史序列化为单条 user 消息，temperature 0 做摘要：优先官方 `deepseek-flash`（legacy 名回退），否则当前 provider 的 `flash` 档，再否则当前模型；`/compact <指令>` 作为 `Additional focus` 传递、不传 `maxTokens`、一次性摘要 `cacheRetention: none`；SHA-256 缓存（LRU 64）并原子持久化 | **无 parity** —— Harness `compaction-basic/summarizer.ts` 会回放 `system+tools+shadowed messages` + 尾部指令以复用 warm 前缀；本路径是独立冷调用，取舍理由见 [§7.4](./docs/prefix-cache-principle.md) |
| **P4 — 续命**       | 续命本身交给 pi（`cacheWarming`，刷新成本 = 一次 cache read + 1 个输出 token，且仅当模型声明了 `promptCache` 才运行）；当某模型在 `turns >= 3` 内没有任何 cache read（前缀缓存明显没在服务该部署）时，把 `cache_warming_decision` 覆写为 `stop`                                                                        | pi `cache-warmer.ts` —— 成本感知裁决，扩展可改 `action`，改失败自动回落到 pi 自己的判断                                                                                                               |

> 📖 深入原理：[前缀缓存原理](./docs/prefix-cache-principle.md) —— 官方 [Context Caching on Disk](https://api-docs.deepseek.com/guides/kv_cache)（基于 SWA 的独立 cache prefix unit、3 种落盘时机、best-effort）+ Harness 五重强制 + Pi 映射

## 🛠️ 故障排查

- **缓存命中率低** → 通常是静态前缀在变化。避免在提示开头注入时间戳、随机 ID 或易变的工具输出。注意：增删扩展会改变 `tools` 段，其破坏力与改写历史等同。
- **"Cache prefix change" 警告** → 对话历史、工具集合或某个工具的 schema 被修改。检查是否有工具或扩展在变更过去的消息，或在轮次之间注册/注销工具。在第三方宿主上，它也可能只是 router 把你换到了另一个副本（见[实例亲和](#-第三方部署openai-兼容)）。
- **底栏无显示** → 确认已选择服务 DeepSeek 的模型，且其 provider 凭据可用。
- **第三方端点上命中率恒为 0%** → 该端点不在 `usage` 里上报命中 token，扩展无从测量。去查原始响应，不要怀疑扩展。
- **预估节省显示 `—`** → 模型在目录里没有可用的 `cost.input`（免费 / 未标价）。给 `models.json` 里对应模型补上 `cost` 才会有数字。
- **`/cache-warm` 说没有声明生命期** → pi 无法为未声明 `promptCache` 的模型续命，而内置 deepseek 目录一条都没声明。把命令给出的 `models.json` 片段复制过去即可（`short: 3600` 取保守端：官方只说“长时间不用的缓存会自动清空”，社区实测为数小时至数日），随后用 `/cache-stats` 确认命中真的在增长。

## 🧪 测试

```bash
npm test              # 90 个测试（80 单元 + 10 集成）
```

## 🤝 贡献

欢迎提交 Issue 和 PR！提交前请运行：

```bash
npm run lint          # ESLint + Prettier 检查
npm test              # 单元 + 集成测试
```

## 📄 许可证

[MIT](./LICENSE) © ruanbw

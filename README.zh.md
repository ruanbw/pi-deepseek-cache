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

**`pi-deepseek-cache`** 让你的 DeepSeek 提示保持缓存友好，并精确展示效果。

## 🎯 功能特性

- **前缀守卫** — 从上下文中剥离 `volatile-scratch` 消息，保持提示前缀跨轮次稳定
- **稳定工具排序** — 在 `before_provider_request` 中按字典序排序 `tools`（对齐 Harness `orderTools`），工具顺序抖动不再击穿缓存
- **缓存破坏诊断** — 对 `system` + `tools` + `messages` 三段做稳定 JSON + SHA-256 指纹，仅在既有前缀被改写时告警，正常追加不打扰；回落到任意仍存活的早期前缀视为有效命中（官方 unit 可并存）；空/未知 payload 静默跳过
- **命中率遥测** — 从每次响应中累计 `cacheRead` / `input` / `cacheWrite` / `turns` 与当前 `model`，持久化到磁盘
- **实时状态栏** — 每条消息后在 Pi 底栏显示**累计**命中率与轮次
- **ASCII 趋势图** — 使用 `/cache-graph` 可视化缓存命中率趋势（平坦率特判 + 定点标签）
- **成本节省估算** — 按官方 [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) 中**当前模型**的价目表、并区分 peak/off-peak 时段计价；`/cache-stats` 同时展示累计与本轮命中率、所用模型、时段与单价
- **缓存友好的 compaction** — 使用 `deepseek-flash`（temperature: 0，自动回退到 legacy 名 `deepseek-v4-flash`）做确定性摘要，SHA-256 缓存结果跨会话复用（LRU 上限 64）。注意：这是**独立冷调用**，**并非**对路由请求的 verbatim 回放 —— 详见 [§7.4](./docs/prefix-cache-principle.md)
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

## 🧩 命令

| 命令 | 说明 |
|------|------|
| `/cache-stats` | 弹窗显示命中率、缓存命中/未命中 token、轮次和预估节省 |
| `/cache-graph` | 弹窗显示缓存命中率 ASCII 趋势图 |
| `/cache-reset` | 重置所有统计、历史和摘要缓存（同时清除内存和磁盘） |

## 🔍 工作原理

| 层 | 说明 | Harness 谱系 |
|----|------|-------------|
| **P1 — 遥测** | 在 `message_end` 事件中累计 `cacheRead` / `input` / `cacheWrite` / `turns` 与当前 `model`，原子持久化到 `~/.pi/agent/extensions/deepseek-cache/stats.json`；按官方价目表 + peak/off-peak 时段计价 | `TokenUsage` DISJOINT（`translate.ts:mapUsage`）—— `input = prompt_tokens - cacheRead` |
| **P2 — 前缀守卫** | 在 `context` 中过滤 `volatile-scratch`；在 `before_provider_request` 中按字典序排序 `tools`；对 `system` + `tools` + `messages` 三段做稳定 JSON 指纹，与有界的已知前缀集合做包含检测 | `orderTools` / `sameSchema` / `canonicalHeader` / `headerEquals`（`packages/core/system-prompt`、`packages/core/session`） |
| **P3 — Compaction** | 在 `session_before_compact` 时将历史序列化为单条 user 消息，用 `deepseek-flash`（含 legacy 名回退，temperature: 0）做摘要，SHA-256 缓存（LRU 64）并原子持久化 | **无 parity** —— Harness `compaction-basic/summarizer.ts` 会回放 `system+tools+shadowed messages` + 尾部指令以复用 warm 前缀；本路径是独立冷调用，取舍理由见 [§7.4](./docs/prefix-cache-principle.md) |

> 📖 深入原理：[前缀缓存原理](./docs/prefix-cache-principle.md) —— 官方 [Context Caching on Disk](https://api-docs.deepseek.com/guides/kv_cache)（基于 SWA 的独立 cache prefix unit、3 种落盘时机、best-effort）+ Harness 五重强制 + Pi 映射

## 🛠️ 故障排查

- **缓存命中率低** → 通常是静态前缀在变化。避免在提示开头注入时间戳、随机 ID 或易变的工具输出。注意：增删扩展会改变 `tools` 段，其破坏力与改写历史等同。
- **"Cache prefix change" 警告** → 对话历史、工具集合或某个工具的 schema 被修改。检查是否有工具或扩展在变更过去的消息，或在轮次之间注册/注销工具。
- **底栏无显示** → 确认已选择 DeepSeek 模型且 API Key 已设置。

## 🧪 测试

```bash
npm test              # 28 个测试（18 单元 + 10 集成）
```

## 🤝 贡献

欢迎提交 Issue 和 PR！提交前请运行：

```bash
npm run lint          # ESLint + Prettier 检查
npm test              # 单元 + 集成测试
```

## 📄 许可证

[MIT](./LICENSE) © ruanbw

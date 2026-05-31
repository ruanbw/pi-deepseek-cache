<div align="center">

# 🚀 pi-deepseek-cache

**Squeeze the most out of DeepSeek's context caching inside the [Pi](https://pi.dev) coding agent.**

Stable prompt prefixes · higher cache-hit rates · live cache stats — so long sessions cost up to **90% less**.

[![npm version](https://img.shields.io/npm/v/pi-deepseek-cache.svg)](https://www.npmjs.com/package/pi-deepseek-cache)
[![npm downloads](https://img.shields.io/npm/dm/pi-deepseek-cache.svg)](https://www.npmjs.com/package/pi-deepseek-cache)
[![license](https://img.shields.io/npm/l/pi-deepseek-cache.svg)](./LICENSE)

[English](./README.md) | [中文](./README.zh.md)

</div>

---

## ✨ Why this exists

DeepSeek's API has **Context Caching on Disk** built in: any request whose prompt **prefix** exactly matches a previous one is billed at the much cheaper *cache-hit* rate (often ~90% off). The catch — cache hits only happen when your prompt prefixes stay **byte-for-byte stable**.

In long agent sessions that's surprisingly hard:

- the system prompt or tool list changes subtly between turns
- conversation history grows and shifts
- large / non-deterministic tool outputs break the prefix
- repeated metadata blocks aren't aligned

**`pi-deepseek-cache`** keeps your DeepSeek prompts cache-friendly and shows you exactly how well it's working.

## 🎯 Features

- **Prefix Guard** — strips `volatile-scratch` messages from the context to keep the byte prefix stable across turns
- **Cache Break Diagnostics** — detects when the cache prefix unexpectedly changes and notifies you immediately
- **Hit Rate Telemetry** — accumulates `cacheRead` / `input` / `cacheWrite` / `turns` from every response and persists to disk
- **Live Status Bar** — see hit rate and turn count in the Pi footer after every message
- **ASCII Trend Chart** — visualize cache hit rate over time with `/cache-graph`
- **Cost Savings Estimation** — estimated dollar savings displayed in `/cache-stats`
- **Cache-Friendly Compaction** — uses `deepseek-v4-flash` (temperature: 0) for deterministic summarization, with SHA-256–cached results persisted across sessions
- **`/cache-reset`** — clear all stats, history, and summary cache with one command

## 📦 Installation

Requires [Pi](https://pi.dev) and Node.js ≥ 18.

```bash
pi install npm:pi-deepseek-cache
```

Or install from git:

```bash
pi install git:github.com/ruanbw/pi-deepseek-cache
```

## 🚦 Quick start

1. Make sure a DeepSeek provider is configured (`DEEPSEEK_API_KEY` set).
2. Select a DeepSeek model such as `deepseek/deepseek-chat`.
3. Start coding — the extension activates automatically and reports cache stats in the footer.

```bash
export DEEPSEEK_API_KEY=sk-...
pi --model deepseek/deepseek-chat
```

## 🧩 Commands

| Command | Description |
|---------|-------------|
| `/cache-stats` | Overlay popup with hit rate, cached/missed tokens, turns, and estimated savings |
| `/cache-graph` | Overlay popup with ASCII trend chart of cache hit rate over time |
| `/cache-reset` | Reset all stats, history, and summary cache (clears both memory and disk) |

## 🔍 How it works

| Layer | What it does |
|-------|-------------|
| **P1 — Telemetry** | Accumulates `cacheRead` / `input` / `cacheWrite` / `turns` from `message_end` events, persists to `~/.pi/agent/extensions/deepseek-cache/stats.json` |
| **P2 — Prefix Guard** | Filters out messages with `customType="volatile-scratch"` in the `context` hook, preventing volatile content from breaking the byte prefix. Monitors prefix hashes and alerts on unexpected changes. |
| **P3 — Compaction** | On `session_before_compact`, summarizes history with `deepseek-v4-flash` at temperature 0. Summaries are cached by SHA-256 hash and persisted to disk for cross-session reuse. |

> 📖 More on the underlying mechanism: [DeepSeek Context Caching docs](https://api-docs.deepseek.com/guides/kv_cache)

## 🛠️ Troubleshooting

- **Cache hit rate is low** → usually a changing static prefix. Avoid injecting timestamps, random IDs, or volatile tool output near the start of the prompt.
- **"Cache prefix change" warning** → something in the earlier conversation history was modified. Check if a tool or extension is mutating past messages.
- **Footer shows nothing** → confirm a DeepSeek model is selected and your API key is set.

## 🧪 Test

```bash
npm test              # 28 tests (18 unit + 10 integration)
```

## 🤝 Contributing

Issues and PRs welcome! Please run `npm test` before submitting.

```bash
npm run lint          # ESLint + Prettier check
npm test              # Unit + integration tests
```

## 📄 License

[MIT](./LICENSE) © ruanbw

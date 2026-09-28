<div align="center">

# 🚀 pi-deepseek-cache

**Squeeze the most out of DeepSeek's context caching inside the [Pi](https://pi.dev) coding agent.**

Stable prompt prefixes · higher cache-hit rates · live cache stats — so long sessions pay the *cache-hit* rate on most of their input.

[![npm version](https://img.shields.io/npm/v/pi-deepseek-cache.svg)](https://www.npmjs.com/package/pi-deepseek-cache)
[![npm downloads](https://img.shields.io/npm/dm/pi-deepseek-cache.svg)](https://www.npmjs.com/package/pi-deepseek-cache)
[![license](https://img.shields.io/npm/l/pi-deepseek-cache.svg)](./LICENSE)

[English](./README.md) | [中文](./README.zh.md)

</div>

---

## ✨ Why this exists

DeepSeek's API has **Context Caching on Disk** built in: any request whose prompt **prefix** fully matches a previously persisted cache prefix unit is billed at the much cheaper *cache-hit* rate. The catch — your prompt prefixes must stay **stable across turns**, token-for-token.

In long agent sessions that's surprisingly hard:

- the system prompt or tool list changes subtly between turns
- conversation history grows and shifts
- large / non-deterministic tool outputs break the prefix
- repeated metadata blocks aren't aligned

**`pi-deepseek-cache`** keeps your DeepSeek prompts cache-friendly and shows you exactly how well it's working.

## 🎯 Features

- **Prefix Guard** — strips `volatile-scratch` messages from the context to keep the prompt prefix stable across turns
- **Stable Tool Ordering** — lexicographically sorts `tools` in `before_provider_request` (Harness `orderTools` parity) so tool-list order jitter never breaks the cache
- **Cache Break Diagnostics** — fingerprints the full `system` + `tools` + `messages` prefix (stable-JSON + SHA-256) and warns only when an existing prefix is rewritten, not on normal append; returning to any still-live earlier prefix counts as a valid hit; empty/unknown payloads are silently skipped
- **Hit Rate Telemetry** — accumulates `cacheRead` / `input` / `cacheWrite` / `turns` from every response and persists to disk
- **Live Status Bar** — see cumulative hit rate and turn count in the Pi footer after every message
- **ASCII Trend Chart** — visualize cache hit rate over time with `/cache-graph` (flat-rate handling + fixed chart labels)
- **Cost Savings Estimation** — savings priced from the official [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) table for the *active* model, with peak/off-peak time-of-day rates; `/cache-stats` shows both cumulative and per-request hit rates, the model, the current window, and the unit prices used
- **Cache-Friendly Compaction** — summarizes with `deepseek-flash` at temperature 0 (falls back to the legacy `deepseek-v4-flash` name), with SHA-256–cached results persisted across sessions (LRU capped at 64). Note: this is a standalone cold call, **not** a verbatim replay of the routed request — see [§7.4](./docs/prefix-cache-principle.md)
- **Atomic Persistence** — `tmp + rename` writes + debounced async flush + `session_start`/`session_shutdown` lifecycle guarantees, no torn JSON
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
2. Select a DeepSeek model such as `deepseek/deepseek-v4-flash`.
3. Start coding — the extension activates automatically and reports cache stats in the footer.

```bash
export DEEPSEEK_API_KEY=sk-...
pi --model deepseek/deepseek-v4-flash
```

## 🧩 Commands

| Command | Description |
|---------|-------------|
| `/cache-stats` | Overlay popup with hit rate, cached/missed tokens, turns, and estimated savings |
| `/cache-graph` | Overlay popup with ASCII trend chart of cache hit rate over time |
| `/cache-reset` | Reset all stats, history, and summary cache (clears both memory and disk) |

## 🔍 How it works

| Layer | What it does | Harness lineage |
|-------|-------------|-----------------|
| **P1 — Telemetry** | Accumulates `cacheRead` / `input` / `cacheWrite` / `turns` from `message_end` events plus the active `model`, persists atomically to `~/.pi/agent/extensions/deepseek-cache/stats.json`; prices savings per official table + peak/off-peak window | `TokenUsage` DISJOINT (`translate.ts:mapUsage`) — `input = prompt_tokens - cacheRead` |
| **P2 — Prefix Guard** | Filters `volatile-scratch` in `context`; sorts `tools` lexicographically in `before_provider_request`; fingerprints `system` + `tools` + `messages` with stable-JSON + inclusion check against a bounded set of known prefixes | `orderTools` / `sameSchema` / `canonicalHeader` / `headerEquals` (`packages/core/system-prompt`, `packages/core/session`) |
| **P3 — Compaction** | On `session_before_compact`, summarizes history as a single user message with `deepseek-flash` (legacy name fallback) at temperature 0. Summaries are SHA-256–cached (LRU 64) and atomically persisted | **No parity** — Harness `compaction-basic/summarizer.ts` replays `system+tools+shadowed messages` + trailing instruction to reuse a warm prefix; this path is a standalone cold call. Rationale in [§7.4](./docs/prefix-cache-principle.md) |

> 📖 Deep dive: [Prefix Cache Principle](./docs/prefix-cache-principle.md) — official [Context Caching on Disk](https://api-docs.deepseek.com/guides/kv_cache) (SWA-based independent cache prefix units, 3 persistence timings, best-effort) + Harness 5-layer enforcement + Pi mapping

## 🛠️ Troubleshooting

- **Cache hit rate is low** → usually a changing static prefix. Avoid injecting timestamps, random IDs, or volatile tool output near the start of the prompt. Note that adding or removing an extension changes the `tools` block, which invalidates the prefix just as a history rewrite does.
- **"Cache prefix change" warning** → something in the earlier conversation history, the tool set, or a tool's schema was modified. Check if a tool or extension is mutating past messages or registering/unregistering tools between turns.
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

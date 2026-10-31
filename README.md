<div align="center">

# 🚀 pi-deepseek-cache

**Squeeze the most out of DeepSeek's context caching inside the [Pi](https://pi.dev) coding agent.**

Stable prompt prefixes · higher cache-hit rates · live cache stats — so long sessions pay the _cache-hit_ rate on most of their input.

[![npm version](https://img.shields.io/npm/v/pi-deepseek-cache.svg)](https://www.npmjs.com/package/pi-deepseek-cache)
[![npm downloads](https://img.shields.io/npm/dm/pi-deepseek-cache.svg)](https://www.npmjs.com/package/pi-deepseek-cache)
[![license](https://img.shields.io/npm/l/pi-deepseek-cache.svg)](./LICENSE)

[English](./README.md) | [中文](./README.zh.md)

</div>

---

## ✨ Why this exists

DeepSeek's API has **Context Caching on Disk** built in: any request whose prompt **prefix** fully matches a previously persisted cache prefix unit is billed at the much cheaper _cache-hit_ rate. The catch — your prompt prefixes must stay **stable across turns**, token-for-token.

In long agent sessions that's surprisingly hard:

- the system prompt or tool list changes subtly between turns
- conversation history grows and shifts
- large / non-deterministic tool outputs break the prefix
- repeated metadata blocks aren't aligned

**`pi-deepseek-cache`** keeps your DeepSeek prompts cache-friendly and shows you exactly how well it's working — on the official API and on [any third-party deployment](#-third-party-deepseek-deployments) that serves DeepSeek behind an OpenAI-compatible endpoint.

## 🎯 Features

- **Prefix Guard** — strips `volatile-scratch` messages from the context to keep the prompt prefix stable across turns
- **Stable Tool Ordering** — lexicographically sorts `tools` in `before_provider_request` (Harness `orderTools` parity) so tool-list order jitter never breaks the cache
- **Cache Break Diagnostics** — fingerprints the full `system` + `tools` + `messages` prefix (stable-JSON + SHA-256) and warns only when an existing prefix is rewritten, not on normal append — including when the previous turn ended with a tail-injected transient block that never enters history (e.g. `@wbline/pi-plan-build`'s plan state); returning to any still-live earlier prefix counts as a valid hit; empty/unknown payloads are silently skipped
- **Hit Rate Telemetry** — accumulates `cacheRead` / `input` / `cacheWrite` / `turns` **per model** from every response and persists to disk, so switching models never blends two different price points into one number
- **Live Status Bar** — see the _current model's_ cumulative hit rate and turn count in the Pi footer after every message
- **ASCII Trend Chart** — visualize the all-models-cumulative hit rate over time with `/cache-graph` (flat-rate handling + fixed chart labels)
- **Cost Savings Estimation** — savings priced from the **active model's `cost` in the model catalog** (`models.json` / Pi's built-in catalog), which is the correct source for both official and third-party deployments. Only for the official `deepseek` provider does the official [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) table and its peak/off-peak windows still apply; a model the catalog prices at zero shows `—` instead of an invented number. `/cache-stats` shows cumulative and per-request hit rates, the model, **where the price came from**, the unit prices used, and a per-model breakdown
- **Cache-Friendly Compaction** — summarizes at temperature 0 with official `deepseek-flash` (legacy `deepseek-v4-flash` fallback) when that model exists, otherwise with the current model when it is already a `flash`-tier model, otherwise with a `flash`-tier model of the _current_ provider, otherwise the current model; results are SHA-256–cached and persisted across sessions (LRU capped at 64). Honors `/compact <instructions>` (`event.customInstructions`) and leaves the output cap to the model, matching Pi 1.4.0. Note: this is a standalone cold call, **not** a verbatim replay of the routed request — see [§7.4](./docs/prefix-cache-principle.md)
- **Cache Warming Bridge** — Pi's native cost-aware warming (`cacheWarming`, `cache_warming_decision`) never fires for DeepSeek because the built-in catalog declares no `promptCache` lifetime. `/cache-warm` reports eligibility for the current model and prints the exact `models.json` snippet that makes it eligible; the extension also **vetoes** a refresh when this model has produced no cache read over several turns (self-hosted replicas, router fan-out, caching off), where warming would only pay for a cache nothing reuses
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

Using a third-party DeepSeek deployment (OpenRouter, a self-hosted endpoint, a local router)? No DeepSeek API key or `deepseek` provider is required — see the next section.

## 🔌 Third-party DeepSeek deployments

Every hook is provider-agnostic: telemetry reads `usage.cacheRead` / `usage.input` from whatever the endpoint reports, and the prefix guard plus the break diagnostics operate on the outgoing wire payload. So a DeepSeek model served by a self-hosted vLLM/SGLang endpoint, a hosted router, or a local gateway works too — the extension does not care which `provider` id you put in front of it.

What differs from the official API:

| Layer                                            | On the official `deepseek` provider                    | On a third-party deployment                                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hit-rate telemetry                               | `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` | Works whenever the endpoint reports cached prompt tokens (e.g. `prompt_tokens_details.cached_tokens`). If it reports none, every turn looks like a miss            |
| Pricing                                          | Official price table + peak/off-peak halving           | The active model's `cost` from the model catalog, **flat** — peak/off-peak is DeepSeek's billing policy, not the host's. No catalog price → `—` instead of a guess |
| Prefix guard · tool ordering · break diagnostics | same                                                   | same — byte-stable prefixes help any prefix-cache implementation                                                                                                   |
| Compaction summarizer                            | `deepseek-flash` (legacy `deepseek-v4-flash` fallback) | Current model when it is already `flash`-tier, else a `flash`-tier model of the **current** provider (`deepseek` in the name preferred), else the current model    |

Two caveats specific to third-party hosts:

- **Instance affinity.** Self-hosted engines usually keep the prefix cache **per instance**, so a cache miss can mean "the router sent this turn to a different replica", not "the prefix was rewritten". The break diagnostics cannot tell those apart. If your router can pin a session to one backend (magpie does this through `compat.sendSessionAffinityHeaders`), keep that on.
- **Billing follows the host, not DeepSeek.** Hosts differ on how cached input is billed — flat discount, free, or not discounted at all. Savings are estimated from the catalog price you configured, so keep `cost.input` / `cost.cacheRead` in `models.json` accurate: for non-official providers that is the only pricing input the extension trusts.

```jsonc
// ~/.pi/agent/models.json — a third-party DeepSeek deployment
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

## 🧩 Commands

| Command        | Description                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| `/cache-stats` | Overlay popup with hit rate, cached/missed tokens, turns, estimated savings, pricing source, per-model breakdown |
| `/cache-graph` | Overlay popup with ASCII trend chart of the all-models-cumulative hit rate over time                             |
| `/cache-warm`  | Cache-warming status for the current model plus the `models.json` snippet that makes DeepSeek eligible           |
| `/cache-reset` | Reset all stats, history, and summary cache (clears both memory and disk)                                        |

## 🔍 How it works

| Layer                 | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Harness lineage                                                                                                                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1 — Telemetry**    | Accumulates `cacheRead` / `input` / `cacheWrite` / `turns` **per model** (provider + id) from `message_end` events, persists atomically to `~/.pi/agent/extensions/deepseek-cache/stats.json` (override the directory with `PI_DEEPSEEK_CACHE_DIR`); prices savings from the model catalog, or from the official table + peak/off-peak window when the provider is the official `deepseek`                                                                                                          | `TokenUsage` DISJOINT (`translate.ts:mapUsage`) — `input = prompt_tokens - cacheRead`                                                                                                                                                       |
| **P2 — Prefix Guard** | Filters `volatile-scratch` in `context`; sorts `tools` lexicographically in `before_provider_request`; fingerprints `system` + `tools` + `messages` with stable-JSON + inclusion check against a bounded set of known prefixes                                                                                                                                                                                                                                                                      | `orderTools` / `sameSchema` / `canonicalHeader` / `headerEquals` (`packages/core/system-prompt`, `packages/core/session`)                                                                                                                   |
| **P3 — Compaction**   | On `session_before_compact`, summarizes history as a single user message at temperature 0 with the official `deepseek-flash` model (legacy name fallback), else a `flash`-tier model of the current provider, else the current model. `/compact <instructions>` is forwarded as `Additional focus`, no `maxTokens` is sent (the model's output limit applies, as in Pi 1.4.0), and one-off summaries request `cacheRetention: none`. Summaries are SHA-256–cached (LRU 64) and atomically persisted | **No parity** — Harness `compaction-basic/summarizer.ts` replays `system+tools+shadowed messages` + trailing instruction to reuse a warm prefix; this path is a standalone cold call. Rationale in [§7.4](./docs/prefix-cache-principle.md) |
| **P4 — Warming**      | Leaves warming to Pi (`cacheWarming`, refresh = cache read + one output token, only when the model declares `promptCache`); overrides `cache_warming_decision` to `stop` when this model has no cache read across `turns >= 3`, i.e. the prefix cache is demonstrably not serving this deployment                                                                                                                                                                                                   | Pi `cache-warmer.ts` — cost-aware decision, extension may override `action` and failures fall back to Pi's own decision                                                                                                                     |

> 📖 Deep dive: [Prefix Cache Principle](./docs/prefix-cache-principle.md) — official [Context Caching on Disk](https://api-docs.deepseek.com/guides/kv_cache) (SWA-based independent cache prefix units, 3 persistence timings, best-effort) + Harness 5-layer enforcement + Pi mapping

## 🛠️ Troubleshooting

- **Cache hit rate is low** → usually a changing static prefix. Avoid injecting timestamps, random IDs, or volatile tool output near the start of the prompt. Note that adding or removing an extension changes the `tools` block, which invalidates the prefix just as a history rewrite does.
- **"Cache prefix change" warning** → something in the earlier conversation history, the tool set, or a tool's schema was modified. Check if a tool or extension is mutating past messages or registering/unregistering tools between turns. On a third-party host this can also mean the router moved you to another replica (see [instance affinity](#-third-party-deepseek-deployments)).
- **Footer shows nothing** → confirm a DeepSeek-serving model is selected and its provider has working credentials.
- **Hit rate stays at 0% on a third-party endpoint** → that endpoint reports no cached-token count in `usage`; the extension has nothing to measure. Check a raw response, not the extension.
- **Estimated savings shows `—`** → the model has no usable `cost.input` in the catalog (free / unpriced model). Add `cost` to the model entry in `models.json` to get a number.
- **`/cache-warm` says the TTL is not declared** → Pi cannot warm a model without a `promptCache` lifetime, and the built-in DeepSeek entries declare none. Copy the `models.json` snippet the command prints (`promptCache: { short: 3600 }` is the conservative end, since DeepSeek only says unused prefixes are cleared "after hours to days") and confirm with `/cache-stats` that hits actually accrue.

## 🧪 Test

```bash
npm test              # 90 tests (80 unit + 10 integration)
```

## 🤝 Contributing

Issues and PRs welcome! Please run `npm test` before submitting.

```bash
npm run lint          # ESLint + Prettier check
npm test              # Unit + integration tests
```

## 📄 License

[MIT](./LICENSE) © ruanbw

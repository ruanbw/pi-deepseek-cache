# pi-deepseek-cache

[English](./README.md) | [中文](./README.zh.md)

DeepSeek prefix cache extension for [pi](https://github.com/earendil-works/pi) — hit rate telemetry, prefix guard, cache-friendly compaction.

## Features

- **P1 Hit Rate Telemetry** — real-time cache hit rate with persistent storage
- **P2 Prefix Guard** — strips `volatile-scratch` messages to protect cache prefix stability
- **P3 Cache-Friendly Compaction** — deterministic summarization via `deepseek-v4-flash` (temperature: 0)
- **Overlay Commands** — `/cache-stats` and `/cache-graph` display in overlay popups (ESC to dismiss)

## Install

**npm (recommended)**

```bash
pi install npm:pi-deepseek-cache
```

**Git**

```bash
pi install git:github.com/ruanbw/pi-deepseek-cache
```

**Manual**

```bash
mkdir -p ~/.pi/agent/extensions/deepseek-cache
cp index.ts ~/.pi/agent/extensions/deepseek-cache/
```

## Usage

```bash
export DEEPSEEK_API_KEY=sk-...
pi --model deepseek/deepseek-chat
```

In the session:

```
/cache-stats   → overlay popup with hit rate, read/miss/write, turns
/cache-graph   → overlay popup with ASCII trend chart
```

## How It Works

| Layer | What it does |
|-------|-------------|
| **P1** | Accumulates `cacheRead` / `input` / `cacheWrite` / `turns` from `message_end` events, persists to `~/.pi/agent/extensions/deepseek-cache/stats.json` |
| **P2** | Filters out messages with `customType="volatile-scratch"` in the `context` hook, preventing volatile content from breaking the byte prefix |
| **P3** | On `session_before_compact`, summarizes history with `deepseek-v4-flash` at temperature 0, caches summaries by SHA-256 hash to ensure byte stability |

## Test

```bash
npm test              # 28 tests (18 unit + 10 integration)
```

## License

[MIT](./LICENSE)

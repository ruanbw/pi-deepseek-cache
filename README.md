# pi-deepseek-cache

> DeepSeek prefix cache extension for [pi](https://github.com/earendil-works/pi) — hit rate telemetry, prefix guard, cache-friendly compaction.
>
> DeepSeek 前缀缓存扩展，为 [pi](https://github.com/earendil-works/pi) 提供命中率遥测、前缀守卫、缓存友好的 compaction。

---

## English

### Features

- **P1 Hit Rate Telemetry** — real-time cache hit rate with persistent storage
- **P2 Prefix Guard** — strips `volatile-scratch` messages to protect cache prefix stability
- **P3 Cache-Friendly Compaction** — deterministic summarization via `deepseek-v4-flash` (temperature: 0)
- **Overlay Commands** — `/cache-stats` and `/cache-graph` display in overlay popups (ESC to dismiss)

### Install

```bash
# via pi install (recommended)
pi install git:github.com/ruanbw/pi-deepseek-cache

# or manually
mkdir -p ~/.pi/agent/extensions/deepseek-cache
cp index.ts ~/.pi/agent/extensions/deepseek-cache/
```

### Usage

```bash
export DEEPSEEK_API_KEY=sk-...
pi --model deepseek/deepseek-chat
```

In the session:

```
/cache-stats   → overlay popup with hit rate, read/miss/write, turns
/cache-graph   → overlay popup with ASCII trend chart
```

### How It Works

| Layer | What it does |
|-------|-------------|
| **P1** | Accumulates `cacheRead` / `input` / `cacheWrite` / `turns` from `message_end` events, persists to `~/.pi/agent/extensions/deepseek-cache/stats.json` |
| **P2** | Filters out messages with `customType="volatile-scratch"` in the `context` hook, preventing volatile content from breaking the byte prefix |
| **P3** | On `session_before_compact`, summarizes history with `deepseek-v4-flash` at temperature 0, caches summaries by SHA-256 hash to ensure byte stability |

### Test

```bash
npm test              # 28 tests (18 unit + 10 integration)
```

### License

MIT

---

## 中文

### 功能

- **P1 命中率遥测** — 实时显示缓存命中率，支持持久化存储
- **P2 前缀守卫** — 剥离 `volatile-scratch` 消息，保护缓存前缀稳定性
- **P3 缓存友好的 compaction** — 用 `deepseek-v4-flash` 做确定性摘要（temperature: 0）
- **Overlay 弹窗** — `/cache-stats` 和 `/cache-graph` 在弹窗中展示（ESC 关闭）

### 安装

```bash
# 通过 pi install 安装（推荐）
pi install git:github.com/ruanbw/pi-deepseek-cache

# 或手动安装
mkdir -p ~/.pi/agent/extensions/deepseek-cache
cp index.ts ~/.pi/agent/extensions/deepseek-cache/
```

### 使用

```bash
export DEEPSEEK_API_KEY=sk-...
pi --model deepseek/deepseek-chat
```

在会话中输入：

```
/cache-stats   → 弹窗显示命中率、read/miss/write、轮次
/cache-graph   → 弹窗显示 ASCII 趋势图
```

### 工作原理

| 层 | 说明 |
|----|------|
| **P1** | 在 `message_end` 事件中累计 `cacheRead` / `input` / `cacheWrite` / `turns`，持久化到 `~/.pi/agent/extensions/deepseek-cache/stats.json` |
| **P2** | 在 `context` 钩子中过滤 `customType="volatile-scratch"` 的消息，防止易变内容破坏字节前缀 |
| **P3** | 在 `session_before_compact` 时用 `deepseek-v4-flash`（temperature: 0）做摘要，按 SHA-256 hash 缓存，保证字节稳定 |

### 测试

```bash
npm test              # 28 个测试（18 单元 + 10 集成）
```

### 许可证

MIT

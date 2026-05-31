# pi-deepseek-cache

[English](./README.md) | [中文](./README.zh.md)

DeepSeek 前缀缓存扩展，为 [pi](https://github.com/earendil-works/pi) 提供命中率遥测、前缀守卫、缓存友好的 compaction。

## 功能

- **P1 命中率遥测** — 实时显示缓存命中率，支持持久化存储
- **P2 前缀守卫** — 剥离 `volatile-scratch` 消息，保护缓存前缀稳定性
- **P3 缓存友好的 compaction** — 用 `deepseek-v4-flash` 做确定性摘要（temperature: 0）
- **Overlay 弹窗** — `/cache-stats` 和 `/cache-graph` 在弹窗中展示（ESC 关闭）

## 安装

**npm（推荐）**

```bash
pi install npm:pi-deepseek-cache
```

**Git**

```bash
pi install git:github.com/ruanbw/pi-deepseek-cache
```

**手动**

```bash
mkdir -p ~/.pi/agent/extensions/deepseek-cache
cp index.ts ~/.pi/agent/extensions/deepseek-cache/
```

## 使用

```bash
export DEEPSEEK_API_KEY=sk-...
pi --model deepseek/deepseek-chat
```

在会话中输入：

```
/cache-stats   → 弹窗显示命中率、read/miss/write、轮次
/cache-graph   → 弹窗显示 ASCII 趋势图
```

## 工作原理

| 层 | 说明 |
|----|------|
| **P1** | 在 `message_end` 事件中累计 `cacheRead` / `input` / `cacheWrite` / `turns`，持久化到 `~/.pi/agent/extensions/deepseek-cache/stats.json` |
| **P2** | 在 `context` 钩子中过滤 `customType="volatile-scratch"` 的消息，防止易变内容破坏字节前缀 |
| **P3** | 在 `session_before_compact` 时用 `deepseek-v4-flash`（temperature: 0）做摘要，按 SHA-256 hash 缓存，保证字节稳定 |

## 测试

```bash
npm test              # 28 个测试（18 单元 + 10 集成）
```

## 许可证

[MIT](./LICENSE)

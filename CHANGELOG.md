# pi-deepseek-cache 变更日志

## v0.2.0 (2026-08-20): Harness 对齐的前缀缓存强制 + 原子持久化

> 本版本以官方 [Context Caching on Disk](https://api-docs.deepseek.com/guides/kv_cache) 与 DeepSeek Harness 五重强制为 Ground Truth，重构前缀缓存命中路径。新增 `docs/prefix-cache-principle.md`（507 行）沉淀官方三种落盘时机 / 两示例 / 计费字段 / best-effort 与 Harness 谱系。

### 新增

- **原理文档** `docs/prefix-cache-principle.md`：官方逐字摘录（request boundaries / common prefix detection / fixed token intervals）+ Harness 五重强制（`orderTools` / `canonicalHeader` / `deepFreeze` / `mapUsage` DISJOINT / verbatim compaction）+ Pi 三钩子映射，含全链路源码行号证据。

### 优化

- **稳定工具排序**：`before_provider_request` 中对 `payload.tools` 按 Harness `orderTools` 码点字典序重排（兼容 `name` / `function.name`），以 `{...payload, tools: sorted}` 非破坏性返回替换，链式场景可观测，工具顺序抖动不再击穿缓存。
- **前缀包含检测**：用 `stableStringify`（键排序递归）+ SHA-256 替代 `JSON.stringify` 的键序敏感哈希；存 `lastPrefixLen + lastPrefixHash`，以 `hash(prefix.slice(0, lastLen)) === lastHash` 判定追加 vs 改写，仅既有前缀被改写/中间插入才告警，空前缀与 `unknown` payload 静默跳过，根治每轮追加误报。
- **原子持久化**：引入 `ensureStatsDir` / `atomicWriteJson(tmp + renameSync)`，`scheduleSaveStats` / `scheduleSaveHistory` / `flushPendingWrites` / `saveSummaryCache` 全链路原子，去撕裂 JSON；`WRITE_DEBOUNCE_MS=1000` 合并高频 `message_end`。
- **生命周期收尾**：新增 `session_start`（初始化 `extensionCtx` 保障首次解析失败可通知）与 `session_shutdown`（`flushPendingWrites` 兜底），对齐 Harness 追加式 log 的退出不丢数语义。
- **摘要 LRU**：`MAX_SUMMARY_CACHE=64`，`setSummaryCache` 超限删最旧一条（Map 插入序），避免长会话无界膨胀。
- **图表健壮性**：补 `const chart: string[] = []` 缺失声明，`mid` 类型守卫改为 `typeof mid === "number"`，`cache-reset` 同步重置 `lastPrefixLen`。
- **上下文健壮性**：`context` 钩子加 `Array.isArray` 防御，返回过滤后 `{messages: onWire}` 保持顺序。

### 文档

- `README.md` / `README.zh.md` 增补“稳定工具排序 / 前缀包含检测 / 原子持久化 / LRU / 原理文档”特性与 P1/P2/P3 的 Harness 谱系列。

### 验证

- `npx tsc --noEmit --skipLibCheck`：剩余 4 处既有 SDK 形态不一致，未新增错误；`npx vitest run`：28 tests passed。

---


## 修复

### 2026-05-31: 添加持久化存储，解决 resume 时数据为 0 的问题

**问题**: 每次启动 pi 后，`/cache-stats` 命令显示的数据为 0，resume 会话后数据丢失。

**原因**: 扩展的统计数据存储在内存中，每次启动 pi 都会重置。

**解决方案**: 添加持久化存储功能，将统计数据保存到 `~/.pi/agent/extensions/deepseek-cache/stats.json`。

```typescript
// 新增功能
const STATS_DIR = join(homedir(), ".pi", "agent", "extensions", "deepseek-cache");
const STATS_FILE = join(STATS_DIR, "stats.json");

function loadStats(): Stats {
  // 从文件加载统计数据
}

function saveStats(stats: Stats) {
  // 保存统计数据到文件
}
```

**影响**:
- 数据在 pi 重启后保持不变
- resume 会话后数据不会丢失
- 所有会话共享同一份统计数据

### 2026-05-31: 修复 /cache-stats 命令在 print 模式下无输出

**问题**: 在 `--print` 模式下执行 `/cache-stats` 命令没有任何输出。

**原因**: pi 的 `--print` 模式使用 `noOpUIContext`，其中 `ctx.ui.notify` 是一个空函数，不会输出任何内容。

**解决方案**: 在命令处理器中同时调用 `ctx.ui.notify` 和 `console.log`，确保在两种模式下都能输出统计信息。

```typescript
// 修改前
handler: async (_args, ctx) => {
  ctx.ui.notify(stats, "info");
};

// 修改后
handler: async (_args, ctx) => {
  ctx.ui.notify(stats, "info");
  // 在 print 模式下,notify 是空函数,需要直接输出到 stdout
  console.log(stats);
};
```

**影响**:
- 在交互式模式下: `ctx.ui.notify` 正常工作
- 在 `--print` 模式下: `console.log` 输出到 stdout

**测试**:
- 添加了新的单元测试验证 `console.log` 被调用
- 所有 24 个测试全部通过

## 版本历史

### v0.1.0 (2026-05-31)

**初始版本**:
- P1 命中率遥测: 实时显示缓存命中率
- P2 前缀守卫: 剥离易变区消息,保护缓存前缀
- P3 缓存友好的 compaction: 用 v4-flash 做确定性摘要
- 完整的单元测试和集成测试

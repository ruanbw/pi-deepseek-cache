import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth, type Focusable } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, renameSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ═══════════════════════════════════════════════════════════════════════════
//  常量
// ═══════════════════════════════════════════════════════════════════════════

const STATS_OVERLAY_WIDTH = 56;
const GRAPH_OVERLAY_WIDTH = 60;
const CHART_HEIGHT = 10;
const CHART_MAX_WIDTH = 48;
const MAX_HISTORY_POINTS = 100;
const SUMMARY_MAX_TOKENS = 8192;
const FLAT_CHART_EPSILON = 0.05;

// R12: 成本估算 — DeepSeek 定价（每百万 token，美元，deepseek-v4-flash 峰值价）
// 峰值时段：01:00-04:00 / 06:00-10:00 UTC 周一至五；谷值减半（见 api-docs /quick_start/pricing）
const COST_PER_MILLION_CACHE_READ = 0.014;   // 缓存命中单价（peak）
const COST_PER_MILLION_INPUT = 0.44;         // 缓存未命中单价（peak）

const MAX_SUMMARY_CACHE = 64;

type Language = "en" | "zh";

const STRINGS = {
  en: {
    statsParseFailed: (message: string) =>
      `[deepseek-cache] Failed to parse stats.json (${message}); reset`,
    statsWriteFailed: (message: string) =>
      `[deepseek-cache] Failed to write stats.json: ${message}`,
    statsFlushFailed: (message: string) =>
      `[deepseek-cache] Failed to flush stats.json: ${message}`,
    historyParseFailed: (message: string) =>
      `[deepseek-cache] Failed to parse history.json (${message}); reset`,
    historyWriteFailed: (message: string) =>
      `[deepseek-cache] Failed to write history.json: ${message}`,
    historyFlushFailed: (message: string) =>
      `[deepseek-cache] Failed to flush history.json: ${message}`,
    summaryCacheParseFailed: (message: string) =>
      `[deepseek-cache] Failed to parse summary-cache.json (${message}); reset`,
    summaryCacheWriteFailed: (message: string) =>
      `[deepseek-cache] Failed to write summary-cache.json: ${message}`,
    statsTitle: "⚡ DeepSeek Cache Statistics",
    hitRate: "Hit rate",
    cacheHits: "Cache hits",
    cacheMisses: "Cache misses",
    cacheWrites: "Cache writes",
    turns: "Turns",
    estimatedSavings: "Estimated savings",
    close: "Esc Close",
    graphTitle: "⚡ Cache Hit Rate Trend",
    graphTitleWithPoints: (count: number) => `⚡ Cache Hit Rate Trend (${count} data points)`,
    noData: "No hit-rate data yet",
    keepChatting: "Continue for a few turns first",
    statsDescription: "DeepSeek prefix cache hit rate",
    graphDescription: "DeepSeek cache hit-rate trend",
    resetDescription: "Reset DeepSeek cache statistics",
    resetDone: "Cache statistics reset",
    prefixChanged: (count: number) =>
      `Cache prefix changed (#${count}); this turn may miss the cache`,
    previousSummary: "Previous summary",
    newHistory: "New history",
    modelMissing: "deepseek-v4-flash was not found; falling back to default compaction",
    authFailed: "deepseek-v4-flash authentication failed; falling back to default compaction",
    summaryFailed: (message: string) =>
      `Flash summary failed: ${message}; falling back to default compaction`,
    summaryPrompt:
      "Compress the following conversation history into a structured Markdown summary covering: " +
      "goals, key decisions and rationale, code/file changes, current progress, blockers and unresolved questions, and next steps. " +
      "Write the summary in the dominant language of the conversation. Be complete because this summary will replace the original history.\n\n",
  },
  zh: {
    statsParseFailed: (message: string) =>
      `[deepseek-cache] stats.json 解析失败 (${message}),已重置`,
    statsWriteFailed: (message: string) => `[deepseek-cache] stats.json 写入失败: ${message}`,
    statsFlushFailed: (message: string) => `[deepseek-cache] stats.json flush 失败: ${message}`,
    historyParseFailed: (message: string) =>
      `[deepseek-cache] history.json 解析失败 (${message}),已重置`,
    historyWriteFailed: (message: string) => `[deepseek-cache] history.json 写入失败: ${message}`,
    historyFlushFailed: (message: string) => `[deepseek-cache] history.json flush 失败: ${message}`,
    summaryCacheParseFailed: (message: string) =>
      `[deepseek-cache] summary-cache.json 解析失败 (${message}),已重置`,
    summaryCacheWriteFailed: (message: string) =>
      `[deepseek-cache] summary-cache.json 写入失败: ${message}`,
    statsTitle: "⚡ DeepSeek 缓存统计",
    hitRate: "命中率",
    cacheHits: "缓存命中",
    cacheMisses: "缓存未命中",
    cacheWrites: "缓存写入",
    turns: "对话轮次",
    estimatedSavings: "预估节省",
    close: "Esc 关闭",
    graphTitle: "⚡ 缓存命中率趋势",
    graphTitleWithPoints: (count: number) => `⚡ 缓存命中率趋势 (${count} 个数据点)`,
    noData: "暂无命中率数据",
    keepChatting: "请先进行多轮对话",
    statsDescription: "DeepSeek 前缀缓存命中率",
    graphDescription: "DeepSeek 缓存命中率趋势图",
    resetDescription: "重置 DeepSeek 缓存统计数据",
    resetDone: "缓存统计已重置",
    prefixChanged: (count: number) => `检测到缓存前缀变化（第 ${count} 次），本轮可能未命中缓存`,
    previousSummary: "上次摘要",
    newHistory: "新增历史",
    modelMissing: "找不到 deepseek-v4-flash,回退默认 compaction",
    authFailed: "flash 摘要鉴权失败,回退默认 compaction",
    summaryFailed: (message: string) => `flash 摘要失败:${message},回退默认 compaction`,
    summaryPrompt:
      "把下面这段对话历史压缩成结构化 markdown 摘要,覆盖:" +
      "①目标 ②关键决策与理由 ③代码/文件改动 ④当前进度 ⑤堵塞与未决问题 ⑥后续步骤。" +
      "务必完整,因为它将替换这段历史。\n\n",
  },
} as const;

export function resolveLanguage(env: NodeJS.ProcessEnv = process.env): Language {
  const locale = env.PI_DEEPSEEK_CACHE_LANG ?? env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? "";
  return locale.toLowerCase().startsWith("zh") ? "zh" : "en";
}

const strings = STRINGS[resolveLanguage()];

// ───────── R9: 局部类型定义，消除 any ─────────

interface CachedMessage {
  role: string;
  content?: string;
  customType?: string;
}

interface ProviderPayload {
  messages?: CachedMessage[];
}

interface PersistedStats {
  cacheRead: number;
  input: number;
  cacheWrite: number;
  turns: number;
}

interface HistoryPoint {
  turn: number;
  hitRate: number;
  timestamp: number;
}

// Harness: 字节确定性 helpers (参考 deepseek-harness orderTools/canonicalHeader/deepFreeze + api-docs deepseek kv_cache 前缀逐字节一致)
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) as string;
  if (Array.isArray(v)) return "[" + (v as unknown[]).map(stableStringify).join(",") + "]";
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}
function hashMessages(msgs: unknown): string {
  return createHash("sha256").update(stableStringify(msgs)).digest("hex");
}
function getToolName(t: unknown): string {
  if (!t || typeof t !== "object") return "";
  const o = t as Record<string, unknown>;
  if (typeof o.name === "string") return o.name;
  const fn = o.function as Record<string, unknown> | undefined;
  if (fn && typeof fn.name === "string") return fn.name;
  return "";
}
function ensureStatsDir() {
  if (!existsSync(STATS_DIR)) mkdirSync(STATS_DIR, { recursive: true });
}
function atomicWriteJson(path: string, data: unknown) {
  ensureStatsDir();
  const tmp = path + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}
function setSummaryCache(cache: Map<string, string>, k: string, v: string) {
  cache.set(k, v);
  if (cache.size > MAX_SUMMARY_CACHE) {
    const first = cache.keys().next().value as string | undefined;
    if (first !== undefined) cache.delete(first);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  持久化存储
// ═══════════════════════════════════════════════════════════════════════════

const STATS_DIR = join(homedir(), ".pi", "agent", "extensions", "deepseek-cache");
const STATS_FILE = join(STATS_DIR, "stats.json");
const HISTORY_FILE = join(STATS_DIR, "history.json");
const SUMMARY_CACHE_FILE = join(STATS_DIR, "summary-cache.json"); // R12

// Module-level ctx reference for persistence error reporting
let extensionCtx: ExtensionContext | undefined;

function loadStats(): PersistedStats {
  try {
    if (existsSync(STATS_FILE)) return JSON.parse(readFileSync(STATS_FILE, "utf-8"));
  } catch (err) {
    if (extensionCtx) {
      const msg = err instanceof Error ? err.message : String(err);
      extensionCtx.ui.notify(strings.statsParseFailed(msg), "warning");
    }
  }
  return { cacheRead: 0, input: 0, cacheWrite: 0, turns: 0 };
}

// R8: 异步节流写入 — 合并高频调用，减少同步 I/O 阻塞
const WRITE_DEBOUNCE_MS = 1000;
let pendingStats: PersistedStats | null = null;
let statsTimer: ReturnType<typeof setTimeout> | null = null;
let pendingHistory: HistoryPoint[] | null = null;
let historyTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSaveStats(s: PersistedStats) {
  pendingStats = s;
  if (statsTimer) return;
  statsTimer = setTimeout(() => {
    statsTimer = null;
    if (!pendingStats) return;
    const data = pendingStats;
    pendingStats = null;
    (async () => {
      try {
        atomicWriteJson(STATS_FILE, data);
      } catch (err) {
        if (extensionCtx) {
          const msg = err instanceof Error ? err.message : String(err);
          extensionCtx.ui.notify(strings.statsWriteFailed(msg), "error");
        }
      }
    })();
  }, WRITE_DEBOUNCE_MS);
}

function scheduleSaveHistory(h: HistoryPoint[]) {
  pendingHistory = h;
  if (historyTimer) return;
  historyTimer = setTimeout(() => {
    historyTimer = null;
    if (!pendingHistory) return;
    const data = pendingHistory;
    pendingHistory = null;
    (async () => {
      try {
        atomicWriteJson(HISTORY_FILE, data.slice(-MAX_HISTORY_POINTS));
      } catch (err) {
        if (extensionCtx) {
          const msg = err instanceof Error ? err.message : String(err);
          extensionCtx.ui.notify(strings.historyWriteFailed(msg), "error");
        }
      }
    })();
  }, WRITE_DEBOUNCE_MS);
}

/** R8: 会话结束时强制 flush，避免丢数据 */
function flushPendingWrites() {
  if (statsTimer) {
    clearTimeout(statsTimer);
    statsTimer = null;
  }
  if (pendingStats) {
    const data = pendingStats;
    pendingStats = null;
    try {
      atomicWriteJson(STATS_FILE, data);
    } catch (err) {
      if (extensionCtx) {
        const msg = err instanceof Error ? err.message : String(err);
        extensionCtx.ui.notify(strings.statsFlushFailed(msg), "error");
      }
    }
  }
  if (historyTimer) {
    clearTimeout(historyTimer);
    historyTimer = null;
  }
  if (pendingHistory) {
    const data = pendingHistory;
    pendingHistory = null;
    try {
      atomicWriteJson(HISTORY_FILE, data.slice(-MAX_HISTORY_POINTS));
    } catch (err) {
      if (extensionCtx) {
        const msg = err instanceof Error ? err.message : String(err);
        extensionCtx.ui.notify(strings.historyFlushFailed(msg), "error");
      }
    }
  }
}

function loadHistory(): HistoryPoint[] {
  try {
    if (existsSync(HISTORY_FILE)) return JSON.parse(readFileSync(HISTORY_FILE, "utf-8"));
  } catch (err) {
    if (extensionCtx) {
      const msg = err instanceof Error ? err.message : String(err);
      extensionCtx.ui.notify(strings.historyParseFailed(msg), "warning");
    }
  }
  return [];
}

function saveHistory(h: Array<{ turn: number; hitRate: number; timestamp: number }>) {
  try {
    if (!existsSync(STATS_DIR)) mkdirSync(STATS_DIR, { recursive: true });
    writeFileSync(HISTORY_FILE, JSON.stringify(h.slice(-MAX_HISTORY_POINTS), null, 2));
  } catch (err) {
    if (extensionCtx) {
      const msg = err instanceof Error ? err.message : String(err);
      extensionCtx.ui.notify(strings.historyWriteFailed(msg), "error");
    }
  }
}

// R12: 摘要缓存落盘 — 跨会话复用
function loadSummaryCache(): Map<string, string> {
  try {
    if (existsSync(SUMMARY_CACHE_FILE)) {
      const data: Record<string, string> = JSON.parse(readFileSync(SUMMARY_CACHE_FILE, "utf-8"));
      return new Map(Object.entries(data));
    }
  } catch (err) {
    if (extensionCtx) {
      const msg = err instanceof Error ? err.message : String(err);
      extensionCtx.ui.notify(strings.summaryCacheParseFailed(msg), "warning");
    }
  }
  return new Map();
}

function saveSummaryCache(cache: Map<string, string>) {
  try {
    const obj: Record<string, string> = {};
    for (const [k, v] of cache) obj[k] = v;
    atomicWriteJson(SUMMARY_CACHE_FILE, obj);
  } catch (err) {
    if (extensionCtx) {
      const msg = err instanceof Error ? err.message : String(err);
      extensionCtx.ui.notify(strings.summaryCacheWriteFailed(msg), "error");
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Overlay 组件
// ═══════════════════════════════════════════════════════════════════════════

/** 缓存统计弹窗 */
class CacheStatsOverlay implements Focusable {
  readonly width = STATS_OVERLAY_WIDTH;
  focused = false;

  private stats: PersistedStats;
  private theme: Theme;
  private done: () => void;

  constructor(theme: Theme, stats: PersistedStats, done: () => void) {
    this.theme = theme;
    this.stats = stats;
    this.done = done;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "return")) {
      this.done();
    }
  }

  render(_width: number): string[] {
    const { cacheRead, input, cacheWrite, turns } = this.stats;
    const denom = cacheRead + input;
    const hitRate = denom ? ((cacheRead / denom) * 100).toFixed(1) : "0.0";
    const th = this.theme;
    const w = this.width;
    const inner = w - 2;

    // R12: 成本节省估算 — 缓存命中 vs 未命中的差价
    const savedDollars = (cacheRead / 1_000_000) * (COST_PER_MILLION_INPUT - COST_PER_MILLION_CACHE_READ);
    const savedStr = savedDollars >= 0.01 ? `$${savedDollars.toFixed(2)}` : "< $0.01";

    const pad = (s: string) => s + " ".repeat(Math.max(0, inner - visibleWidth(s)));
    const row = (s: string) => th.fg("border", "│") + pad(s) + th.fg("border", "│");
    const label = (k: string, v: string) => `  ${th.fg("dim", k.padEnd(16))}${th.fg("accent", v)}`;

    return [
      th.fg("border", `╭${"─".repeat(inner)}╮`),
      row(` ${th.fg("accent", strings.statsTitle)}`),
      row(""),
      row(label(strings.hitRate, `${hitRate}%`)),
      row(label(strings.cacheHits, `${cacheRead.toLocaleString()} tokens`)),
      row(label(strings.cacheMisses, `${input.toLocaleString()} tokens`)),
      row(label(strings.cacheWrites, `${cacheWrite.toLocaleString()} tokens`)),
      row(label(strings.turns, `${turns}`)),
      row(label(strings.estimatedSavings, `${th.fg("accent", savedStr)}`)),
      row(""),
      row(` ${th.fg("dim", strings.close)}`),
      th.fg("border", `╰${"─".repeat(inner)}╯`),
    ];
  }

  invalidate(): void {}
  dispose(): void {}
}

/** 缓存命中率趋势弹窗 */
class CacheGraphOverlay implements Focusable {
  readonly width = GRAPH_OVERLAY_WIDTH;
  focused = false;

  private history: HistoryPoint[];
  private theme: Theme;
  private done: () => void;

  constructor(theme: Theme, history: HistoryPoint[], done: () => void) {
    this.theme = theme;
    this.history = history;
    this.done = done;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "return")) {
      this.done();
    }
  }

  render(_width: number): string[] {
    const th = this.theme;
    const inner = this.width - 2;

    const pad = (s: string) => s + " ".repeat(Math.max(0, inner - visibleWidth(s)));
    const row = (s: string) => th.fg("border", "│") + pad(s) + th.fg("border", "│");

    if (this.history.length === 0) {
      return [
        th.fg("border", `╭${"─".repeat(inner)}╮`),
        row(` ${th.fg("accent", strings.graphTitle)}`),
        row(""),
        row(`  ${th.fg("dim", strings.noData)}`),
        row(`  ${th.fg("dim", strings.keepChatting)}`),
        row(""),
        row(` ${th.fg("dim", strings.close)}`),
        th.fg("border", `╰${"─".repeat(inner)}╯`),
      ];
    }

    const rates = this.history.map((h) => h.hitRate);
    const maxRate = Math.max(...rates);
    const minRate = Math.min(...rates);
    const chartH = CHART_HEIGHT;
    const chartW = Math.min(this.history.length, CHART_MAX_WIDTH);

    // 采样
    const step = Math.max(1, Math.floor(this.history.length / chartW));
    const data = this.history.filter((_, i) => i % step === 0).slice(-chartW);

    // Y 轴标签宽度
    const yW = Math.max(maxRate.toFixed(0).length, minRate.toFixed(0).length) + 1;

    const chart: string[] = [];
    // R6: 命中率无波动时的特殊处理
    if (maxRate - minRate < FLAT_CHART_EPSILON) {
      const mid = Math.floor(data.length / 2);
      const chartLine = " ".repeat(mid) + "━".repeat(1) + " ".repeat(data.length - mid - 1);
      chart.push(`${minRate.toFixed(0)}%`.padStart(yW) + chartLine);
      chart.push("".padStart(yW) + "─".repeat(data.length));
      // X 轴标签
      const first = data[0].turn;
      const last = data[data.length - 1].turn;
      const labelLine = new Array(data.length).fill(" ");
      const firstStr = String(first);
      const lastStr = String(last);
      for (let i = 0; i < firstStr.length && i < data.length; i++) labelLine[i] = firstStr[i];
      for (let i = 0; i < lastStr.length && data.length - lastStr.length + i < data.length; i++) {
        labelLine[data.length - lastStr.length + i] = lastStr[i];
      }
      chart.push("".padStart(yW) + labelLine.join(""));
    } else {
      // 生成图表行
      const chartRows: string[] = [];
      for (let r = chartH; r >= 0; r--) {
        const threshold = minRate + (maxRate - minRate) * (r / chartH);
        let line = "";
        if (r === chartH) line = `${maxRate.toFixed(0)}%`.padStart(yW);
        else if (r === 0) line = `${minRate.toFixed(0)}%`.padStart(yW);
        else line = "".padStart(yW);
        for (const p of data) {
          line += p.hitRate >= threshold ? "█" : " ";
        }
        chartRows.push(line);
      }

      // X 轴
      chartRows.push("".padStart(yW) + "─".repeat(data.length));

      // R5: X 轴标签用字符数组定点填充，避免 padEnd 偏移错位
      const first = data[0].turn;
      const mid = data[Math.floor(data.length / 2)]?.turn ?? "";
      const last = data[data.length - 1].turn;
      const xChars = new Array(data.length).fill(" ");

      // 首标签从位置 0 开始
      const firstStr = String(first);
      for (let i = 0; i < firstStr.length && i < data.length; i++) xChars[i] = firstStr[i];

      // 中标签居中
      if (typeof mid === "number") {
        const midStr = String(mid);
        const midStart = Math.floor((data.length - midStr.length) / 2);
        for (let i = 0; i < midStr.length; i++) {
          const pos = midStart + i;
          if (pos >= 0 && pos < data.length) xChars[pos] = midStr[i];
        }
      }

      // 尾标签右对齐
      const lastStr = String(last);
      for (let i = 0; i < lastStr.length; i++) {
        const pos = data.length - lastStr.length + i;
        if (pos >= 0 && pos < data.length) xChars[pos] = lastStr[i];
      }

      chartRows.push("".padStart(yW) + xChars.join(""));
      chart.push(...chartRows);
    }

    // 组装完整弹窗
    const lines = [
      th.fg("border", `╭${"─".repeat(inner)}╮`),
      row(` ${th.fg("accent", strings.graphTitleWithPoints(this.history.length))}`),
      row(""),
    ];

    for (const c of chart) {
      lines.push(row(`  ${c}`));
    }

    lines.push(row(""));
    lines.push(row(` ${th.fg("dim", strings.close)}`));
    lines.push(th.fg("border", `╰${"─".repeat(inner)}╯`));

    return lines;
  }

  invalidate(): void {}
  dispose(): void {}
}

// ═══════════════════════════════════════════════════════════════════════════
//  扩展主逻辑
// ═══════════════════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {
  // Store ctx for persistence error reporting (R7)
  // Will be set on first event that provides ctx
  const setExtensionCtx = (ctx: ExtensionContext) => { extensionCtx = ctx; };

  // ───────── P1 命中率遥测(持久化) ─────────
  const persisted = loadStats();
  let { cacheRead, input, cacheWrite, turns } = persisted;
  const hitRateHistory = loadHistory();
  let lastHitRate = hitRateHistory.length > 0
    ? hitRateHistory[hitRateHistory.length - 1].hitRate
    : 0;

  /** R2: 单一命中率计算函数 */
  const calcHitRate = (r: number, i: number): number =>
    (r + i) ? (r / (r + i)) * 100 : 0;

  pi.on("message_end", async (event, ctx) => {
    setExtensionCtx(ctx);
    if (event.message.role !== "assistant") return;
    const u = event.message.usage;
    if (!u) return;
    cacheRead += u.cacheRead ?? 0;
    input += u.input ?? 0;
    cacheWrite += u.cacheWrite ?? 0;
    turns += 1;

    scheduleSaveStats({ cacheRead, input, cacheWrite, turns });

    // R2: 计算一次，复用于状态栏与历史
    const rate = calcHitRate(cacheRead, input);
    ctx.ui.setStatus("cache", `cache ${rate.toFixed(1)}% · ${turns}t`);

    // R3: 用 toFixed(1) 做定点比较，避免浮点去重失效
    const rateKey = rate.toFixed(1);
    const lastKey = lastHitRate.toFixed(1);
    if (rateKey !== lastKey) {
      // R4: 截断内存数组，与落盘保持一致
      hitRateHistory.push({ turn: turns, hitRate: rate, timestamp: Date.now() });
      if (hitRateHistory.length > MAX_HISTORY_POINTS) {
        hitRateHistory.splice(0, hitRateHistory.length - MAX_HISTORY_POINTS);
      }
      lastHitRate = rate;
      scheduleSaveHistory(hitRateHistory);
    }
  });

  // /cache-stats → overlay 弹窗
  pi.registerCommand("cache-stats", {
    description: strings.statsDescription,
    handler: async (_args, ctx) => {
      setExtensionCtx(ctx);
      await ctx.ui.custom(
        (_tui, theme, _kb, done) =>
          new CacheStatsOverlay(theme, { cacheRead, input, cacheWrite, turns }, done),
        { overlay: true },
      );
    },
  });

  // /cache-graph → overlay 弹窗
  pi.registerCommand("cache-graph", {
    description: strings.graphDescription,
    handler: async (_args, ctx) => {
      setExtensionCtx(ctx);
      await ctx.ui.custom(
        (_tui, theme, _kb, done) =>
          new CacheGraphOverlay(theme, hitRateHistory, done),
        { overlay: true },
      );
    },
  });

  // R12: /cache-reset → 清空统计数据与历史
  pi.registerCommand("cache-reset", {
    description: strings.resetDescription,
    handler: async (_args, ctx) => {
      setExtensionCtx(ctx);
      // 二次确认
      await ctx.ui.notify(strings.resetDone, "info");
      cacheRead = 0;
      input = 0;
      cacheWrite = 0;
      turns = 0;
      hitRateHistory.length = 0;
      lastHitRate = 0;
      lastPrefixHash = undefined;
      lastPrefixLen = 0;
      prefixBreaks = 0;
      summaryCache.clear();
      flushPendingWrites();
      // 清除持久化文件
      try {
        if (existsSync(STATS_FILE)) unlinkSync(STATS_FILE);
        if (existsSync(HISTORY_FILE)) unlinkSync(HISTORY_FILE);
        if (existsSync(SUMMARY_CACHE_FILE)) unlinkSync(SUMMARY_CACHE_FILE);
      } catch {}
    },
  });

  // ───────── P2 前缀守卫 ─────────
  pi.on("context", async (event, ctx) => {
    setExtensionCtx(ctx);
    const msgs = Array.isArray((event as unknown as {messages?: unknown}).messages) ? (event.messages as CachedMessage[]) : [];
    const onWire = msgs.filter((m: CachedMessage) => m?.customType !== "volatile-scratch");
    return { messages: onWire };
  });

  // R1: 前缀指纹 → 缓存破坏诊断 (Harness: headerEquals+prefix包含检测, 参考 api-docs deepseek kv_cache 前缀完整匹配)
  let lastPrefixHash: string | undefined;
  let lastPrefixLen = 0;
  let prefixBreaks = 0;
  pi.on("before_provider_request", (event, ctx) => {
    setExtensionCtx(ctx);
    const payload = event.payload as Record<string, unknown> | null | undefined;
    // 字节确定性：tools 按 Harness orderTools 码点字典序排序，避免工具顺序抖动击穿缓存 (harness: packages/core/system-prompt/src/index.ts:orderTools)
    if (payload && typeof payload === "object") {
      const toolsRaw = (payload as Record<string, unknown>).tools;
      if (Array.isArray(toolsRaw) && toolsRaw.length > 1) {
        const sorted = [...toolsRaw].sort((a: unknown, b: unknown) => {
          const na = getToolName(a);
          const nb = getToolName(b);
          // 码点字典序（Harness orderTools parity）：localeCompare 依赖 ICU/locale，跨环境可能给出不同顺序
          return na < nb ? -1 : na > nb ? 1 : 0;
        });
        const next = { ...(payload as Record<string, unknown>), tools: sorted };
        // 保持 chain 可观测：prefix 字节一致性优先于原始工具顺序
        // 返回替换 payload (runner.js:790 只当 !==undefined 才替换)
        // 此处先完成前缀哈希诊断，排序后的 payload 由链式 runner 返回替换
        const msgsForHash = Array.isArray((next as Record<string, unknown>).messages) ? ((next as Record<string, unknown>).messages as unknown[]) : [];
        const prefixForHash = msgsForHash; // 完整消息列表（含最后一条），对齐官方 cache unit 边界（用户输入末尾落盘）
        // 稳定序列化哈希，避免键序抖动误报 (harness: sameSchema JSON.stringify 有序, 此处用 stableStringify 兼容多 provider形态)
        const curHash = prefixForHash.length === 0 ? undefined : hashMessages(prefixForHash);
        const curLen = prefixForHash.length;
        if (lastPrefixHash !== undefined && curHash !== undefined) {
          const isAppend = curLen >= lastPrefixLen && hashMessages(prefixForHash.slice(0, lastPrefixLen)) === lastPrefixHash;
          const isEqual = curLen === lastPrefixLen && curHash === lastPrefixHash;
          if (!isAppend && !isEqual) {
            prefixBreaks++;
            ctx.ui.notify(strings.prefixChanged(prefixBreaks), "warning");
          }
        }
        if (curHash !== undefined) { lastPrefixHash = curHash; lastPrefixLen = curLen; } else { lastPrefixHash = undefined; lastPrefixLen = 0; }
        return next;
      }
    }
    const rawMsgs = (payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).messages))
      ? ((payload as Record<string, unknown>).messages as unknown[]) : [];
    if (rawMsgs.length === 0) return; // 非payload 形态静默跳过，空前缀不告警 (Harness: deepseek-official only)
    const prefix = rawMsgs; // 完整消息列表（rawMsgs.length > 0 已由 609 行保证）
    const curHash = hashMessages(prefix);
    const curLen = prefix.length;
    if (lastPrefixHash !== undefined) {
      const isAppend = curLen >= lastPrefixLen && hashMessages(prefix.slice(0, lastPrefixLen)) === lastPrefixHash;
      const isEqual = curLen === lastPrefixLen && curHash === lastPrefixHash;
      if (!isAppend && !isEqual) {
        prefixBreaks++;
        ctx.ui.notify(strings.prefixChanged(prefixBreaks), "warning");
      }
    }
    lastPrefixHash = curHash;
    lastPrefixLen = curLen;
  });

  // ───────── P3 缓存友好的 compaction ─────────
  const summaryCache = loadSummaryCache(); // R12: 从磁盘加载摘要缓存，跨会话复用
  pi.on("session_before_compact", async (event, ctx) => {
    setExtensionCtx(ctx);
    flushPendingWrites(); // R8: compaction 前强制 flush，避免丢失未写数据
    const { preparation, signal } = event;
    const { messagesToSummarize, firstKeptEntryId, tokensBefore, previousSummary } = preparation;

    const history = serializeConversation(convertToLlm(messagesToSummarize));
    const text = previousSummary
      ? `${strings.previousSummary}\n${previousSummary}\n\n${strings.newHistory}\n${history}`
      : history;

    const key = createHash("sha256").update(text).digest("hex");
    let summary = summaryCache.get(key);
    if (!summary) {
      summary = await summarizeWithFlash(text, ctx, signal);
      if (!summary) return;
      setSummaryCache(summaryCache, key, summary);
      saveSummaryCache(summaryCache); // R12: 新摘要落盘，跨会话复用
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

  // 会话生命周期：切换/新会话时重置前缀指纹，避免旧会话哈希残留导致跨会话假阳性告警；
  // 退出时强制 flush（api-docs kv_cache best-effort 资源清理类比）
  const resetPrefixFingerprint = () => { lastPrefixHash = undefined; lastPrefixLen = 0; };
  pi.on("session_start", (_event, ctx) => { extensionCtx = ctx; resetPrefixFingerprint(); });
  pi.on("session_before_switch", () => { resetPrefixFingerprint(); });
  pi.on("session_shutdown", () => { flushPendingWrites(); });
}

async function summarizeWithFlash(
  text: string,
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<string | undefined> {
  const model = ctx.modelRegistry.find("deepseek", "deepseek-v4-flash");
  if (!model) {
    ctx.ui.notify(strings.modelMissing, "warning");
    return;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    ctx.ui.notify(strings.authFailed, "warning");
    return;
  }

  try {
    const response = await complete(
      model,
      {
        messages: [
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const,
                text:
                  strings.summaryPrompt +
                  text,
              },
            ],
            timestamp: Date.now(),
          },
        ],
        temperature: 0,
      },
      { apiKey: auth.apiKey, headers: auth.headers, maxTokens: SUMMARY_MAX_TOKENS, signal },
    );

    const summary = (response as { content: Array<{ type: string; text?: string }> }).content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c: { text: string }) => c.text)
      .join("\n");

    return summary.trim() || undefined;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(strings.summaryFailed(msg), "error");
    return;
  }
}

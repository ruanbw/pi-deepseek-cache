import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth, type Focusable } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
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

// R12: 成本估算 — DeepSeek 定价（每百万 token，美元）
const COST_PER_MILLION_CACHE_READ = 0.027;   // 缓存命中单价
const COST_PER_MILLION_INPUT = 0.27;          // 缓存未命中单价

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
      extensionCtx.ui.notify(`[deepseek-cache] stats.json 解析失败 (${msg}),已重置`, "warning");
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
        if (!existsSync(STATS_DIR)) mkdirSync(STATS_DIR, { recursive: true });
        await writeFile(STATS_FILE, JSON.stringify(data, null, 2));
      } catch (err) {
        if (extensionCtx) {
          const msg = err instanceof Error ? err.message : String(err);
          extensionCtx.ui.notify(`[deepseek-cache] stats.json 写入失败: ${msg}`, "error");
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
        if (!existsSync(STATS_DIR)) mkdirSync(STATS_DIR, { recursive: true });
        await writeFile(HISTORY_FILE, JSON.stringify(data.slice(-MAX_HISTORY_POINTS), null, 2));
      } catch (err) {
        if (extensionCtx) {
          const msg = err instanceof Error ? err.message : String(err);
          extensionCtx.ui.notify(`[deepseek-cache] history.json 写入失败: ${msg}`, "error");
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
      if (!existsSync(STATS_DIR)) mkdirSync(STATS_DIR, { recursive: true });
      writeFileSync(STATS_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      if (extensionCtx) {
        const msg = err instanceof Error ? err.message : String(err);
        extensionCtx.ui.notify(`[deepseek-cache] stats.json flush 失败: ${msg}`, "error");
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
      if (!existsSync(STATS_DIR)) mkdirSync(STATS_DIR, { recursive: true });
      writeFileSync(HISTORY_FILE, JSON.stringify(data.slice(-MAX_HISTORY_POINTS), null, 2));
    } catch (err) {
      if (extensionCtx) {
        const msg = err instanceof Error ? err.message : String(err);
        extensionCtx.ui.notify(`[deepseek-cache] history.json flush 失败: ${msg}`, "error");
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
      extensionCtx.ui.notify(`[deepseek-cache] history.json 解析失败 (${msg}),已重置`, "warning");
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
      extensionCtx.ui.notify(`[deepseek-cache] history.json 写入失败: ${msg}`, "error");
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
      extensionCtx.ui.notify(`[deepseek-cache] summary-cache.json 解析失败 (${msg}),已重置`, "warning");
    }
  }
  return new Map();
}

function saveSummaryCache(cache: Map<string, string>) {
  try {
    if (!existsSync(STATS_DIR)) mkdirSync(STATS_DIR, { recursive: true });
    const obj: Record<string, string> = {};
    for (const [k, v] of cache) obj[k] = v;
    writeFileSync(SUMMARY_CACHE_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    if (extensionCtx) {
      const msg = err instanceof Error ? err.message : String(err);
      extensionCtx.ui.notify(`[deepseek-cache] summary-cache.json 写入失败: ${msg}`, "error");
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
      row(` ${th.fg("accent", "⚡ DeepSeek 缓存统计")}`),
      row(""),
      row(label("命中率", `${hitRate}%`)),
      row(label("缓存命中", `${cacheRead.toLocaleString()} tokens`)),
      row(label("缓存未命中", `${input.toLocaleString()} tokens`)),
      row(label("缓存写入", `${cacheWrite.toLocaleString()} tokens`)),
      row(label("对话轮次", `${turns}`)),
      row(label("预估节省", `${th.fg("accent", savedStr)}`)),
      row(""),
      row(` ${th.fg("dim", "Esc 关闭")}`),
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
        row(` ${th.fg("accent", "⚡ 缓存命中率趋势")}`),
        row(""),
        row(`  ${th.fg("dim", "暂无命中率数据")}`),
        row(`  ${th.fg("dim", "请先进行多轮对话")}`),
        row(""),
        row(` ${th.fg("dim", "Esc 关闭")}`),
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
      if (mid !== "") {
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
      row(` ${th.fg("accent", `⚡ 缓存命中率趋势 (${this.history.length} 个数据点)`)}`),
      row(""),
    ];

    for (const c of chart) {
      lines.push(row(`  ${c}`));
    }

    lines.push(row(""));
    lines.push(row(` ${th.fg("dim", "Esc 关闭")}`));
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
    description: "DeepSeek 前缀缓存命中率",
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
    description: "DeepSeek 缓存命中率趋势图",
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
    description: "重置 DeepSeek 缓存统计数据",
    handler: async (_args, ctx) => {
      setExtensionCtx(ctx);
      // 二次确认
      await ctx.ui.notify("缓存统计已重置", "info");
      cacheRead = 0;
      input = 0;
      cacheWrite = 0;
      turns = 0;
      hitRateHistory.length = 0;
      lastHitRate = 0;
      lastPrefixHash = undefined;
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
    const onWire = event.messages.filter((m: CachedMessage) => m?.customType !== "volatile-scratch");
    return { messages: onWire };
  });

  // R1: 前缀指纹 → 缓存破坏诊断
  let lastPrefixHash: string | undefined;
  let prefixBreaks = 0;
  pi.on("before_provider_request", (event, ctx) => {
    setExtensionCtx(ctx);
    const msgs = (event.payload as ProviderPayload).messages ?? [];
    const currentPrefixHash = createHash("sha256")
      .update(JSON.stringify(msgs.slice(0, -1))).digest("hex");

    // 检测前缀变化：若上一轮有哈希且当前哈希不是其延续（即既有前缀被修改而非追加）
    if (lastPrefixHash !== undefined && currentPrefixHash !== lastPrefixHash) {
      prefixBreaks++;
      ctx.ui.notify(
        `检测到缓存前缀变化（第 ${prefixBreaks} 次），本轮可能未命中缓存`,
        "warning",
      );
    }
    lastPrefixHash = currentPrefixHash;
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
      ? `【上次摘要】\n${previousSummary}\n\n【新增历史】\n${history}`
      : history;

    const key = createHash("sha256").update(text).digest("hex");
    let summary = summaryCache.get(key);
    if (!summary) {
      summary = await summarizeWithFlash(text, ctx, signal);
      if (!summary) return;
      summaryCache.set(key, summary);
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
}

async function summarizeWithFlash(
  text: string,
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<string | undefined> {
  const model = ctx.modelRegistry.find("deepseek", "deepseek-v4-flash");
  if (!model) {
    ctx.ui.notify("找不到 deepseek-v4-flash,回退默认 compaction", "warning");
    return;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    ctx.ui.notify("flash 摘要鉴权失败,回退默认 compaction", "warning");
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
                  "把下面这段对话历史压缩成结构化 markdown 摘要,覆盖:" +
                  "①目标 ②关键决策与理由 ③代码/文件改动 ④当前进度 ⑤堵塞与未决问题 ⑥后续步骤。" +
                  "务必完整,因为它将替换这段历史。\n\n" +
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

    const summary = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    return summary.trim() || undefined;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`flash 摘要失败:${msg},回退默认 compaction`, "error");
    return;
  }
}

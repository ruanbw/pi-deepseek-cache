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

const STATS_OVERLAY_WIDTH = 62;
const GRAPH_OVERLAY_WIDTH = 60;
const CHART_HEIGHT = 10;
const CHART_MAX_WIDTH = 48;
const MAX_HISTORY_POINTS = 100;
const SUMMARY_MAX_TOKENS = 8192;
const FLAT_CHART_EPSILON = 0.05;

// ───────── R13: 定价（官方 Models & Pricing，每百万 token，美元）─────────
// Ground Truth: https://api-docs.deepseek.com/quick_start/pricing
// 峰值时段为 01:00-04:00 与 06:00-10:00 UTC、周一至五（官方注(2) 另排除中国公共假期），
// 其余时段（含周末与全部节假日）为谷值，官方定义谷值 = 峰值 / 2。
interface PriceTier {
  /** 缓存命中输入单价 */
  hit: number;
  /** 缓存未命中输入单价 */
  miss: number;
}
const FLASH_TIER: PriceTier = { hit: 0.006, miss: 0.3 };
const DEEPSEEK_PRICING: Record<string, PriceTier> = {
  // 官方当前名，模型版本 DeepSeek-V4.1-Flash。
  "deepseek-flash": FLASH_TIER,
  // 官方注(1)：legacy 名 deepseek-v4-flash 仍受理，但模型已退役，请求由
  // DeepSeek-V4.1-Flash 服务并按 Flash 价计费。
  "deepseek-v4-flash": FLASH_TIER,
  // v4-pro 暂时同价。官方公告：“Starting at 04:00 UTC on Sept 14, 2026, all
  // deepseek-v4-pro requests will route to V4.1-Flash at V4.1-Flash rates.
  // This will continue until V4.1-Pro launches.”
  // https://www.deepseek.com/en/news/deepseek-v4-1-flash/
  // 注意：/quick_start/pricing 仍展示 v4-pro 的历史价列（0.044 / 1.32），与该公告冲突。
  // 本扩展统计的是实际结算价，故按公告口径取 Flash 价；V4.1-Pro 上线后需在此处单独加价。
  "deepseek-v4-pro": FLASH_TIER,
  // 官方已于 2026-07-24 停用 deepseek-chat / deepseek-reasoner（它们只是 v4-flash
  // 的思考/非思考模式别名，从未是独立模型）；保留映射仅为旧会话或自建代理兜底。
  "deepseek-chat": FLASH_TIER,
  "deepseek-reasoner": FLASH_TIER,
};
/** 未知模型时的保守下界（flash 谷值），避免高估节省额 */
const DEFAULT_PRICING: PriceTier = { hit: 0.003, miss: 0.15 };
const PEAK_HOURS_UTC: ReadonlyArray<readonly [number, number]> = [
  [1, 4],
  [6, 10],
];

/** 官方注(2)：01:00-04:00 / 06:00-10:00 UTC，周一至五 */
function isPeakWindow(now: Date): boolean {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = now.getUTCHours();
  return PEAK_HOURS_UTC.some(([start, end]) => hour >= start && hour < end);
}

function lookupPricing(model: string | undefined): PriceTier | undefined {
  if (!model) return undefined;
  const direct = DEEPSEEK_PRICING[model];
  if (direct) return direct;
  for (const [id, tier] of Object.entries(DEEPSEEK_PRICING)) {
    // 容忍 wire model 带版本/日期后缀（如 deepseek-v4-flash-0813）
    if (model.startsWith(id) || model.includes(id)) return tier;
  }
  return undefined;
}

/** 当前生效单价：按模型取价，再按 peak/off-peak 折半 */
function currentPricing(model: string | undefined, now: Date): PriceTier {
  const tier = lookupPricing(model) ?? DEFAULT_PRICING;
  return isPeakWindow(now) ? tier : { hit: tier.hit / 2, miss: tier.miss / 2 };
}

const MAX_SUMMARY_CACHE = 64;
/** 摘要器模型候选名：官方当前名 + legacy 名，任一命中即可 */
const SUMMARIZER_CANDIDATES = ["deepseek-flash", "deepseek-v4-flash"];

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

/** /cache-stats 渲染所需的完整视图（统计 + 单轮 + 计价上下文） */
interface StatsView {
  stats: PersistedStats;
  /** 最近一轮的命中率；尚无 assistant 消息时为 undefined */
  lastTurnHitRate: number | undefined;
  /** 当前生效的 wire model，用于选价并显示 */
  model: string | undefined;
  pricing: PriceTier;
  peak: boolean;
  /** 官方 usage 只有 hit/miss，不提供 cache write；仅在确实观测到非零写入时才展示该行 */
  reportsCacheWrite: boolean;
}

/**
 * 前缀指纹。官方要求 system + tools + messages 整体完整匹配某个已落盘的
 * cache prefix unit。pi-ai 把 system 并入 messages（openai-completions buildParams），
 * 但 tools 是独立顶层字段，因此必须单独纳入指纹，否则工具增删/改 schema 会静默击穿缓存。
 */
interface PrefixFingerprint {
  tools: string;
  messages: string;
  len: number;
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
        atomicWriteJson(STATS_FILE, data);
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
        atomicWriteJson(HISTORY_FILE, data.slice(-MAX_HISTORY_POINTS));
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
      atomicWriteJson(STATS_FILE, data);
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
      atomicWriteJson(HISTORY_FILE, data.slice(-MAX_HISTORY_POINTS));
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
    const obj: Record<string, string> = {};
    for (const [k, v] of cache) obj[k] = v;
    atomicWriteJson(SUMMARY_CACHE_FILE, obj);
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

  private view: StatsView;
  private theme: Theme;
  private done: () => void;

  constructor(theme: Theme, view: StatsView, done: () => void) {
    this.theme = theme;
    this.view = view;
    this.done = done;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "return")) {
      this.done();
    }
  }

  render(_width: number): string[] {
    const { stats, lastTurnHitRate, model, pricing, peak, reportsCacheWrite } = this.view;
    const { cacheRead, input, cacheWrite, turns } = stats;
    const th = this.theme;
    const w = this.width;
    const inner = w - 2;

    // 官方口径 prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens；
    // pi-ai 的 usage.input 已是不相交的 miss 部分，故 hit/(hit+miss) 即命中率。
    // 此处为跨轮累计值（官方按请求逐次统计），另单独展示本轮值。
    const cumulative = cacheRead + input ? (cacheRead / (cacheRead + input)) * 100 : 0;
    // 节省额 = 命中部分相对全量 miss 的边际差价，按当前模型 + 当前时段计价
    // flash 档单价低（谷值 hit $0.003 / miss $0.15），每百万命中仅省 $0.147，
    // 固定 2 位小数会丢失有效信息，故小额用 4 位、大额用 2 位
    const savedDollars = (cacheRead / 1_000_000) * (pricing.miss - pricing.hit);
    const savedStr = savedDollars >= 0.01
      ? `$${savedDollars.toFixed(savedDollars < 1 ? 4 : 2)}`
      : "< $0.01";

    const pad = (s: string) => s + " ".repeat(Math.max(0, inner - visibleWidth(s)));
    const row = (s: string) => th.fg("border", "│") + pad(s) + th.fg("border", "│");
    // 按显示宽度而非码元数补齐，避免 CJK 标签错位
    const label = (k: string, v: string) => {
      const key = k + " ".repeat(Math.max(0, 14 - visibleWidth(k)));
      return `  ${th.fg("dim", key)}${th.fg("accent", v)}`;
    };

    const lines = [
      th.fg("border", `╭${"─".repeat(inner)}╮`),
      row(` ${th.fg("accent", "⚡ DeepSeek 缓存统计")}`),
      row(""),
      row(label("累计命中率", `${cumulative.toFixed(1)}%`)),
      row(label("本轮命中率", lastTurnHitRate === undefined ? "—" : `${lastTurnHitRate.toFixed(1)}%`)),
      row(label("缓存命中", `${cacheRead.toLocaleString()} tokens`)),
      row(label("缓存未命中", `${input.toLocaleString()} tokens`)),
    ];
    // 官方 usage 仅提供 hit/miss，无 cache write 字段；未观测到写入时隐藏该行
    if (reportsCacheWrite) lines.push(row(label("缓存写入", `${cacheWrite.toLocaleString()} tokens`)));
    lines.push(
      row(label("对话轮次", `${turns}`)),
      row(label("预估节省", savedStr)),
      row(""),
      row(` ${th.fg("dim", `计价 ${model ?? "未知模型"} · ${peak ? "峰值" : "谷值"}时段`)}`),
      row(` ${th.fg("dim", `hit $${pricing.hit} / miss $${pricing.miss} per 1M`)}`),
      row(""),
      row(` ${th.fg("dim", "Esc 关闭")}`),
      th.fg("border", `╰${"─".repeat(inner)}╯`),
    );
    return lines;
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
  /** 最近一轮的 hit/miss，用于展示按请求口径的命中率（官方逐次统计口径） */
  let lastTurn: { read: number; miss: number } | undefined;
  /** 当前 wire model，用于按官方价目表选价 */
  let activeModel: string | undefined;
  /** 官方 usage 无 cache write 字段；仅当观测到非零写入才展示该行 */
  let reportsCacheWrite = false;
  /** 缓存前缀被改写的累计次数 */
  let prefixBreaks = 0;
  /**
   * 已知的可命中前缀集合。官方：cache prefix unit 独立完整、可并存，且未使用的条目
   * 数小时至数日内才会清理（"best-effort"）。因此判定“本轮是否破坏了前缀”不能只看
   * 上一轮——早期前缀回归时依然是有效命中。
   */
  const knownPrefixes: PrefixFingerprint[] = [];
  const MAX_KNOWN_PREFIXES = 8;

  /** R2: 单一命中率计算函数 */
  const calcHitRate = (r: number, i: number): number =>
    (r + i) ? (r / (r + i)) * 100 : 0;

  pi.on("message_end", async (event, ctx) => {
    setExtensionCtx(ctx);
    if (event.message.role !== "assistant") return;
    const u = event.message.usage;
    if (!u) return;
    const read = u.cacheRead ?? 0;
    const miss = u.input ?? 0;
    const write = u.cacheWrite ?? 0;
    if (write > 0) reportsCacheWrite = true;
    const m = event.message.model;
    if (typeof m === "string" && m) activeModel = m;
    lastTurn = { read, miss };
    cacheRead += read;
    input += miss;
    cacheWrite += write;
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
  const buildStatsView = (): StatsView => {
    const now = new Date();
    return {
      stats: { cacheRead, input, cacheWrite, turns },
      lastTurnHitRate: lastTurn ? calcHitRate(lastTurn.read, lastTurn.miss) : undefined,
      model: activeModel,
      pricing: currentPricing(activeModel, now),
      peak: isPeakWindow(now),
      reportsCacheWrite,
    };
  };

  pi.registerCommand("cache-stats", {
    description: "DeepSeek 前缀缓存命中率",
    handler: async (_args, ctx) => {
      setExtensionCtx(ctx);
      await ctx.ui.custom(
        (_tui, theme, _kb, done) =>
          new CacheStatsOverlay(theme, buildStatsView(), done),
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
      lastTurn = undefined;
      activeModel = undefined;
      reportsCacheWrite = false;
      knownPrefixes.length = 0;
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

  // R14: 前缀指纹 → 缓存破坏诊断
  // 官方要求前缀完整匹配某个已落盘的 cache prefix unit；system + tools + messages 三段
  // 均参与。pi-ai 的 openai-completions buildParams 把 system 并入 messages，但 tools 是
  // 独立顶层字段 —— 旧实现只哈希 messages，导致工具增删/改 schema 击穿缓存时零告警。
  pi.on("before_provider_request", (event, ctx) => {
    setExtensionCtx(ctx);
    const payload = event.payload as Record<string, unknown> | null | undefined;
    if (!payload || typeof payload !== "object") return;

    // 字节确定性：tools 按 Harness orderTools 码点字典序排序，避免工具顺序抖动击穿缓存
    const toolsRaw = payload.tools;
    let next: Record<string, unknown> = payload;
    let reordered = false;
    if (Array.isArray(toolsRaw) && toolsRaw.length > 1) {
      // 码点字典序（Harness orderTools parity）：localeCompare 依赖 ICU/locale，跨环境可能给出不同顺序
      const sorted = [...toolsRaw].sort((a: unknown, b: unknown) => {
        const na = getToolName(a);
        const nb = getToolName(b);
        return na < nb ? -1 : na > nb ? 1 : 0;
      });
      reordered = sorted.some((t, i) => t !== toolsRaw[i]);
      if (reordered) next = { ...payload, tools: sorted };
    }

    // 完整消息列表（含最后一条），对齐官方 cache unit 边界（用户输入末尾落盘）
    const msgs = Array.isArray(next.messages) ? (next.messages as unknown[]) : [];
    if (msgs.length === 0) return; // 非 payload 形态 / 空前缀：静默跳过，不告警

    const fp: PrefixFingerprint = {
      tools: hashMessages(Array.isArray(next.tools) ? next.tools : null),
      messages: hashMessages(msgs),
      len: msgs.length,
    };

    if (knownPrefixes.length > 0) {
      // 追加式 = 本轮消息列表以某个已知前缀开头，且 tools 未变
      const isContinuation = knownPrefixes.some(
        (prev) =>
          prev.tools === fp.tools &&
          fp.len >= prev.len &&
          hashMessages(msgs.slice(0, prev.len)) === prev.messages,
      );
      if (!isContinuation) {
        prefixBreaks++;
        ctx.ui.notify(`检测到缓存前缀变化（第 ${prefixBreaks} 次），本轮可能未命中缓存`, "warning");
      }
    }

    // 去重后入队，保持有界（最新在最前）
    const at = knownPrefixes.findIndex((p) => p.tools === fp.tools && p.messages === fp.messages);
    if (at >= 0) knownPrefixes.splice(at, 1);
    knownPrefixes.unshift(fp);
    if (knownPrefixes.length > MAX_KNOWN_PREFIXES) knownPrefixes.length = MAX_KNOWN_PREFIXES;

    // 返回替换 payload（runner 仅在 !==undefined 时替换）
    return reordered ? next : undefined;
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
    let summarizer = "deepseek-flash";
    if (!summary) {
      const fresh = await summarizeWithFlash(text, ctx, signal);
      if (!fresh) return;
      summary = fresh.summary;
      summarizer = fresh.model;
      setSummaryCache(summaryCache, key, summary);
      saveSummaryCache(summaryCache); // R12: 新摘要落盘，跨会话复用
    }

    return {
      compaction: {
        summary,
        firstKeptEntryId,
        tokensBefore,
        details: { summarizer },
      },
    };
  });

  // 会话生命周期：切换/新会话时重置前缀指纹，避免旧会话哈希残留导致跨会话假阳性告警；
  // 退出时强制 flush（api-docs kv_cache best-effort 资源清理类比）
  const resetPrefixFingerprint = () => { knownPrefixes.length = 0; };
  pi.on("session_start", (_event, ctx) => { extensionCtx = ctx; resetPrefixFingerprint(); });
  pi.on("session_before_switch", () => { resetPrefixFingerprint(); });
  pi.on("session_shutdown", () => { flushPendingWrites(); });
}

async function summarizeWithFlash(
  text: string,
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<{ summary: string; model: string } | undefined> {
  // 官方注(1)：`deepseek-flash` 为当前模型名，legacy 名 `deepseek-v4-flash` 仍受理但
  // 模型已退役。两个名字都试，任一命中即可，避免 pi 模型目录跟进官方改名后静默失效。
  let model;
  for (const id of SUMMARIZER_CANDIDATES) {
    model = ctx.modelRegistry.find("deepseek", id);
    if (model) break;
  }
  if (!model) {
    ctx.ui.notify(`找不到摘要模型（${SUMMARIZER_CANDIDATES.join(" / ")}）,回退默认 compaction`, "warning");
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

    const summary = (response as { content: Array<{ type: string; text?: string }> }).content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c: { text: string }) => c.text)
      .join("\n");

    return summary.trim() ? { summary: summary.trim(), model: model.id } : undefined;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`flash 摘要失败:${msg},回退默认 compaction`, "error");
    return;
  }
}

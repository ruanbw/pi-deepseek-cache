import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth, type Focusable } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  renameSync,
} from "node:fs";
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
const FLAT_CHART_EPSILON = 0.05;
/**
 * 续命否决门槛：连续这么多轮都没有任何 cache read，说明这个模型/部署的前缀缓存
 * 根本没在服务我们（自建实例按副本缓存、router 轮询到别的后端、缓存被关）。
 * 此时 pi 的续命只会按 cache-read 单价付费而不可能回本。
 */
const WARM_MIN_TURNS = 3;

// ───────── R13: 定价（官方 Models & Pricing，每百万 token，美元）─────────
// Ground Truth: https://api-docs.deepseek.com/quick_start/pricing
// 峰值时段为 01:00-04:00 与 06:00-10:00 UTC、周一至五，并排除中国公共假期（见 CN_PUBLIC_HOLIDAYS），
// 其余时段（含周末与全部节假日）为谷值，官方定义谷值 = 峰值 / 2。
interface PriceTier {
  /** 缓存命中输入单价 */
  hit: number;
  /** 缓存未命中输入单价 */
  miss: number;
}
const FLASH_TIER: PriceTier = { hit: 0.006, miss: 0.3 };
const PRO_TIER: PriceTier = { hit: 0.044, miss: 1.32 };
const DEEPSEEK_PRICING: Record<string, PriceTier> = {
  // 官方当前名，模型版本 DeepSeek-V4.1-Flash。
  "deepseek-flash": FLASH_TIER,
  // 官方注(1)：legacy 名 deepseek-v4-flash / deepseek-v4-flash-vision-exp 仍受理，
  // 但对应模型已退役，请求由 DeepSeek-V4.1-Flash 服务并按 Flash 价计费。
  "deepseek-v4-flash": FLASH_TIER,
  // 注：legacy 名 deepseek-v4-flash-vision-exp 无需单列——lookupPricing 的
  // startsWith 回退已把它归入 deepseek-v4-flash。
  // 官方 2026-09-10 变更日志：“In response to user demand, we have decided to
  // continue providing API services for DeepSeek V4 Pro after September 14, 2026,
  // with the billing method remaining unchanged.”
  // https://api-docs.deepseek.com/updates
  // 即 v4-pro 并未路由到 V4.1-Flash，仍按自身价目表结算（模型版本 DeepSeek-V4-Pro-0813）：
  // 命中 0.044 / 未命中 1.32（峰值）。
  // v0.3.0 曾按已作废的"路由至 Flash 并按 Flash 价计费"公告取 Flash 价，会把 v4-pro
  // 用户的节省额少算约 7 倍；已改回官方价目表。pi 自己的模型目录
  // （@earendil-works/pi-ai providers/data/deepseek.json）也仍是
  // cacheRead 0.044 / input 1.32，与此一致。
  "deepseek-v4-pro": PRO_TIER,
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

/**
 * 官方注(2) 的峰值窗口为 01:00-04:00 / 06:00-10:00 UTC 的**周一至周五**，且
 * **排除中国公共假期**（周末与中国公共假期全时段均为谷值）。
 *
 * 假期按中国标准时间（UTC+8）的自然日判定。数据取自国务院办公厅《关于2026年
 * 部分节假日安排的通知》（国办发明电〔2025〕7号）：
 * https://www.gov.cn/zhengce/content/202511/content_7047090.htm
 * 已收录年份：2026。未收录的年份不匹配任何区间，即退化为“不排除假期”（等价于
 * 旧行为，只会保守地高估而非低估峰值），因此漏更新不会产生静默错误。
 * 国办每年发布次年安排后需在此追加区间。
 */
const CN_PUBLIC_HOLIDAYS: ReadonlyArray<readonly [string, string]> = [
  ["2026-01-01", "2026-01-03"], // 元旦
  ["2026-02-15", "2026-02-23"], // 春节
  ["2026-04-04", "2026-04-06"], // 清明节
  ["2026-05-01", "2026-05-05"], // 劳动节
  ["2026-06-19", "2026-06-21"], // 端午节
  ["2026-09-25", "2026-09-27"], // 中秋节
  ["2026-10-01", "2026-10-07"], // 国庆节
];

/** 该时刻对应的中国标准时间自然日是否为中国公共假期 */
function isCstPublicHoliday(now: Date): boolean {
  const cstDate = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return CN_PUBLIC_HOLIDAYS.some(([start, end]) => cstDate >= start && cstDate <= end);
}

/** 官方注(2)：01:00-04:00 / 06:00-10:00 UTC，周一至五，排除中国公共假期 */
function isPeakWindow(now: Date): boolean {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  // 工作日用 UTC、假期用 UTC+8 自然日，两者口径混用在当前窗口（最早 01:00 UTC
  // = 09:00 CST）下不会出现“UTC 是工作日但 CST 已跨到次日”的偏差；若官方将来
  // 把窗口前移到 16:00 UTC 之后，需改为两者都按 CST 判定。
  if (isCstPublicHoliday(now)) return false;
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

/**
 * 官方 provider id（pi `KnownProvider` 之一）。peak/off-peak 是**官方计费策略**，
 * 只对官方端点成立：第三方部署（OpenRouter / 自建 vLLM / 各类 router）即使服务的是
 * 同一个 DeepSeek 模型，也按自己的 flat 价目表结算，折半会把节省额算错一半。
 */
const OFFICIAL_DEEPSEEK_PROVIDER = "deepseek";

/** 单价来源：UI 用它说清「这个数字从哪来」 */
type PricingSource = "catalog" | "official-table" | "default" | "unpriced";

interface PricingResolution {
  /** 用于估算节省额的单价；source === "unpriced" 时为零价占位 */
  tier: PriceTier;
  source: PricingSource;
  /** 单价随调用时刻在峰/谷之间折半（仅官方 provider） */
  peakApplies: boolean;
  /** 仅当 peakApplies 时有意义 */
  peak: boolean;
  /** false = 模型目录明确给了零价（免费 / 未标价），此时不估算节省额，避免编造数字 */
  available: boolean;
}

/** 模型目录里的 cost → 单价；缺输入价（免费模型 / 未标价）返回 undefined */
function costToTier(
  cost: { input?: number; cacheRead?: number } | undefined,
): PriceTier | undefined {
  if (!cost) return undefined;
  const miss = cost.input ?? 0;
  if (!(miss > 0)) return undefined;
  return { hit: Math.max(0, cost.cacheRead ?? 0), miss };
}

/**
 * 计价解析顺序（v0.5 起）：
 * 1. **模型目录的 cost**（`models.json` / pi 内置目录）—— 第三方部署的唯一真源；
 * 2. 官方价目表（按模型 id，含 legacy 名与已停用名）—— 官方用户与自建代理的兜底；
 * 3. 目录有该模型但零价 → unpriced：不估算，避免把免费模型算出一笔「节省」；
 * 4. 目录完全没有该模型 → 官方 flash 谷值作保守下界（沿用 v0.4 行为，宁少不多）。
 *
 * 峰谷折半只在官方 provider 上生效；其余一律按目录里的 flat 价。
 */
function resolvePricing(
  ref: ModelRef | undefined,
  cost: { input?: number; cacheRead?: number } | undefined,
  now: Date,
): PricingResolution {
  const official = ref?.provider === OFFICIAL_DEEPSEEK_PROVIDER;
  const catalogTier = costToTier(cost);
  const tableTier = lookupPricing(ref?.id);

  let tier: PriceTier;
  let source: PricingSource;
  if (catalogTier) {
    tier = catalogTier;
    source = "catalog";
  } else if (tableTier) {
    tier = tableTier;
    source = "official-table";
  } else if (cost) {
    tier = { hit: 0, miss: 0 };
    source = "unpriced";
  } else {
    tier = DEFAULT_PRICING;
    source = "default";
  }

  const peak = official && isPeakWindow(now);
  if (official && !peak) tier = { hit: tier.hit / 2, miss: tier.miss / 2 };
  return { tier, source, peakApplies: official, peak, available: source !== "unpriced" };
}

/** 把计价来源渲染成一段人类可读的标签（含峰谷时段判定） */
function pricingSourceLabel(p: PricingResolution): string {
  switch (p.source) {
    case "catalog":
      return strings.pricingSourceCatalog;
    case "official-table":
      return p.peakApplies
        ? `${strings.pricingSourceTable} · ${p.peak ? strings.peak : strings.offPeak}`
        : strings.pricingSourceTable;
    case "unpriced":
      return strings.pricingSourceUnpriced;
    default:
      return strings.pricingSourceDefault;
  }
}

const MAX_SUMMARY_CACHE = 64;
/** 摘要器模型候选名：官方当前名 + legacy 名，任一命中即可 */
const SUMMARIZER_CANDIDATES = ["deepseek-flash", "deepseek-v4-flash"];

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
    hitRate: "Cumulative hit rate",
    cacheHits: "Cache hits",
    cacheMisses: "Cache misses",
    cacheWrites: "Cache writes",
    turns: "Turns",
    estimatedSavings: "Estimated savings",
    savingsUnavailable: "— (no input price)",
    lastTurnHitRate: "Last turn hit rate",
    unknownModel: "unknown model",
    allModels: "All models",
    byModelHeading: (count: number) => `By model (${count})`,
    moreModels: (count: number) => `… ${count} more model(s)`,
    peak: "peak hours",
    offPeak: "off-peak hours",
    pricingSourceCatalog: "model catalog rate",
    pricingSourceTable: "official price table",
    pricingSourceDefault: "conservative floor (no price data)",
    pricingSourceUnpriced: "no price in model catalog",
    pricingLine: (model: string, source: string) => `Pricing ${model} · ${source}`,
    close: "Esc Close",
    graphTitle: "⚡ Cache Hit Rate Trend (all models)",
    graphTitleWithPoints: (count: number) =>
      `⚡ Cache Hit Rate Trend · all models (${count} data points)`,
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
    modelMissing: (candidates: string) =>
      `No summarizer model available (tried ${candidates}, then the current provider's flash model, then the current model); falling back to default compaction`,
    authFailed: (model: string, error: string) =>
      `Summarizer auth failed for ${model} (${error}); falling back to default compaction`,
    summaryFailed: (message: string) =>
      `Summary failed (${message}); falling back to default compaction`,
    summaryUnknownError: "unknown error",
    summaryTruncated: "hit the token cap, so the summary is incomplete",
    summaryPrompt:
      "Compress the following conversation history into a structured Markdown summary covering: " +
      "goals, key decisions and rationale, code/file changes, current progress, blockers and unresolved questions, and next steps. " +
      "Write the summary in the dominant language of the conversation. Be complete because this summary will replace the original history.\n\n",
    // 与 pi 1.4.0 内置压缩同措辞（compaction.js: `Additional focus: ${customInstructions}`），
    // 这样 `/compact <instructions>` 在自定义压缩路径下语义一致。
    summaryFocus: "Additional focus",
    warmDescription: "Cache warming (pi native) status for the current model",
    warmTitle: "⚡ Cache warming (pi native)",
    warmModel: (label: string) => `Model: ${label}`,
    warmTtlDeclared: (seconds: number) => `promptCache TTL: ${seconds}s (pi may warm this model)`,
    warmTtlMissing: "promptCache TTL: not declared → pi never warms this model",
    warmTelemetry: (rate: string, turns: number) => `Cache hits: ${rate}% over ${turns} turn(s)`,
    warmNoTelemetry: "Cache hits: no data for this model yet",
    warmVetoOn:
      "Extension veto: ON — no cache read in the last few turns, so warming would pay for a cache nothing reuses",
    warmVetoOff: "Extension veto: off — warming is left to pi's own cost model",
    warmEnable: "Enable it in ~/.pi/agent/models.json:",
    warmHint:
      "DeepSeek clears unused prefixes after hours to days and documents no exact TTL, so a 1h lifetime is the conservative end. Re-run /cache-stats after enabling to confirm hits actually accrue.",
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
    hitRate: "累计命中率",
    cacheHits: "缓存命中",
    cacheMisses: "缓存未命中",
    cacheWrites: "缓存写入",
    turns: "对话轮次",
    estimatedSavings: "预估节省",
    savingsUnavailable: "—（无输入单价）",
    lastTurnHitRate: "本轮命中率",
    unknownModel: "未知模型",
    allModels: "全部模型累计",
    byModelHeading: (count: number) => `按模型（${count}）`,
    moreModels: (count: number) => `… 还有 ${count} 个模型`,
    peak: "峰值时段",
    offPeak: "谷值时段",
    pricingSourceCatalog: "模型目录价",
    pricingSourceTable: "官方价目表",
    pricingSourceDefault: "保守下界（无价目数据）",
    pricingSourceUnpriced: "模型目录未标价",
    pricingLine: (model: string, source: string) => `计价 ${model} · ${source}`,
    close: "Esc 关闭",
    graphTitle: "⚡ 缓存命中率趋势（全部模型）",
    graphTitleWithPoints: (count: number) => `⚡ 缓存命中率趋势 · 全部模型 (${count} 个数据点)`,
    noData: "暂无命中率数据",
    keepChatting: "请先进行多轮对话",
    statsDescription: "DeepSeek 前缀缓存命中率",
    graphDescription: "DeepSeek 缓存命中率趋势图",
    resetDescription: "重置 DeepSeek 缓存统计数据",
    resetDone: "缓存统计已重置",
    prefixChanged: (count: number) => `检测到缓存前缀变化（第 ${count} 次），本轮可能未命中缓存`,
    previousSummary: "上次摘要",
    newHistory: "新增历史",
    modelMissing: (candidates: string) =>
      `找不到摘要模型（依次尝试 ${candidates} / 当前 provider 的 flash 档 / 当前模型）；回退默认 compaction`,
    authFailed: (model: string, error: string) =>
      `摘要模型 ${model} 鉴权失败（${error}）；回退默认 compaction`,
    summaryFailed: (message: string) => `摘要失败（${message}）；回退默认 compaction`,
    summaryUnknownError: "未知错误",
    summaryTruncated: "生成触达 token 上限，摘要不完整",
    summaryPrompt:
      "把下面这段对话历史压缩成结构化 markdown 摘要,覆盖:" +
      "①目标 ②关键决策与理由 ③代码/文件改动 ④当前进度 ⑤堵塞与未决问题 ⑥后续步骤。" +
      "用对话的主要语言书写摘要。" +
      "务必完整,因为它将替换这段历史。\n\n",
    summaryFocus: "额外关注点",
    warmDescription: "显示当前模型的 pi 原生缓存续命状态",
    warmTitle: "⚡ 缓存续命（pi 原生）",
    warmModel: (label: string) => `当前模型 ${label}`,
    warmTtlDeclared: (seconds: number) => `promptCache 生命期 ${seconds}s（pi 可对该模型续命）`,
    warmTtlMissing: "promptCache 生命期 未声明 → pi 不会对该模型续命",
    warmTelemetry: (rate: string, turns: number) => `本模型命中 ${rate}%（${turns} 轮）`,
    warmNoTelemetry: "本模型暂无命中数据",
    warmVetoOn: "扩展否决 开启 — 最近数轮无任何 cache read，续命只在为不会被复用的缓存付费",
    warmVetoOff: "扩展否决 关闭 — 续命交给 pi 自己的成本模型",
    warmEnable: "在 ~/.pi/agent/models.json 中启用：",
    warmHint:
      "DeepSeek 未公布精确 TTL（官方只说“长时间不用的缓存会自动清空”，社区实测为数小时至数日），故 1h 取保守端。启用后请用 /cache-stats 确认命中真的在增长。",
  },
} as const;

export function resolveLanguage(env: NodeJS.ProcessEnv = process.env): Language {
  const locale = env.PI_DEEPSEEK_CACHE_LANG ?? env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? "";
  return locale.toLowerCase().startsWith("zh") ? "zh" : "en";
}

const strings = STRINGS[resolveLanguage()];

// ───────── R9: 局部类型定义，消除 any ─────────

/** 归一化后的模型引用：provider + 目录 id（两者都可能缺失，例如 v0.4 的旧数据） */
interface ModelRef {
  provider?: string;
  id?: string;
}

/** 计数四元组（视图与全局累计用） */
interface ModelStats {
  cacheRead: number;
  input: number;
  cacheWrite: number;
  turns: number;
}

/**
 * 单模型累计桶。v0.5 起统计按模型分桶：多模型（或同一会话中途切模型 / 走 router 的
 * 多后端）共用一个扁平累计时，命中率与节省额会互相污染，而两者单价可能差几十倍。
 */
interface ModelBucket extends ModelStats {
  /** 分桶键：`provider/id`；缺 provider 或 id 时退化为可用的一半或 UNKNOWN_MODEL_KEY */
  key: string;
  provider?: string;
  id?: string;
  /** 该模型是否上报过非零 cache write（官方 usage 无此字段，故按模型分别判定） */
  cacheWriteReported?: boolean;
}

/** stats.json 的当前形态（v2）。v1 的扁平累计在读取时归入 unknown 桶，不丢数据。 */
interface PersistedStats {
  version: 2;
  byModel: ModelBucket[];
}

/** summary-cache.json 的值：记下产出该摘要的模型，便于 `details.summarizer` 说真话 */
interface SummaryCacheEntry {
  summary: string;
  model: string;
}

interface HistoryPoint {
  turn: number;
  hitRate: number;
  timestamp: number;
}

/** /cache-stats 渲染所需的完整视图（当前模型 + 全部模型累计 + 计价上下文） */
interface StatsView {
  /** 当前模型桶（尚未观测到任何消息时为零值） */
  stats: ModelStats;
  /** 当前模型的 provider/id，用于计价 */
  ref: ModelRef | undefined;
  /** 当前模型展示名（provider/id） */
  modelLabel: string;
  /** 全部模型累计 */
  totals: ModelStats;
  totalsHitRate: number;
  /** 全部模型桶，按 token 量降序 */
  byModel: ModelBucket[];
  /** 最近一轮的命中率；尚无 assistant 消息时为 undefined */
  lastTurnHitRate: number | undefined;
  pricing: PricingResolution;
  /** 当前模型桶是否上报过非零 cache write */
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
  /**
   * 去掉末条消息后的哈希。末条可能是本轮才注入、并不落历史的临时块
   * （例如 plan-build 每轮在消息数组尾部追加的计划状态块），下一轮该位置
   * 会被真实历史取代 —— 用严格全量比对会把这种正常追加误判成断链。
   */
  head: string;
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

/** R2: 单一命中率计算函数 */
function calcHitRate(read: number, miss: number): number {
  return read + miss ? (read / (read + miss)) * 100 : 0;
}

/** 按显示宽度截断标签（CJK 占 2 列），超出时以 … 收尾 */
function fitLabel(text: string, budget: number): string {
  if (budget <= 0) return "";
  if (visibleWidth(text) <= budget) return text;
  let out = "";
  // 预留 1 列给省略号
  for (const ch of text) {
    if (visibleWidth(out + ch) > budget - 1) break;
    out += ch;
  }
  return out + "…";
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
function setSummaryCache(cache: Map<string, SummaryCacheEntry>, k: string, v: SummaryCacheEntry) {
  cache.set(k, v);
  if (cache.size > MAX_SUMMARY_CACHE) {
    const first = cache.keys().next().value as string | undefined;
    if (first !== undefined) cache.delete(first);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  持久化存储
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 数据目录。默认 `~/.pi/agent/extensions/deepseek-cache`；
 * `PI_DEEPSEEK_CACHE_DIR` 可覆盖它 —— 测试与临时隔离环境靠这个避免写/删用户的真实统计。
 */
const STATS_DIR =
  process.env.PI_DEEPSEEK_CACHE_DIR ||
  join(homedir(), ".pi", "agent", "extensions", "deepseek-cache");
const STATS_FILE = join(STATS_DIR, "stats.json");
const HISTORY_FILE = join(STATS_DIR, "history.json");
const SUMMARY_CACHE_FILE = join(STATS_DIR, "summary-cache.json"); // R12

/** v0.4 及更早的扁平累计（无模型维度）被归入该桶 */
const UNKNOWN_MODEL_KEY = "unknown";
/** /cache-stats 最多渲染几个模型行（弹窗不滚动，必须守住高度） */
const MAX_BUCKET_ROWS = 3;

// Module-level ctx reference for persistence error reporting
let extensionCtx: ExtensionContext | undefined;

/** 读盘数值归一化：非有限正数一律按 0 处理 */
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * 分桶键 `provider/id`。模型 id 自身可能含 `/`（如 `open-design/deepseek-v4.1-flash`），
 * 因此键不能被反向拆开——provider 与 id 另行存字段。
 */
function bucketKey(provider: string | undefined, id: string | undefined): string {
  if (provider && id) return `${provider}/${id}`;
  return id ?? provider ?? UNKNOWN_MODEL_KEY;
}

/** 展示名 `provider/id`（与 pi 的 `--model provider/id` 保持一致） */
function modelLabelOf(provider: string | undefined, id: string | undefined): string {
  if (provider && id) return `${provider}/${id}`;
  return id ?? provider ?? strings.unknownModel;
}

function emptyBucket(provider: string | undefined, id: string | undefined): ModelBucket {
  return {
    key: bucketKey(provider, id),
    provider,
    id,
    cacheRead: 0,
    input: 0,
    cacheWrite: 0,
    turns: 0,
  };
}

function sumStats(buckets: Iterable<ModelBucket>): ModelStats {
  const total: ModelStats = { cacheRead: 0, input: 0, cacheWrite: 0, turns: 0 };
  for (const b of buckets) {
    total.cacheRead += b.cacheRead;
    total.input += b.input;
    total.cacheWrite += b.cacheWrite;
    total.turns += b.turns;
  }
  return total;
}

/**
 * 读盘归一化：
 * - v2（`byModel` 数组）：逐桶校验，非法项丢弃；
 * - v1 及更早（扁平累计，无模型维度）：归入 unknown 桶而不是丢弃 —— 旧数据没有模型
 *   信息，宁可标成「未知模型」也不要静默清零；
 * - 无法识别：空。
 */
function normalizeStats(raw: unknown): PersistedStats {
  if (!raw || typeof raw !== "object") return { version: 2, byModel: [] };
  const o = raw as Record<string, unknown>;

  if (o.version === 2 && Array.isArray(o.byModel)) {
    const byModel: ModelBucket[] = [];
    for (const item of o.byModel) {
      if (!item || typeof item !== "object") continue;
      const b = item as Record<string, unknown>;
      const provider = typeof b.provider === "string" ? b.provider : undefined;
      const id = typeof b.id === "string" ? b.id : undefined;
      byModel.push({
        key: typeof b.key === "string" && b.key ? b.key : bucketKey(provider, id),
        provider,
        id,
        cacheRead: num(b.cacheRead),
        input: num(b.input),
        cacheWrite: num(b.cacheWrite),
        turns: num(b.turns),
        ...(b.cacheWriteReported === true ? { cacheWriteReported: true } : {}),
      });
    }
    return { version: 2, byModel };
  }

  const legacy: ModelBucket = {
    ...emptyBucket(undefined, undefined),
    cacheRead: num(o.cacheRead),
    input: num(o.input),
    cacheWrite: num(o.cacheWrite),
    turns: num(o.turns),
  };
  const hasData = legacy.cacheRead + legacy.input + legacy.cacheWrite + legacy.turns > 0;
  return { version: 2, byModel: hasData ? [legacy] : [] };
}

function loadStats(): PersistedStats {
  try {
    if (existsSync(STATS_FILE))
      return normalizeStats(JSON.parse(readFileSync(STATS_FILE, "utf-8")));
  } catch (err) {
    if (extensionCtx) {
      const msg = err instanceof Error ? err.message : String(err);
      extensionCtx.ui.notify(strings.statsParseFailed(msg), "warning");
    }
  }
  return { version: 2, byModel: [] };
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
// 值形态：v0.5 起为 { summary, model }；v0.4 及更早是裸字符串（模型未知）。
function loadSummaryCache(): Map<string, SummaryCacheEntry> {
  try {
    if (existsSync(SUMMARY_CACHE_FILE)) {
      const data: Record<string, unknown> = JSON.parse(readFileSync(SUMMARY_CACHE_FILE, "utf-8"));
      const cache = new Map<string, SummaryCacheEntry>();
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === "string") {
          cache.set(k, { summary: v, model: strings.unknownModel });
        } else if (v && typeof v === "object") {
          const e = v as { summary?: unknown; model?: unknown };
          if (typeof e.summary === "string") {
            cache.set(k, {
              summary: e.summary,
              model: typeof e.model === "string" ? e.model : strings.unknownModel,
            });
          }
        }
      }
      return cache;
    }
  } catch (err) {
    if (extensionCtx) {
      const msg = err instanceof Error ? err.message : String(err);
      extensionCtx.ui.notify(strings.summaryCacheParseFailed(msg), "warning");
    }
  }
  return new Map();
}

function saveSummaryCache(cache: Map<string, SummaryCacheEntry>) {
  try {
    const obj: Record<string, SummaryCacheEntry> = {};
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
    const {
      stats,
      ref,
      modelLabel,
      totals,
      totalsHitRate,
      byModel,
      lastTurnHitRate,
      pricing,
      reportsCacheWrite,
    } = this.view;
    const { cacheRead, input, cacheWrite, turns } = stats;
    const th = this.theme;
    const w = this.width;
    const inner = w - 2;

    // 官方口径 prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens；
    // pi-ai 的 usage.input 已是不相交的 miss 部分，故 hit/(hit+miss) 即命中率。
    // 此处为**当前模型**跨轮累计值（官方按请求逐次统计），另单独展示本轮值。
    const cumulative = calcHitRate(cacheRead, input);
    // 节省额 = 命中部分相对全量 miss 的边际差价，按当前模型单价计价。
    // 目录未标价（免费/未定价模型）时不估算：与其编一个数，不如留白。
    // flash 档单价低，每百万命中仅省 $0.147，固定 2 位小数会丢失有效信息，
    // 故小额用 4 位、大额用 2 位。
    const savedDollars = pricing.available
      ? (cacheRead / 1_000_000) * (pricing.tier.miss - pricing.tier.hit)
      : 0;
    const savedStr = !pricing.available
      ? strings.savingsUnavailable
      : savedDollars >= 0.01
        ? `$${savedDollars.toFixed(savedDollars < 1 ? 4 : 2)}`
        : "< $0.01";

    const pad = (s: string) => s + " ".repeat(Math.max(0, inner - visibleWidth(s)));
    const row = (s: string) => th.fg("border", "│") + pad(s) + th.fg("border", "│");
    // 按显示宽度而非码元数补齐，避免 CJK 标签错位
    const label = (k: string, v: string) => {
      const key = k + " ".repeat(Math.max(0, 14 - visibleWidth(k)));
      return `  ${th.fg("dim", key)}${th.fg("accent", v)}`;
    };

    const lines: string[] = [
      th.fg("border", `╭${"─".repeat(inner)}╮`),
      row(` ${th.fg("accent", strings.statsTitle)}`),
      row(""),
      row(label(strings.hitRate, `${cumulative.toFixed(1)}%`)),
      row(
        label(
          strings.lastTurnHitRate,
          lastTurnHitRate === undefined ? "—" : `${lastTurnHitRate.toFixed(1)}%`,
        ),
      ),
      row(label(strings.cacheHits, `${cacheRead.toLocaleString()} tokens`)),
      row(label(strings.cacheMisses, `${input.toLocaleString()} tokens`)),
    ];
    // 官方 usage 仅提供 hit/miss，无 cache write 字段；未观测到写入时隐藏该行
    if (reportsCacheWrite)
      lines.push(row(label(strings.cacheWrites, `${cacheWrite.toLocaleString()} tokens`)));
    lines.push(row(label(strings.turns, `${turns}`)));
    // 多模型时才需要一行全局口径，否则它与上面重复
    if (byModel.length > 1) {
      lines.push(row(label(strings.allModels, `${totalsHitRate.toFixed(1)}% · ${totals.turns}t`)));
    }
    const activeKey = ref ? bucketKey(ref.provider, ref.id) : undefined;
    lines.push(
      row(label(strings.estimatedSavings, savedStr)),
      row(""),
      row(
        ` ${th.fg("dim", fitLabel(strings.pricingLine(modelLabel, pricingSourceLabel(pricing)), inner - 2))}`,
      ),
    );
    if (pricing.available) {
      lines.push(
        row(
          ` ${th.fg("dim", fitLabel(`hit $${pricing.tier.hit} / miss $${pricing.tier.miss} per 1M`, inner - 2))}`,
        ),
      );
    }
    if (byModel.length > 0) {
      lines.push(row(` ${th.fg("dim", strings.byModelHeading(byModel.length))}`));
      for (const b of byModel.slice(0, MAX_BUCKET_ROWS)) {
        // 指标宽度固定，模型名按剩余宽度截断，避免撑破边框
        const metric = `${calcHitRate(b.cacheRead, b.input).toFixed(1)}% · ${b.turns}t`;
        const name = fitLabel(modelLabelOf(b.provider, b.id), inner - 4 - visibleWidth(metric));
        // ▸ 标记上方数字属于哪个模型
        const marker = b.key === activeKey ? "▸ " : "  ";
        lines.push(row(`${marker}${th.fg("dim", name)} ${th.fg("accent", metric)}`));
      }
      if (byModel.length > MAX_BUCKET_ROWS) {
        lines.push(row(`  ${th.fg("dim", strings.moreModels(byModel.length - MAX_BUCKET_ROWS))}`));
      }
    }
    lines.push(row(` ${th.fg("dim", strings.close)}`), th.fg("border", `╰${"─".repeat(inner)}╯`));
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
        let line: string;
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
  const setExtensionCtx = (ctx: ExtensionContext) => {
    extensionCtx = ctx;
  };

  // ───────── P1 命中率遥测(持久化、按模型分桶) ─────────
  const persisted = loadStats();
  const buckets = new Map<string, ModelBucket>();
  for (const b of persisted.byModel) buckets.set(b.key, b);
  const hitRateHistory = loadHistory();
  let lastHitRate =
    hitRateHistory.length > 0 ? hitRateHistory[hitRateHistory.length - 1].hitRate : 0;
  /** 最近一轮的 hit/miss，用于展示按请求口径的命中率（官方逐次统计口径） */
  let lastTurn: { read: number; miss: number } | undefined;
  /** 当前 wire model（provider + 目录 id），用于选价、展示、分桶 */
  let activeRef: ModelRef | undefined;
  /** 缓存前缀被改写的累计次数 */
  let prefixBreaks = 0;
  /**
   * 已知的可命中前缀集合。官方：cache prefix unit 独立完整、可并存，且未使用的条目
   * 数小时至数日内才会清理（"best-effort"）。因此判定“本轮是否破坏了前缀”不能只看
   * 上一轮——早期前缀回归时依然是有效命中。
   */
  const knownPrefixes: PrefixFingerprint[] = [];
  const MAX_KNOWN_PREFIXES = 8;

  const bucketFor = (provider: string | undefined, id: string | undefined): ModelBucket => {
    const key = bucketKey(provider, id);
    const existing = buckets.get(key);
    if (existing) {
      // 先到的消息可能缺 provider（旧会话 / 自定义消息），后续消息补齐
      existing.provider = provider ?? existing.provider;
      existing.id = id ?? existing.id;
      return existing;
    }
    const created = emptyBucket(provider, id);
    buckets.set(key, created);
    return created;
  };

  /** 落盘快照（v2）。深拷贝一层，避免防抖窗口内的后续消息改写即将写入的对象 */
  const statsSnapshot = (): PersistedStats => ({
    version: 2,
    byModel: [...buckets.values()].map((b) => ({ ...b })),
  });

  pi.on("message_end", async (event, ctx) => {
    setExtensionCtx(ctx);
    if (event.message.role !== "assistant") return;
    const u = event.message.usage;
    if (!u) return;
    const read = u.cacheRead ?? 0;
    const miss = u.input ?? 0;
    const write = u.cacheWrite ?? 0;
    const provider = event.message.provider;
    const modelId =
      typeof event.message.model === "string" && event.message.model
        ? event.message.model
        : undefined;
    if (modelId) activeRef = { provider, id: modelId };
    // v0.5: 按模型分桶累计——切模型 / router 多后端下命中率与单价差异极大，不能混算
    const bucket = bucketFor(provider, modelId);
    lastTurn = { read, miss };
    bucket.cacheRead += read;
    bucket.input += miss;
    bucket.cacheWrite += write;
    bucket.turns += 1;
    if (write > 0) bucket.cacheWriteReported = true;

    scheduleSaveStats(statsSnapshot());

    // R2: 计算一次，复用于状态栏与历史；底栏是**当前模型**口径
    ctx.ui.setStatus(
      "cache",
      `cache ${calcHitRate(bucket.cacheRead, bucket.input).toFixed(1)}% · ${bucket.turns}t`,
    );

    // 趋势图保持全部模型累计口径（与底栏的单模型口径不同，标题已标注）
    const totals = sumStats(buckets.values());
    // R3: 用 toFixed(1) 做定点比较，避免浮点去重失效
    const rateKey = calcHitRate(totals.cacheRead, totals.input).toFixed(1);
    const lastKey = lastHitRate.toFixed(1);
    if (rateKey !== lastKey) {
      // R4: 截断内存数组，与落盘保持一致
      hitRateHistory.push({ turn: totals.turns, hitRate: Number(rateKey), timestamp: Date.now() });
      if (hitRateHistory.length > MAX_HISTORY_POINTS) {
        hitRateHistory.splice(0, hitRateHistory.length - MAX_HISTORY_POINTS);
      }
      lastHitRate = Number(rateKey);
      scheduleSaveHistory(hitRateHistory);
    }
  });

  /**
   * 取当前模型的目录 cost：优先 `registry.find(provider, id)`；退回宿主当前模型
   * （虚拟模型 / 路由模型下 provider+id 未必能在目录里命中）。
   */
  const resolveActiveCost = (ctx: ExtensionContext, ref: ModelRef | undefined) => {
    if (!ref?.id) return undefined;
    try {
      const found = ref.provider ? ctx.modelRegistry.find(ref.provider, ref.id) : undefined;
      if (found) return found.cost;
    } catch {
      // 目录查询失败不影响统计展示：退回当前模型 / 保守下界
    }
    const current = ctx.model;
    if (current && (current.id === ref.id || current.provider === ref.provider))
      return current.cost;
    return undefined;
  };

  // /cache-stats → overlay 弹窗
  const buildStatsView = (ctx: ExtensionContext): StatsView => {
    const now = new Date();
    const byModel = [...buckets.values()].sort(
      (a, b) => b.cacheRead + b.input - (a.cacheRead + a.input) || (a.key < b.key ? -1 : 1),
    );
    // 还没发过消息就打开弹窗时（如会话刚启动）退化为量最大的桶，让弹窗仍有意义
    const active =
      (activeRef ? buckets.get(bucketKey(activeRef.provider, activeRef.id)) : undefined) ??
      byModel[0];
    const ref: ModelRef | undefined = active
      ? { provider: active.provider, id: active.id }
      : undefined;
    const totals = sumStats(buckets.values());
    return {
      stats: active ?? { cacheRead: 0, input: 0, cacheWrite: 0, turns: 0 },
      ref,
      modelLabel: modelLabelOf(ref?.provider, ref?.id),
      totals,
      totalsHitRate: calcHitRate(totals.cacheRead, totals.input),
      byModel,
      lastTurnHitRate: lastTurn ? calcHitRate(lastTurn.read, lastTurn.miss) : undefined,
      pricing: resolvePricing(ref, resolveActiveCost(ctx, ref), now),
      reportsCacheWrite: active?.cacheWriteReported === true,
    };
  };

  pi.registerCommand("cache-stats", {
    description: strings.statsDescription,
    handler: async (_args, ctx) => {
      setExtensionCtx(ctx);
      await ctx.ui.custom<void>(
        (_tui, theme, _kb, done) => new CacheStatsOverlay(theme, buildStatsView(ctx), done),
        { overlay: true },
      );
    },
  });

  // /cache-graph → overlay 弹窗
  pi.registerCommand("cache-graph", {
    description: strings.graphDescription,
    handler: async (_args, ctx) => {
      setExtensionCtx(ctx);
      await ctx.ui.custom<void>(
        (_tui, theme, _kb, done) => new CacheGraphOverlay(theme, hitRateHistory, done),
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
      buckets.clear();
      hitRateHistory.length = 0;
      lastHitRate = 0;
      lastTurn = undefined;
      activeRef = undefined;
      knownPrefixes.length = 0;
      prefixBreaks = 0;
      summaryCache.clear();
      flushPendingWrites();
      // 清除持久化文件
      try {
        if (existsSync(STATS_FILE)) unlinkSync(STATS_FILE);
        if (existsSync(HISTORY_FILE)) unlinkSync(HISTORY_FILE);
        if (existsSync(SUMMARY_CACHE_FILE)) unlinkSync(SUMMARY_CACHE_FILE);
      } catch {
        // 清理失败不影响重置语义：内存状态已清空，残留文件下次启动会被覆盖。
      }
    },
  });

  // ───────── P2 前缀守卫 ─────────
  pi.on("context", async (event, ctx) => {
    setExtensionCtx(ctx);
    // 剔除标记为 volatile-scratch 的自定义消息：它们每轮都变，会击穿前缀。
    // pi 1.2.x 的 AgentMessage 联合类型不再声明 customType（改由各扩展自行声明
    // 消息类型），故按结构化属性读取；没有该类消息时原样返回全部消息。
    if (!Array.isArray(event.messages)) return undefined;
    const onWire = event.messages.filter(
      (m) => (m as unknown as { customType?: unknown }).customType !== "volatile-scratch",
    );
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
      head: msgs.length > 1 ? hashMessages(msgs.slice(0, -1)) : "",
      len: msgs.length,
    };

    if (knownPrefixes.length > 0) {
      // 追加式 = 本轮消息列表以某个已知前缀开头，且 tools 未变。
      // 先做全量严格比对；失败再看"忽略上一份末条"的宽松比对：上一份的最后一条
      // 若是不入历史的临时注入块（plan-build 计划块 / todo 状态块），本轮同一位置
      // 必然是真实历史消息，严格比对注定失败 —— 那是误报，不是断链。
      // 宽松比对仅限"本轮确实变长"（fp.len > prev.len）：等长而末条被改、或历史被
      // 压缩变短，都仍按断链告警。中间任意位置被改写、或 tools 变化，两条比对同时失败。
      const isContinuation = knownPrefixes.some((prev) => {
        if (prev.tools !== fp.tools || fp.len < prev.len) return false;
        if (hashMessages(msgs.slice(0, prev.len)) === prev.messages) return true;
        if (fp.len <= prev.len || prev.len < 2) return false;
        return hashMessages(msgs.slice(0, prev.len - 1)) === prev.head;
      });
      if (!isContinuation) {
        prefixBreaks++;
        ctx.ui.notify(strings.prefixChanged(prefixBreaks), "warning");
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
    const { preparation, signal, customInstructions, reason } = event;
    const { messagesToSummarize, firstKeptEntryId, tokensBefore, previousSummary } = preparation;

    const history = serializeConversation(convertToLlm(messagesToSummarize));
    const base = previousSummary
      ? `${strings.previousSummary}\n${previousSummary}\n\n${strings.newHistory}\n${history}`
      : history;

    // pi 1.4.0 起 `/compact <指令>` 通过 `event.customInstructions` 传入（#11058）。
    // 自定义压缩接管了压缩路径，不自己带上就等于把用户指令静默丢掉；指令还必须并入
    // 哈希键，否则同一段历史换一条指令会命中上一次的摘要。措辞与宿主内置压缩一致。
    const focus = customInstructions?.trim();
    const text = focus ? `${base}\n\n${strings.summaryFocus}: ${focus}` : base;

    const key = createHash("sha256").update(text).digest("hex");
    const cached = summaryCache.get(key);
    let summary: string;
    let summarizer: string;
    if (cached) {
      // v0.5: 缓存值自带产出模型名，`details.summarizer` 不再靠猜
      summary = cached.summary;
      summarizer = cached.model;
    } else {
      const fresh = await summarizeWithModel(text, ctx, signal);
      if (!fresh) return;
      summary = fresh.summary;
      summarizer = fresh.model;
      setSummaryCache(summaryCache, key, { summary, model: summarizer });
      saveSummaryCache(summaryCache); // R12: 新摘要落盘，跨会话复用
    }

    return {
      compaction: {
        summary,
        firstKeptEntryId,
        tokensBefore,
        // reason（manual / threshold / overflow）写进 details，方便事后区分
        // “用户手动压”与“撑爆上下文才压”两种检查点。
        details: { summarizer, ...(reason ? { reason } : {}) },
      },
    };
  });

  // ──────── P4 对齐 pi 原生缓存续命（cache_warming_decision）────────
  // pi 0.86.0 起自带成本感知的前缀缓存续命，但它只在模型声明了 `promptCache` 生命期时
  // 才运行，而 pi 内置目录里的 deepseek 模型没有声明 —— 对 DeepSeek 等于永久关闭。
  // 本扩展不重复实现续命，只补两件事：把 DeepSeek 的事实说清楚（/cache-warm 给出
  // models.json 片段），以及在“缓存明显没在服务我们”时否决，避免白付费。
  pi.on("cache_warming_decision", (_event, ctx) => {
    setExtensionCtx(ctx);
    const model = ctx.model;
    if (!model) return undefined;
    const bucket = buckets.get(bucketKey(model.provider, model.id));
    if (!shouldVetoWarming(bucket)) return undefined;
    return { action: "stop" as const };
  });

  pi.registerCommand("cache-warm", {
    description: strings.warmDescription,
    handler: async (_args, ctx) => {
      setExtensionCtx(ctx);
      const model = ctx.model;
      const ref: ModelRef | undefined = model
        ? { provider: model.provider, id: model.id }
        : activeRef;
      const bucket = ref ? buckets.get(bucketKey(ref.provider, ref.id)) : undefined;
      const ttl = warmTtlSeconds(model);
      const rate = bucket ? calcHitRate(bucket.cacheRead, bucket.input).toFixed(1) : undefined;
      // models.json 的 modelOverrides 以模型 id 为键（不是 provider/id）
      const snippet = JSON.stringify(
        { modelOverrides: { [model?.id ?? "deepseek-flash"]: { promptCache: { short: 3600 } } } },
        null,
        2,
      );
      const lines = [
        strings.warmTitle,
        strings.warmModel(modelLabelOf(ref?.provider, ref?.id)),
        ttl === undefined ? strings.warmTtlMissing : strings.warmTtlDeclared(ttl),
        bucket && rate !== undefined
          ? strings.warmTelemetry(rate, bucket.turns)
          : strings.warmNoTelemetry,
        shouldVetoWarming(bucket) ? strings.warmVetoOn : strings.warmVetoOff,
        "",
        strings.warmEnable,
        snippet,
        "",
        strings.warmHint,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // 会话生命周期：切换/新会话时重置前缀指纹，避免旧会话哈希残留导致跨会话假阳性告警；
  // 退出时强制 flush（api-docs kv_cache best-effort 资源清理类比）
  const resetPrefixFingerprint = () => {
    knownPrefixes.length = 0;
  };
  pi.on("session_start", (_event, ctx) => {
    extensionCtx = ctx;
    resetPrefixFingerprint();
  });
  pi.on("session_before_switch", () => {
    resetPrefixFingerprint();
  });
  pi.on("session_shutdown", () => {
    flushPendingWrites();
  });
}

/**
 * 与 pi 自身的 getSummarizationFailure 同语义（未从包根导出，故内联）：
 * "A length stop contains partial text and must not become a session checkpoint."
 * error / length 两种 stopReason 都代表摘要不完整，不能被当作检查点。
 *
 * 只返回失败原因（模型 id 由调用处拼上），避免与 `strings.summaryFailed` 重复叙述。
 */
function getSummarizationFailure(response: {
  stopReason?: string;
  errorMessage?: string;
}): string | undefined {
  if (response.stopReason === "error") {
    return response.errorMessage || strings.summaryUnknownError;
  }
  if (response.stopReason === "length") {
    return strings.summaryTruncated;
  }
  return undefined;
}

/** 续命资格只依赖 promptCache 的两档生命期（宿主 Model 类型的结构子集） */
type WarmableModel = { promptCache?: { short?: number; long?: number } };

/** pi 只对声明了 promptCache 生命期的模型续命；未声明时事件根本不会触发。 */
export function warmTtlSeconds(model: WarmableModel | undefined): number | undefined {
  return model?.promptCache?.short ?? model?.promptCache?.long;
}

/**
 * 是否否决本轮续命。
 *
 * 只在“前缀缓存根本没在服务我们”时否决：连续 WARM_MIN_TURNS 轮没有任何 cache read。
 * 自建实例按副本缓存、router 轮询到别的副本、缓存被关掉，都属于这类；此时续命每次
 * 都要按 cache-read 单价付费，却不可能换来命中。否决只影响本轮（pi 的 "stop" 到
 * 下一次真实请求为止），不会永久关掉续命。
 */
export function shouldVetoWarming(
  bucket: { turns: number; cacheRead: number } | undefined,
): boolean {
  return bucket !== undefined && bucket.turns >= WARM_MIN_TURNS && bucket.cacheRead === 0;
}

/** 摘要器模型（结构类型，避免为类型而引入 @earendil-works/pi-ai） */
type SummarizerModel = NonNullable<ExtensionContext["model"]>;

/**
 * 选摘要模型。v0.5 起不再假设官方 provider 存在——第三方部署（router / 自建
 * OpenAI 兼容端点）下 `find("deepseek", ...)` 永远落空，旧实现在这类环境里
 * 等于没有 P3（每次都 notify 回退）。
 *
 * 顺序：
 * 1. 官方 provider 上的候选名（`deepseek-flash` / legacy `deepseek-v4-flash`）：官方用户行为不变；
 * 2. 当前模型本身就是 `flash` 档：直接用（用户已在用、已验证可用，不做意外路由）；
 * 3. 当前 provider 的 `flash` 档（优先名字含 `deepseek`，多候选取字典序最小以保证跨轮稳定）：
 *    第三方 router 常有多个后端的同款 flash（如 `amd/DeepSeek-V4.1-Flash`）；
 * 4. 当前模型；
 * 5. 都没有 → 调用处 notify 并回退默认 compaction。
 */
function resolveSummarizerModel(ctx: ExtensionContext): SummarizerModel | undefined {
  // 官方注(1)：`deepseek-flash` 为当前模型名，legacy 名 `deepseek-v4-flash` 仍受理。
  // 两个名字都试，任一命中即可，避免 pi 模型目录跟进官方改名后静默失效。
  for (const id of SUMMARIZER_CANDIDATES) {
    const model = ctx.modelRegistry.find(OFFICIAL_DEEPSEEK_PROVIDER, id);
    if (model) return model;
  }

  const current = ctx.model;
  if (current) {
    if (current.id.toLowerCase().includes("flash")) return current;
    if (current.provider) {
      try {
        const flash = ctx.modelRegistry
          .getModelsOfType("chat", current.provider)
          .filter((m) => m.id.toLowerCase().includes("flash"));
        if (flash.length > 0) {
          const preferred = flash.find((m) => m.id.toLowerCase().includes("deepseek"));
          // 多候选时取字典序最小，避免目录顺序抖动导致每次选到不同模型
          return (
            preferred ?? [...flash].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]
          );
        }
      } catch {
        // 目录查询失败不阻断：退回当前模型
      }
    }
  }

  return current;
}

async function summarizeWithModel(
  text: string,
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<{ summary: string; model: string } | undefined> {
  const model = resolveSummarizerModel(ctx);
  if (!model) {
    ctx.ui.notify(strings.modelMissing(SUMMARIZER_CANDIDATES.join(" / ")), "warning");
    return;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    ctx.ui.notify(strings.authFailed(model.id, auth.error), "warning");
    return;
  }

  try {
    // ModelRegistry.complete 在请求时自行解析鉴权（apiKey / OAuth / headers），
    // 因此不再需要从 @earendil-works/pi-ai 引入 compat 的 complete()，
    // 扩展也不再需要任何 pi-ai 依赖。
    const response = await ctx.modelRegistry.complete(
      model,
      {
        messages: [
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const,
                text: strings.summaryPrompt + text,
              },
            ],
            timestamp: Date.now(),
          },
        ],
      },
      // pi 1.4.0 起内置摘要不再传 maxTokens，改为吃模型输出上限，以修 #9512 的
      // “generation hit the token cap”（`reserveTokens` 也已被忽略）。这里对齐宿主：
      // 不设上限；同时 `cacheRetention: "none"` —— 一次性摘要不该写缓存，宿主同样如此。
      { temperature: 0, signal, cacheRetention: "none" as const },
    );

    // 截断/失败的摘要不得成为会话检查点。与 pi 自身的 getSummarizationFailure 同语义
    // （pi: dist/core/compaction/compaction.js —— "A length stop contains partial text
    // and must not become a session checkpoint."）。该函数未从包根导出，故在此内联。
    // 重要：本扩展返回的摘要会被 pi 原文替换历史，并按输入哈希写进 summary-cache.json，
    // 因此一次截断不但丢上下文，还会被缓存固化。
    const failure = getSummarizationFailure(response);
    if (failure) {
      ctx.ui.notify(strings.summaryFailed(`${model.id}: ${failure}`), "warning");
      return;
    }

    const summary = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    return summary.trim() ? { summary: summary.trim(), model: model.id } : undefined;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(strings.summaryFailed(msg), "error");
    return;
  }
}

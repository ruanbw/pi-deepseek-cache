import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth, type Focusable } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ═══════════════════════════════════════════════════════════════════════════
//  持久化存储
// ═══════════════════════════════════════════════════════════════════════════

const STATS_DIR = join(homedir(), ".pi", "agent", "extensions", "deepseek-cache");
const STATS_FILE = join(STATS_DIR, "stats.json");
const HISTORY_FILE = join(STATS_DIR, "history.json");

function loadStats() {
  try {
    if (existsSync(STATS_FILE)) return JSON.parse(readFileSync(STATS_FILE, "utf-8"));
  } catch {}
  return { cacheRead: 0, input: 0, cacheWrite: 0, turns: 0 };
}

function saveStats(s: { cacheRead: number; input: number; cacheWrite: number; turns: number }) {
  try {
    if (!existsSync(STATS_DIR)) mkdirSync(STATS_DIR, { recursive: true });
    writeFileSync(STATS_FILE, JSON.stringify(s, null, 2));
  } catch {}
}

function loadHistory(): Array<{ turn: number; hitRate: number; timestamp: number }> {
  try {
    if (existsSync(HISTORY_FILE)) return JSON.parse(readFileSync(HISTORY_FILE, "utf-8"));
  } catch {}
  return [];
}

function saveHistory(h: Array<{ turn: number; hitRate: number; timestamp: number }>) {
  try {
    if (!existsSync(STATS_DIR)) mkdirSync(STATS_DIR, { recursive: true });
    writeFileSync(HISTORY_FILE, JSON.stringify(h.slice(-100), null, 2));
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════
//  Overlay 组件
// ═══════════════════════════════════════════════════════════════════════════

/** 缓存统计弹窗 */
class CacheStatsOverlay implements Focusable {
  readonly width = 56;
  focused = false;

  private stats: { cacheRead: number; input: number; cacheWrite: number; turns: number };
  private theme: Theme;
  private done: () => void;

  constructor(theme: Theme, stats: typeof this.stats, done: () => void) {
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
  readonly width = 60;
  focused = false;

  private history: Array<{ turn: number; hitRate: number; timestamp: number }>;
  private theme: Theme;
  private done: () => void;

  constructor(theme: Theme, history: typeof this.history, done: () => void) {
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
    const chartH = 10;
    const chartW = Math.min(this.history.length, 48);

    // 采样
    const step = Math.max(1, Math.floor(this.history.length / chartW));
    const data = this.history.filter((_, i) => i % step === 0).slice(-chartW);

    // Y 轴标签宽度
    const yW = Math.max(maxRate.toFixed(0).length, minRate.toFixed(0).length) + 1;

    // 生成图表行
    const chart: string[] = [];
    for (let r = chartH; r >= 0; r--) {
      const threshold = minRate + (maxRate - minRate) * (r / chartH);
      let line = "";
      if (r === chartH) line = `${maxRate.toFixed(0)}%`.padStart(yW);
      else if (r === 0) line = `${minRate.toFixed(0)}%`.padStart(yW);
      else line = "".padStart(yW);
      for (const p of data) {
        line += p.hitRate >= threshold ? "█" : " ";
      }
      chart.push(line);
    }

    // X 轴
    chart.push("".padStart(yW) + "─".repeat(data.length));

    // X 轴标签: 首 / 中 / 尾 turn 编号
    const first = data[0].turn;
    const mid = data[Math.floor(data.length / 2)]?.turn ?? "";
    const last = data[data.length - 1].turn;
    const half = Math.floor(data.length / 2);
    const xLabel = `${first}`.padEnd(half - String(mid).length / 2)
      + `${mid}`.padEnd(data.length - half - String(mid).length / 2 - String(last).length)
      + `${last}`;
    chart.push("".padStart(yW) + xLabel);

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
  // ───────── P1 命中率遥测(持久化) ─────────
  const persisted = loadStats();
  let { cacheRead, input, cacheWrite, turns } = persisted;
  const hitRateHistory = loadHistory();
  let lastHitRate = hitRateHistory.length > 0 ? hitRateHistory[hitRateHistory.length - 1].hitRate : 0;

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const u = event.message.usage;
    if (!u) return;
    cacheRead += u.cacheRead ?? 0;
    input += u.input ?? 0;
    cacheWrite += u.cacheWrite ?? 0;
    turns += 1;

    saveStats({ cacheRead, input, cacheWrite, turns });

    const rate = (cacheRead + input) ? (cacheRead / (cacheRead + input)) * 100 : 0;
    ctx.ui.setStatus("cache", `cache ${rate.toFixed(1)}% · ${turns}t`);

    const currentHitRate = (cacheRead + input) ? (cacheRead / (cacheRead + input)) * 100 : 0;
    if (currentHitRate !== lastHitRate) {
      hitRateHistory.push({ turn: turns, hitRate: currentHitRate, timestamp: Date.now() });
      lastHitRate = currentHitRate;
      saveHistory(hitRateHistory);
    }
  });

  // /cache-stats → overlay 弹窗
  pi.registerCommand("cache-stats", {
    description: "DeepSeek 前缀缓存命中率",
    handler: async (_args, ctx) => {
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
      await ctx.ui.custom(
        (_tui, theme, _kb, done) =>
          new CacheGraphOverlay(theme, hitRateHistory, done),
        { overlay: true },
      );
    },
  });

  // ───────── P2 前缀守卫 ─────────
  pi.on("context", async (event, _ctx) => {
    const onWire = event.messages.filter((m: any) => m?.customType !== "volatile-scratch");
    return { messages: onWire };
  });

  let lastPrefixHash: string | undefined;
  pi.on("before_provider_request", (event, _ctx) => {
    const msgs = (event.payload as any).messages ?? [];
    lastPrefixHash = createHash("sha256")
      .update(JSON.stringify(msgs.slice(0, -1))).digest("hex");
  });

  // ───────── P3 缓存友好的 compaction ─────────
  const summaryCache = new Map<string, string>();
  pi.on("session_before_compact", async (event, ctx) => {
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
      { apiKey: auth.apiKey, headers: auth.headers, maxTokens: 8192, signal },
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

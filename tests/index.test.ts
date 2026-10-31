import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

// 与 vitest.config.ts 的 PI_DEEPSEEK_CACHE_DIR 保持一致：测试绝不碰用户真实的统计目录
const STATS_DIR =
  process.env.PI_DEEPSEEK_CACHE_DIR ??
  join(homedir(), ".pi", "agent", "extensions", "deepseek-cache");

function clearPersistedData() {
  ["stats.json", "history.json", "summary-cache.json"].forEach((f) => {
    const p = join(STATS_DIR, f);
    if (existsSync(p)) unlinkSync(p);
  });
}

/** 极简 theme stub：CacheStatsOverlay/GraphOverlay 只用到 fg(color, str) */
const stubTheme = { fg: (_c: string, s: string) => s } as unknown as Theme;

/** 扩展事件监听器签名（各钩子参数形态不一，测试内按需 cast） */
type Listener = (...args: unknown[]) => unknown;

/** mock 仅实现 on/registerCommand，cast 到真实 ExtensionAPI 以避免引入 any */
const asApi = (api: ReturnType<typeof createMockExtensionAPI>) => api as unknown as ExtensionAPI;

/** 摘要请求的返回体在测试中只用 content 文本 */
type CompletionResult = { content: Array<{ type: string; text?: string }> };
const completion = (text: string): CompletionResult => ({ content: [{ type: "text", text }] });

import index, { resolveLanguage, shouldVetoWarming, warmTtlSeconds } from "../index.js";

describe("language selection", () => {
  it("defaults to English for non-Chinese locales", () => {
    expect(resolveLanguage({ LANG: "fr_FR.UTF-8" })).toBe("en");
  });

  it("uses Chinese for Chinese locales", () => {
    expect(resolveLanguage({ LANG: "zh_CN.UTF-8" })).toBe("zh");
  });

  it("lets PI_DEEPSEEK_CACHE_LANG take precedence", () => {
    expect(resolveLanguage({ PI_DEEPSEEK_CACHE_LANG: "en", LANG: "zh_CN.UTF-8" })).toBe("en");
  });
});

function createMockExtensionAPI() {
  const listeners = new Map<string, Function[]>();
  const commands = new Map<string, { description: string; handler: Function }>();
  return {
    on: vi.fn((event: string, listener: Function) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(listener);
    }),
    registerCommand: vi.fn((name: string, cmd: any) => {
      commands.set(name, cmd);
    }),
    __emit: async (event: string, data: any) => {
      for (const fn of listeners.get(event) ?? []) await fn(data, mockCtx);
    },
    __getCommand: (name: string) => commands.get(name),
  };
}

/** 摘要在 1.2.x 走 ctx.modelRegistry.complete（由宿主在请求时解析鉴权） */
const completeMock = vi.fn();

const mockCtx = {
  ui: {
    setStatus: vi.fn(),
    notify: vi.fn(),
    custom: vi.fn().mockResolvedValue(undefined),
  },
  // 宿主当前模型（虚拟模型 / 路由模型下用于回退取价与选摘要器）
  model: undefined as
    | {
        id: string;
        provider: string;
        cost?: Record<string, number>;
        promptCache?: { short?: number; long?: number };
      }
    | undefined,
  modelRegistry: {
    find: vi.fn(),
    getModelsOfType: vi.fn(() => [] as Array<{ id: string; provider: string }>),
    getApiKeyAndHeaders: vi.fn(),
    complete: completeMock,
  },
};

/** 每个用例开头把共享 mock 恢复成干净状态（find/getModelsOfType/current model 会被各用例改写） */
function resetMockCtx() {
  mockCtx.modelRegistry.find.mockReset();
  mockCtx.modelRegistry.getModelsOfType.mockReset();
  mockCtx.modelRegistry.getModelsOfType.mockReturnValue([]);
  mockCtx.model = undefined;
}

/** 取某个事件的监听器 */
function listenerFor(api: ReturnType<typeof createMockExtensionAPI>, event: string): Listener {
  const fn = (api.on as unknown as { mock: { calls: [string, Listener][] } }).mock.calls.find(
    ([e]) => e === event,
  )?.[1];
  expect(fn, `未注册 ${event} 监听器`).toBeDefined();
  return fn as Listener;
}

/** 执行 /cache-stats 并返回弹窗的渲染行 */
async function renderStatsLines(api: ReturnType<typeof createMockExtensionAPI>): Promise<string[]> {
  await api.__getCommand("cache-stats")!.handler([], mockCtx);
  const factory = mockCtx.ui.custom.mock.calls.at(-1)![0] as (
    tui: unknown,
    theme: Theme,
    kb: unknown,
    done: () => void,
  ) => { render: (w: number) => string[] };
  return factory(undefined, stubTheme, undefined, () => {}).render(120);
}

/** 执行 /cache-stats 并返回弹窗的纯文本渲染结果 */
async function renderStats(api: ReturnType<typeof createMockExtensionAPI>): Promise<string> {
  return (await renderStatsLines(api)).join("\n");
}

const PREFIX_BREAK_WARNING = "缓存前缀变化";

// ═══ P1: 命中率遥测 ═══
describe("P1: cache hit telemetry", () => {
  let api: ReturnType<typeof createMockExtensionAPI>;
  beforeEach(() => {
    clearPersistedData();
    api = createMockExtensionAPI();
    index(api as any);
  });

  it("累计 cacheRead / input / cacheWrite / turns", async () => {
    await api.__emit("message_end", {
      message: { role: "assistant", usage: { cacheRead: 100, input: 50, cacheWrite: 10 } },
    });
    await api.__emit("message_end", {
      message: { role: "assistant", usage: { cacheRead: 200, input: 30, cacheWrite: 5 } },
    });
    await api.__getCommand("cache-stats")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  it("忽略非 assistant 消息", async () => {
    await api.__emit("message_end", {
      message: { role: "user", usage: { cacheRead: 999, input: 999, cacheWrite: 999 } },
    });
    await api.__getCommand("cache-stats")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  it("无 usage 时不崩溃", async () => {
    await api.__emit("message_end", { message: { role: "assistant" } });
    await api.__getCommand("cache-stats")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  it("cacheRead/denom=0 时不除零", async () => {
    await api.__emit("message_end", {
      message: { role: "assistant", usage: { cacheRead: 0, input: 0, cacheWrite: 0 } },
    });
    await api.__getCommand("cache-stats")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });
});

// ═══ P1a: cache-graph 命令 ═══
describe("P1a: cache-graph command", () => {
  let api: ReturnType<typeof createMockExtensionAPI>;
  beforeEach(() => {
    clearPersistedData();
    api = createMockExtensionAPI();
    index(api as any);
  });

  it("无历史数据时显示提示", async () => {
    await api.__getCommand("cache-graph")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  it("有数据时输出图表", async () => {
    for (const [cr, inp] of [
      [0, 100],
      [50, 50],
      [80, 20],
      [90, 10],
      [95, 5],
    ]) {
      await api.__emit("message_end", {
        message: { role: "assistant", usage: { cacheRead: cr, input: inp, cacheWrite: 0 } },
      });
    }
    await api.__getCommand("cache-graph")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  it("相同命中率不重复记录", async () => {
    await api.__emit("message_end", {
      message: { role: "assistant", usage: { cacheRead: 10, input: 10, cacheWrite: 0 } },
    });
    await api.__emit("message_end", {
      message: { role: "assistant", usage: { cacheRead: 20, input: 20, cacheWrite: 0 } },
    });
    await api.__emit("message_end", {
      message: { role: "assistant", usage: { cacheRead: 30, input: 30, cacheWrite: 0 } },
    });
    await api.__emit("message_end", {
      message: { role: "assistant", usage: { cacheRead: 80, input: 20, cacheWrite: 0 } },
    });
    await api.__getCommand("cache-graph")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  it("图表包含 X 轴 turn 编号", async () => {
    for (const [cr, inp] of [
      [0, 100],
      [50, 50],
      [80, 20],
      [90, 10],
      [95, 5],
    ]) {
      await api.__emit("message_end", {
        message: { role: "assistant", usage: { cacheRead: cr, input: inp, cacheWrite: 0 } },
      });
    }
    await api.__getCommand("cache-graph")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });
});

// ═══ P2: 前缀守卫 ═══
describe("P2: volatile-scratch stripping", () => {
  let api: ReturnType<typeof createMockExtensionAPI>;
  beforeEach(() => {
    clearPersistedData();
    api = createMockExtensionAPI();
    index(api as any);
  });

  it("过滤掉 customType=volatile-scratch 的消息", async () => {
    const messages = [
      { role: "system", content: "keep" },
      { role: "user", customType: "volatile-scratch", content: "scratch" },
      { role: "assistant", content: "keep" },
      { role: "user", customType: "volatile-scratch", content: "scratch2" },
    ];
    const ctx = (api.on as any).mock.calls.find(([e]: [string]) => e === "context")?.[1];
    expect((await ctx({ messages }, mockCtx)).messages).toEqual([
      { role: "system", content: "keep" },
      { role: "assistant", content: "keep" },
    ]);
  });

  it("无 volatile-scratch 消息时保留全部", async () => {
    const messages = [
      { role: "system", content: "a" },
      { role: "user", content: "b" },
    ];
    const ctx = (api.on as any).mock.calls.find(([e]: [string]) => e === "context")?.[1];
    expect((await ctx({ messages }, mockCtx)).messages).toEqual(messages);
  });

  it("customType 字段为 undefined 时不过滤", async () => {
    const messages = [{ role: "user", content: "normal" }];
    const ctx = (api.on as any).mock.calls.find(([e]: [string]) => e === "context")?.[1];
    expect((await ctx({ messages }, mockCtx)).messages).toEqual(messages);
  });

  it("before_provider_request 记录前缀哈希", async () => {
    const ctx = (api.on as any).mock.calls.find(
      ([e]: [string]) => e === "before_provider_request",
    )?.[1];
    expect(ctx).toBeDefined();
    ctx(
      {
        payload: {
          messages: [
            { role: "system", content: "a" },
            { role: "user", content: "b" },
          ],
        },
      },
      mockCtx,
    );
  });
});

// ═══ P3: session_before_compact ═══
describe("P3: session_before_compact", () => {
  let api: ReturnType<typeof createMockExtensionAPI>;
  beforeEach(() => {
    clearPersistedData();
    api = createMockExtensionAPI();
    mockCtx.modelRegistry.find.mockReturnValue({ id: "deepseek-v4-flash", provider: "deepseek" });
    mockCtx.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({
      ok: true,
      apiKey: "sk-test",
      headers: {},
    });
    completeMock.mockReset();
    index(api as any);
  });

  it("相同输入命中摘要缓存", async () => {
    const listener = (api.on as any).mock.calls.find(
      ([e]: [string]) => e === "session_before_compact",
    )?.[1];
    const prep = {
      messagesToSummarize: [{ role: "user", content: "hello" }],
      firstKeptEntryId: "e1",
      tokensBefore: 1000,
      previousSummary: "",
    };
    completeMock.mockResolvedValueOnce({ content: [{ type: "text", text: "summary A" }] } as any);
    expect(
      (await listener({ preparation: prep, signal: new AbortController().signal }, mockCtx))
        .compaction.summary,
    ).toBe("summary A");
    completeMock.mockClear();
    expect(
      (await listener({ preparation: prep, signal: new AbortController().signal }, mockCtx))
        .compaction.summary,
    ).toBe("summary A");
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("模型不存在时回退", async () => {
    mockCtx.modelRegistry.find.mockReturnValue(null);
    const listener = (api.on as any).mock.calls.find(
      ([e]: [string]) => e === "session_before_compact",
    )?.[1];
    expect(
      await listener(
        {
          preparation: {
            messagesToSummarize: [],
            firstKeptEntryId: "e1",
            tokensBefore: 500,
            previousSummary: "",
          },
          signal: new AbortController().signal,
        },
        mockCtx,
      ),
    ).toBeUndefined();
  });

  it("previousSummary 并入 hash 输入", async () => {
    const listener = (api.on as any).mock.calls.find(
      ([e]: [string]) => e === "session_before_compact",
    )?.[1];
    completeMock.mockResolvedValueOnce({ content: [{ type: "text", text: "summary v1" }] } as any);
    const r1 = await listener(
      {
        preparation: {
          messagesToSummarize: [{ role: "user", content: "same" }],
          firstKeptEntryId: "e1",
          tokensBefore: 100,
          previousSummary: "v1",
        },
        signal: new AbortController().signal,
      },
      mockCtx,
    );
    completeMock.mockResolvedValueOnce({ content: [{ type: "text", text: "summary v2" }] } as any);
    const r2 = await listener(
      {
        preparation: {
          messagesToSummarize: [{ role: "user", content: "same" }],
          firstKeptEntryId: "e1",
          tokensBefore: 100,
          previousSummary: "v2",
        },
        signal: new AbortController().signal,
      },
      mockCtx,
    );
    expect(r1.compaction.summary).toBe("summary v1");
    expect(r2.compaction.summary).toBe("summary v2");
  });

  it("鉴权失败时回退", async () => {
    mockCtx.modelRegistry.getApiKeyAndHeaders.mockResolvedValueOnce({
      ok: false,
      error: "no credential",
    });
    const listener = (api.on as any).mock.calls.find(
      ([e]: [string]) => e === "session_before_compact",
    )?.[1];
    expect(
      await listener(
        {
          preparation: {
            messagesToSummarize: [],
            firstKeptEntryId: "e1",
            tokensBefore: 500,
            previousSummary: "",
          },
          signal: new AbortController().signal,
        },
        mockCtx,
      ),
    ).toBeUndefined();
  });

  // 回归：官方 ResolvedRequestAuth 允许 ok:true 而 apiKey 为 undefined（纯 headers/OAuth 类 provider）。
  // 旧实现用 `!auth.ok || !auth.apiKey` 判定，会把这类 provider 误判为鉴权失败并静默放弃自定义压缩。
  it("apiKey 为空但 auth.ok（纯 headers/OAuth）时仍继续摘要", async () => {
    mockCtx.modelRegistry.getApiKeyAndHeaders.mockResolvedValueOnce({
      ok: true,
      apiKey: undefined,
      headers: { "x-api-key": "h" },
    });
    completeMock.mockResolvedValueOnce({
      content: [{ type: "text", text: "summary via headers" }],
    } as any);
    const listener = (api.on as any).mock.calls.find(
      ([e]: [string]) => e === "session_before_compact",
    )?.[1];
    const r = await listener(
      {
        preparation: {
          messagesToSummarize: [{ role: "user", content: "hi" }],
          firstKeptEntryId: "e1",
          tokensBefore: 100,
          previousSummary: "",
        },
        signal: new AbortController().signal,
      },
      mockCtx,
    );
    expect(r.compaction.summary).toBe("summary via headers");
  });

  // 回归：截断的摘要不得成为检查点（pi 自身同样拒绝，见 getSummarizationFailure）。
  // 否则不完整的摘要会替换历史，并按输入哈希被 summary-cache.json 固化。
  it("stopReason=length（截断）时回退，不采纳不完整摘要", async () => {
    completeMock.mockResolvedValueOnce({
      content: [{ type: "text", text: "partial summ" }],
      stopReason: "length",
    } as any);
    const listener = (api.on as any).mock.calls.find(
      ([e]: [string]) => e === "session_before_compact",
    )?.[1];
    expect(
      await listener(
        {
          preparation: {
            messagesToSummarize: [{ role: "user", content: "x" }],
            firstKeptEntryId: "e1",
            tokensBefore: 500,
            previousSummary: "",
          },
          signal: new AbortController().signal,
        },
        mockCtx,
      ),
    ).toBeUndefined();
  });

  it("stopReason=error 时回退", async () => {
    completeMock.mockResolvedValueOnce({
      content: [{ type: "text", text: "partial" }],
      stopReason: "error",
      errorMessage: "boom",
    } as any);
    const listener = (api.on as any).mock.calls.find(
      ([e]: [string]) => e === "session_before_compact",
    )?.[1];
    expect(
      await listener(
        {
          preparation: {
            messagesToSummarize: [{ role: "user", content: "x" }],
            firstKeptEntryId: "e1",
            tokensBefore: 500,
            previousSummary: "",
          },
          signal: new AbortController().signal,
        },
        mockCtx,
      ),
    ).toBeUndefined();
  });

  it("stopReason=stop（正常结束）时采纳摘要", async () => {
    completeMock.mockResolvedValueOnce({
      content: [{ type: "text", text: "complete summary" }],
      stopReason: "stop",
    } as any);
    const listener = (api.on as any).mock.calls.find(
      ([e]: [string]) => e === "session_before_compact",
    )?.[1];
    const r = await listener(
      {
        preparation: {
          messagesToSummarize: [{ role: "user", content: "x" }],
          firstKeptEntryId: "e1",
          tokensBefore: 500,
          previousSummary: "",
        },
        signal: new AbortController().signal,
      },
      mockCtx,
    );
    expect(r.compaction.summary).toBe("complete summary");
  });

  it("complete 调用失败时回退", async () => {
    completeMock.mockRejectedValueOnce(new Error("API error"));
    const listener = (api.on as any).mock.calls.find(
      ([e]: [string]) => e === "session_before_compact",
    )?.[1];
    expect(
      await listener(
        {
          preparation: {
            messagesToSummarize: [{ role: "user", content: "test" }],
            firstKeptEntryId: "e1",
            tokensBefore: 500,
            previousSummary: "",
          },
          signal: new AbortController().signal,
        },
        mockCtx,
      ),
    ).toBeUndefined();
  });

  it("空摘要时回退", async () => {
    completeMock.mockResolvedValueOnce({ content: [{ type: "text", text: "   " }] } as any);
    const listener = (api.on as any).mock.calls.find(
      ([e]: [string]) => e === "session_before_compact",
    )?.[1];
    expect(
      await listener(
        {
          preparation: {
            messagesToSummarize: [],
            firstKeptEntryId: "e1",
            tokensBefore: 500,
            previousSummary: "",
          },
          signal: new AbortController().signal,
        },
        mockCtx,
      ),
    ).toBeUndefined();
  });
});

// ═══ R13: 官方定价（Models & Pricing, 每百万 token）═══
describe("R13: 官方定价", () => {
  let api: ReturnType<typeof createMockExtensionAPI>;
  beforeEach(() => {
    clearPersistedData();
    mockCtx.ui.notify.mockClear();
    mockCtx.ui.custom.mockClear();
    api = createMockExtensionAPI();
    index(asApi(api));
  });
  afterEach(() => vi.useRealTimers());

  // 2026-01-05 为周一，02:00 UTC 落在官方峰值窗口 01:00-04:00 内
  const PEAK = "2026-01-05T02:00:00Z";
  // 2026-01-03 为周六，任何时刻均为谷值
  const OFF_PEAK = "2026-01-03T02:00:00Z";

  const emit = (model: string, cacheRead: number, input: number, provider = "deepseek") =>
    api.__emit("message_end", {
      message: { role: "assistant", provider, model, usage: { cacheRead, input, cacheWrite: 0 } },
    });

  it("flash 峰值按 $0.006 / $0.30 计价", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(PEAK));
    await emit("deepseek-v4-flash", 1_000_000, 0);
    const out = await renderStats(api);
    expect(out).toContain("hit $0.006 / miss $0.3 per 1M");
    expect(out).toContain("$0.294"); // 1M × (0.30 − 0.006)
    expect(out).toContain("峰值时段");
  });

  it("谷值时段单价减半（官方注(2)）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(OFF_PEAK));
    await emit("deepseek-v4-flash", 1_000_000, 0);
    const out = await renderStats(api);
    expect(out).toContain("hit $0.003 / miss $0.15 per 1M");
    expect(out).toContain("$0.147"); // 1M × (0.15 − 0.003)
    expect(out).toContain("谷值时段");
  });

  it("v4-pro 按 Pro 自身价目表计价（官方 2026-09-10：v4-pro 继续提供，计费方式不变）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(PEAK));
    await emit("deepseek-v4-pro", 1_000_000, 0);
    const out = await renderStats(api);
    expect(out).toContain("deepseek-v4-pro");
    expect(out).toContain("hit $0.044 / miss $1.32 per 1M");
    expect(out).toContain("$1.28"); // 1M × (1.32 − 0.044) = $1.276，大额固定 2 位小数
  });

  it("v4-pro 谷值价为其峰值价的一半", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(OFF_PEAK));
    await emit("deepseek-v4-pro", 1_000_000, 0);
    expect(await renderStats(api)).toContain("hit $0.022 / miss $0.66 per 1M");
  });

  // 2026-05-01（周五，劳动节）02:00 UTC 落在峰值窗口内，但官方注(2) 排除中国公共假期
  const CN_HOLIDAY_PEAK_WINDOW = "2026-05-01T02:00:00Z";
  // 2026-05-04（周一）同为劳动节假期
  const CN_HOLIDAY_MONDAY = "2026-05-04T02:00:00Z";
  // 2026-05-08（周五）假期之后，同为峰值窗口
  const AFTER_HOLIDAY_FRIDAY = "2026-05-08T02:00:00Z";

  it("中国公共假期内不开峰值（官方注(2) 排除中国公共假期）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CN_HOLIDAY_PEAK_WINDOW));
    await emit("deepseek-flash", 1_000_000, 0);
    const out = await renderStats(api);
    expect(out).toContain("谷值时段");
    expect(out).toContain("hit $0.003 / miss $0.15 per 1M");
  });

  it("假期期间的周一同样不开峰值", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CN_HOLIDAY_MONDAY));
    await emit("deepseek-flash", 1_000_000, 0);
    expect(await renderStats(api)).toContain("谷值时段");
  });

  it("假期结束后同一时段恢复峰值", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(AFTER_HOLIDAY_FRIDAY));
    await emit("deepseek-flash", 1_000_000, 0);
    expect(await renderStats(api)).toContain("峰值时段");
  });

  it("未收录年份不会误判为假期（退化为旧行为）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2031-05-01T02:00:00Z"));
    await emit("deepseek-flash", 1_000_000, 0);
    expect(await renderStats(api)).toContain("峰值时段");
  });

  it("已停用的 deepseek-chat / deepseek-reasoner 仍能取到价（官方 2026-07-24 停用）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(PEAK));
    await emit("deepseek-chat", 1_000_000, 0);
    const chat = await renderStats(api);
    await emit("deepseek-reasoner", 0, 0);
    const reasoner = await renderStats(api);
    const priceOf = (s: string) =>
      s
        .split("\n")
        .find((l) => l.includes("per 1M"))!
        .replace(/[│\s]/g, "");
    expect(priceOf(chat)).toBe("hit$0.006/miss$0.3per1M");
    expect(priceOf(reasoner)).toBe(priceOf(chat));
  });

  it("官方当前名 deepseek-flash 与 legacy 名同价（官方注(1)：legacy 已退役但仍受理）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(PEAK));
    await emit("deepseek-flash", 1_000_000, 0);
    const current = await renderStats(api);
    await emit("deepseek-v4-flash", 0, 0);
    const legacy = await renderStats(api);
    const priceOf = (s: string) =>
      s
        .split("\n")
        .find((l) => l.includes("per 1M"))!
        .replace(/[│\s]/g, "");
    expect(priceOf(current)).toBe(priceOf(legacy));
  });

  it("未知模型取保守下界，不高估节省", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(PEAK));
    await emit("some-unknown-model", 1_000_000, 0);
    const out = await renderStats(api);
    expect(out).toContain("hit $0.003 / miss $0.15 per 1M");
    expect(out).toContain("$0.1470");
    expect(out).toContain("some-unknown-model");
  });

  it("尚未观测到任何模型时标为未知模型", async () => {
    await renderStats(api);
    expect(await renderStats(api)).toContain("未知模型");
  });

  it("同时展示累计与本轮命中率，二者口径不同", async () => {
    await emit("deepseek-v4-flash", 0, 100);
    await emit("deepseek-v4-flash", 90, 10);
    const out = await renderStats(api);
    expect(out).toContain("累计命中率");
    expect(out).toContain("45.0%"); // 90 / (90+110) 跨轮累计
    expect(out).toContain("本轮命中率");
    expect(out).toContain("90.0%"); // 90 / (90+10) 官方逐次口径
  });

  it("官方无 cache write 字段，未观测到写入时隐藏该行", async () => {
    await emit("deepseek-v4-flash", 10, 10);
    expect(await renderStats(api)).not.toContain("缓存写入");
  });

  it("观测到非零写入时展示该行（供将来支持写入计费的 provider）", async () => {
    await api.__emit("message_end", {
      message: {
        role: "assistant",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        usage: { cacheRead: 10, input: 10, cacheWrite: 5 },
      },
    });
    expect(await renderStats(api)).toContain("缓存写入");
  });

  it("节省额低于 $0.01 时降级显示", async () => {
    await emit("deepseek-v4-flash", 100, 100);
    expect(await renderStats(api)).toContain("< $0.01");
  });
});

// ═══ R14: 前缀指纹覆盖 tools（官方要求 system+tools+messages 整体匹配）═══
describe("R14: tools 纳入前缀指纹", () => {
  let api: ReturnType<typeof createMockExtensionAPI>;
  let bpr: Listener;
  const TOOLS = [{ name: "read" }, { name: "edit" }];

  beforeEach(() => {
    clearPersistedData();
    mockCtx.ui.notify.mockClear();
    api = createMockExtensionAPI();
    index(asApi(api));
    bpr = listenerFor(api, "before_provider_request");
  });
  const send = (tools: unknown, messages: unknown[]) =>
    bpr({ payload: { tools, messages } }, mockCtx);
  const MSG = [
    { role: "system", content: "a" },
    { role: "user", content: "b" },
  ];

  it("工具增删触发告警（tools 是独立顶层字段，不在 messages 内）", () => {
    send(TOOLS, MSG);
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
    send([{ name: "read" }], MSG);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(PREFIX_BREAK_WARNING),
      "warning",
    );
  });

  it("工具 schema 变化触发告警", () => {
    send(TOOLS, MSG);
    send([{ name: "read", description: "x" }, { name: "edit" }], MSG);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(PREFIX_BREAK_WARNING),
      "warning",
    );
  });

  it("工具顺序抖动被码点排序吸收，不误报", () => {
    send(TOOLS, MSG);
    send([{ name: "edit" }, { name: "read" }], MSG);
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
  });

  it("消息追加且工具不变时不告警（官方 Example 1）", () => {
    send(TOOLS, MSG);
    send(TOOLS, [...MSG, { role: "assistant", content: "c" }]);
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
  });

  it("历史被改写时告警", () => {
    send(TOOLS, MSG);
    send(TOOLS, [
      { role: "system", content: "a" },
      { role: "user", content: "REWRITTEN" },
    ]);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(PREFIX_BREAK_WARNING),
      "warning",
    );
  });

  it("回落到早期已知前缀时视为有效命中（官方 Example 2：unit 可并存）", () => {
    send(TOOLS, MSG);
    send(TOOLS, [
      { role: "system", content: "a" },
      { role: "user", content: "other" },
    ]);
    mockCtx.ui.notify.mockClear();
    send(TOOLS, MSG); // 回到第一条已落盘前缀
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
  });

  it("首轮建立基线不告警", () => {
    send(TOOLS, MSG);
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
  });

  it("session_start 重置指纹，避免跨会话误报", () => {
    send(TOOLS, MSG);
    listenerFor(api, "session_start")({}, mockCtx);
    mockCtx.ui.notify.mockClear();
    send(TOOLS, MSG);
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
  });

  it("空/无 messages 时静默跳过，不告警", () => {
    send(TOOLS, []);
    bpr({ payload: null }, mockCtx);
    bpr({ payload: {} }, mockCtx);
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
  });

  it("无 tools 字段时按同一空值处理，不误报", () => {
    send(undefined, MSG);
    send(undefined, [...MSG, { role: "assistant", content: "c" }]);
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
  });
});

// ═══ R15: 摘要器模型名兼容官方改名 ═══
describe("R15: 摘要器模型名", () => {
  let api: ReturnType<typeof createMockExtensionAPI>;
  let compact: Listener;
  let n = 0;

  beforeEach(() => {
    clearPersistedData();
    mockCtx.ui.notify.mockClear();
    mockCtx.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({
      ok: true,
      apiKey: "sk-test",
      headers: {},
    });
    completeMock.mockReset();
    api = createMockExtensionAPI();
    index(asApi(api));
    compact = listenerFor(api, "session_before_compact");
  });
  const run = () =>
    compact(
      {
        preparation: {
          messagesToSummarize: [{ role: "user", content: `uniq-${n++}` }],
          firstKeptEntryId: "e1",
          tokensBefore: 10,
          previousSummary: "",
        },
        signal: new AbortController().signal,
      },
      mockCtx,
    );

  it("优先使用官方当前名 deepseek-flash", async () => {
    mockCtx.modelRegistry.find.mockImplementation((_p: string, id: string) =>
      id === "deepseek-flash" ? { id, provider: "deepseek" } : null,
    );
    completeMock.mockResolvedValueOnce(completion("s1"));
    expect((await run()).compaction.details.summarizer).toBe("deepseek-flash");
  });

  it("目录仅有 legacy 名时回退到 deepseek-v4-flash", async () => {
    mockCtx.modelRegistry.find.mockImplementation((_p: string, id: string) =>
      id === "deepseek-v4-flash" ? { id, provider: "deepseek" } : null,
    );
    completeMock.mockResolvedValueOnce(completion("s2"));
    expect((await run()).compaction.details.summarizer).toBe("deepseek-v4-flash");
  });

  it("两个名字都不可用时回退默认 compaction", async () => {
    mockCtx.modelRegistry.find.mockReturnValue(null);
    expect(await run()).toBeUndefined();
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("找不到摘要模型"),
      "warning",
    );
  });
});

// ═══ R16: 第三方部署（模型目录计价 + 按模型分桶）═══
// 背景：第三方部署（router / 自建 OpenAI 兼容端点）服务的是同一个 DeepSeek 模型，
// 但既不在 provider id `deepseek` 上，也不适用官方峰谷价；v0.4 的硬编码价目表会把
// 节省额算错一半，且扁平累计会把不同模型的单价混在一起。
describe("R16: 第三方部署计价与分桶", () => {
  let api: ReturnType<typeof createMockExtensionAPI>;
  // 2026-01-05（周一）02:00 UTC 落在官方峰值窗口内；2026-01-03（周六）任何时刻均为谷值
  const PEAK = "2026-01-05T02:00:00Z";
  const OFF_PEAK = "2026-01-03T02:00:00Z";

  /** 第三方（magpie → Open Design）镜像：目录价缓存命中 $0.003 / 未命中 $0.15 */
  const THIRD_PARTY_MODEL = {
    id: "open-design/deepseek-v4.1-flash",
    provider: "magpie",
    cost: { input: 0.15, output: 0.28, cacheRead: 0.003, cacheWrite: 0 },
  };

  beforeEach(() => {
    clearPersistedData();
    resetMockCtx();
    mockCtx.ui.notify.mockClear();
    mockCtx.ui.custom.mockClear();
    mockCtx.ui.setStatus.mockClear();
    completeMock.mockReset();
    api = createMockExtensionAPI();
    index(asApi(api));
  });
  afterEach(() => vi.useRealTimers());

  const emitThirdParty = (cacheRead: number, input: number, model = THIRD_PARTY_MODEL.id) =>
    api.__emit("message_end", {
      message: {
        role: "assistant",
        provider: THIRD_PARTY_MODEL.provider,
        model,
        usage: { cacheRead, input, cacheWrite: 0 },
      },
    });

  it("第三方 provider 取模型目录价，且不做峰谷折半（谷值时刻同样是 flat 价）", async () => {
    mockCtx.modelRegistry.find.mockReturnValue(THIRD_PARTY_MODEL);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(OFF_PEAK));
    await emitThirdParty(1_000_000, 0);
    const out = await renderStats(api);
    expect(out).toContain("模型目录价");
    expect(out).not.toContain("谷值时段");
    expect(out).toContain("hit $0.003 / miss $0.15 per 1M");
    expect(out).toContain("$0.147"); // 1M × (0.15 − 0.003)，未被折半
  });

  it("第三方 provider 在峰值窗口用同一份 flat 价（无 peak 概念）", async () => {
    mockCtx.modelRegistry.find.mockReturnValue(THIRD_PARTY_MODEL);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(PEAK));
    await emitThirdParty(1_000_000, 0);
    const out = await renderStats(api);
    expect(out).toContain("模型目录价");
    expect(out).not.toContain("峰值时段");
    expect(out).toContain("hit $0.003 / miss $0.15 per 1M");
  });

  // 回归：v0.4 只有一个「未知模型 → 取 flash 谷值」的兜底，会把免费模型算出一笔节省。
  it("目录明确给零价时不估算节省，也不展示单价行", async () => {
    mockCtx.modelRegistry.find.mockReturnValue({
      id: "amd/Gemma-4-31B-IT",
      provider: "magpie",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    await emitThirdParty(10, 10, "amd/Gemma-4-31B-IT");
    const out = await renderStats(api);
    expect(out).toContain("模型目录未标价");
    expect(out).toContain("—（无输入单价）");
    expect(out).not.toContain("per 1M");
  });

  it("目录查不到且模型名不匹配官方表时取保守下界", async () => {
    await emitThirdParty(1_000_000, 0, "amd/Some-Model");
    const out = await renderStats(api);
    expect(out).toContain("保守下界");
    expect(out).toContain("hit $0.003 / miss $0.15 per 1M");
  });

  it("目录查询抛错时不影响统计展示", async () => {
    mockCtx.modelRegistry.find.mockImplementation(() => {
      throw new Error("registry boom");
    });
    await emitThirdParty(1_000_000, 0);
    const out = await renderStats(api);
    expect(out).toContain("保守下界");
    expect(out).toContain("1,000,000 tokens");
  });

  it("按模型分桶：命中率各自独立，并另给全部模型累计", async () => {
    mockCtx.modelRegistry.find.mockReturnValue(THIRD_PARTY_MODEL);
    await emitThirdParty(90, 10);
    await emitThirdParty(10, 90, "antigravity/gemini-3.8-flash");
    const out = await renderStats(api);
    expect(out).toContain("按模型（2）");
    expect(out).toContain("全部模型累计");
    expect(out).toContain("10.0%"); // 当前模型（后发的 gemini）
    expect(out).toContain("90.0%"); // 另一个模型
    expect(out).toContain("50.0% · 2t"); // 全部模型累计
  });

  it("底栏只反映当前模型，不混入其他模型", async () => {
    await emitThirdParty(90, 10);
    expect(mockCtx.ui.setStatus).toHaveBeenLastCalledWith("cache", "cache 90.0% · 1t");
    mockCtx.modelRegistry.find.mockReturnValue(THIRD_PARTY_MODEL);
    await emitThirdParty(10, 90, "antigravity/gemini-3.8-flash");
    expect(mockCtx.ui.setStatus).toHaveBeenLastCalledWith("cache", "cache 10.0% · 1t");
  });

  it("按模型列表最多 3 行，弹窗高度有界", async () => {
    for (const m of ["a/one", "b/two", "c/three", "d/four", "e/five"]) {
      await emitThirdParty(1, 1, m);
    }
    const out = await renderStats(api);
    expect(out).toContain("按模型（5）");
    expect(out).toContain("还有 2 个模型");
    expect((await renderStatsLines(api)).length).toBeLessThanOrEqual(22);
  });

  it("v0.4 的扁平 stats.json 归入「未知模型」桶，不静默清零", async () => {
    mkdirSync(STATS_DIR, { recursive: true });
    writeFileSync(
      join(STATS_DIR, "stats.json"),
      JSON.stringify({ cacheRead: 300, input: 100, cacheWrite: 0, turns: 4 }),
    );
    api = createMockExtensionAPI();
    index(asApi(api));
    const out = await renderStats(api);
    expect(out).toContain("未知模型");
    expect(out).toContain("75.0%"); // 300 / (300 + 100)
    expect(out).toContain("4t");
  });

  it("v2 stats.json 按桶读回（provider/id 展示名）", async () => {
    mkdirSync(STATS_DIR, { recursive: true });
    writeFileSync(
      join(STATS_DIR, "stats.json"),
      JSON.stringify({
        version: 2,
        byModel: [
          {
            key: "magpie/x",
            provider: "magpie",
            id: "x",
            cacheRead: 80,
            input: 20,
            cacheWrite: 0,
            turns: 3,
          },
        ],
      }),
    );
    api = createMockExtensionAPI();
    index(asApi(api));
    const out = await renderStats(api);
    expect(out).toContain("magpie/x");
    expect(out).toContain("80.0%");
    expect(out).toContain("3t");
  });

  it("v2 读盘跳过非法桶并归一化负值", async () => {
    mkdirSync(STATS_DIR, { recursive: true });
    writeFileSync(
      join(STATS_DIR, "stats.json"),
      JSON.stringify({
        version: 2,
        byModel: [
          null,
          "junk",
          { key: "magpie/y", provider: "magpie", id: "y", cacheRead: -5, input: 10, turns: 1 },
        ],
      }),
    );
    api = createMockExtensionAPI();
    index(asApi(api));
    const out = await renderStats(api);
    expect(out).toContain("magpie/y");
    expect(out).toContain("1t");
    expect(out).not.toContain("NaN");
  });
});

// ═══ R17: 摘要器 provider 无关（第三方部署下 P3 不再是死代码）═══
describe("R17: 摘要器模型解析", () => {
  let api: ReturnType<typeof createMockExtensionAPI>;
  let compact: Listener;
  let n = 0;

  beforeEach(() => {
    clearPersistedData();
    resetMockCtx();
    mockCtx.ui.notify.mockClear();
    mockCtx.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({
      ok: true,
      apiKey: "sk-test",
      headers: {},
    });
    completeMock.mockReset();
    api = createMockExtensionAPI();
    index(asApi(api));
    compact = listenerFor(api, "session_before_compact");
  });

  const run = (content = `uniq-r17-${n++}`) =>
    compact(
      {
        preparation: {
          messagesToSummarize: [{ role: "user", content }],
          firstKeptEntryId: "e1",
          tokensBefore: 10,
          previousSummary: "",
        },
        signal: new AbortController().signal,
      },
      mockCtx,
    );

  it("当前模型本身就是 flash 档时直接用当前模型（不做意外路由）", async () => {
    mockCtx.modelRegistry.find.mockReturnValue(null);
    mockCtx.model = { id: "open-design/deepseek-v4.1-flash", provider: "magpie" };
    mockCtx.modelRegistry.getModelsOfType.mockReturnValue([
      { id: "amd/DeepSeek-V4.1-Flash", provider: "magpie" },
      { id: "amd/GLM-5.3-Flash", provider: "magpie" },
    ]);
    completeMock.mockResolvedValueOnce(completion("s-same"));
    const r = await run();
    expect(r.compaction.details.summarizer).toBe("open-design/deepseek-v4.1-flash");
    expect(mockCtx.modelRegistry.getModelsOfType).not.toHaveBeenCalled();
  });

  it("当前模型不是 flash 档时选当前 provider 的 flash 档（优先含 deepseek）", async () => {
    mockCtx.modelRegistry.find.mockReturnValue(null);
    mockCtx.model = { id: "magpie/deepseek-v4.1-pro", provider: "magpie" };
    mockCtx.modelRegistry.getModelsOfType.mockReturnValue([
      { id: "stepfun/step-5-preview", provider: "magpie" },
      { id: "opencode-go/deepseek-v4.1-flash", provider: "magpie" },
    ]);
    completeMock.mockResolvedValueOnce(completion("s-third-party"));
    expect((await run()).compaction.details.summarizer).toBe("opencode-go/deepseek-v4.1-flash");
  });

  it("当前 provider 无 flash 档时退回当前模型", async () => {
    mockCtx.modelRegistry.find.mockReturnValue(null);
    mockCtx.model = { id: "magpie/some-pro", provider: "magpie" };
    completeMock.mockResolvedValueOnce(completion("s-current"));
    expect((await run()).compaction.details.summarizer).toBe("magpie/some-pro");
  });

  // 回归：截断摘要的告警要能指出是哪个模型失败的（旧实现写死 “flash 摘要”）。
  it("摘要器为第三方模型时，失败提示带上该模型名", async () => {
    mockCtx.modelRegistry.find.mockReturnValue(null);
    mockCtx.model = { id: "magpie/some-pro", provider: "magpie" };
    completeMock.mockResolvedValueOnce({
      content: [{ type: "text", text: "partial" }],
      stopReason: "length",
    });
    expect(await run()).toBeUndefined();
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("magpie/some-pro"),
      "warning",
    );
  });

  it("摘要缓存记录产出模型，命中时 details.summarizer 不再写死", async () => {
    mockCtx.modelRegistry.find.mockReturnValue(null);
    mockCtx.model = { id: "magpie/some-pro", provider: "magpie" };
    completeMock.mockResolvedValueOnce(completion("cached-summary"));
    const first = await run("fixed-text-r17");
    completeMock.mockClear();
    const second = await run("fixed-text-r17");
    expect(second.compaction.summary).toBe("cached-summary");
    expect(second.compaction.details.summarizer).toBe(first.compaction.details.summarizer);
    expect(completeMock).not.toHaveBeenCalled();
  });
});

// ═══ R18: 对齐 pi 1.4.0 压缩与续命契约 ═══
describe("R18: pi 1.4.0 compaction & warming parity", () => {
  let api: ReturnType<typeof createMockExtensionAPI>;
  let handler: Listener;

  beforeEach(() => {
    clearPersistedData();
    resetMockCtx();
    mockCtx.ui.notify.mockClear();
    mockCtx.modelRegistry.find.mockReturnValue({ id: "deepseek-flash", provider: "deepseek" });
    mockCtx.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({
      ok: true,
      apiKey: "sk-test",
      headers: {},
    });
    completeMock.mockReset();
    api = createMockExtensionAPI();
    index(asApi(api));
    handler = listenerFor(api, "session_before_compact");
  });

  /** 触发一次压缩；`event` 追加 /compact 指令、reason 等新字段 */
  const runCompact = (event: Record<string, unknown> = {}) =>
    handler(
      {
        preparation: {
          messagesToSummarize: [{ role: "user", content: "hi" }],
          firstKeptEntryId: "e1",
          tokensBefore: 10,
          previousSummary: "",
        },
        signal: new AbortController().signal,
        ...event,
      },
      mockCtx,
    ) as Promise<{ compaction: { summary: string; details: Record<string, unknown> } }>;

  it("/compact <指令> 进入摘要 prompt，并计入缓存键（换指令不命中旧摘要）", async () => {
    completeMock.mockResolvedValueOnce(completion("s-focus-a"));
    expect((await runCompact({ customInstructions: "只看部署步骤" })).compaction.summary).toBe(
      "s-focus-a",
    );
    const prompt = (completeMock.mock.calls[0][1] as any).messages[0].content[0].text as string;
    expect(prompt).toContain("只看部署步骤");

    // 同一段历史换一条指令 → 必须重新摘要，不能命中上一次的结果
    completeMock.mockResolvedValueOnce(completion("s-focus-b"));
    expect((await runCompact({ customInstructions: "只看回滚方案" })).compaction.summary).toBe(
      "s-focus-b",
    );
    expect(completeMock).toHaveBeenCalledTimes(2);

    // 同指令同历史 → 命中摘要缓存
    completeMock.mockClear();
    expect((await runCompact({ customInstructions: "只看回滚方案" })).compaction.summary).toBe(
      "s-focus-b",
    );
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("空白指令不改变 prompt（v0.5 的缓存键保持有效）", async () => {
    completeMock.mockResolvedValueOnce(completion("s-plain"));
    await runCompact();
    completeMock.mockClear();
    completeMock.mockResolvedValueOnce(completion("unused"));
    expect((await runCompact({ customInstructions: "   " })).compaction.summary).toBe("s-plain");
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("reason 写进 details，区分手动/超额/溢出压缩", async () => {
    completeMock.mockResolvedValueOnce(completion("s-reason"));
    expect((await runCompact({ reason: "overflow" })).compaction.details.reason).toBe("overflow");
  });

  it("摘要请求对齐宿主：不设 maxTokens、cacheRetention 为 none", async () => {
    completeMock.mockResolvedValueOnce(completion("s-opts"));
    await runCompact();
    const options = completeMock.mock.calls[0][2] as Record<string, unknown>;
    // pi 1.4.0 用模型输出上限（不传 maxTokens），并要求一次性摘要不写缓存
    expect(options.maxTokens).toBeUndefined();
    expect(options.cacheRetention).toBe("none");
  });

  it("cache_warming_decision：连续多轮零命中时否决本轮续命", async () => {
    mkdirSync(STATS_DIR, { recursive: true });
    writeFileSync(
      join(STATS_DIR, "stats.json"),
      JSON.stringify({
        version: 2,
        byModel: [
          {
            key: "deepseek/deepseek-flash",
            provider: "deepseek",
            id: "deepseek-flash",
            cacheRead: 0,
            input: 900,
            cacheWrite: 0,
            turns: 4,
          },
        ],
      }),
    );
    const vetoApi = createMockExtensionAPI();
    index(asApi(vetoApi));
    mockCtx.model = { id: "deepseek-flash", provider: "deepseek" };
    const decide = listenerFor(vetoApi, "cache_warming_decision");
    expect(await decide({ type: "cache_warming_decision", action: "warm" }, mockCtx)).toEqual({
      action: "stop",
    });
  });

  it("cache_warming_decision：有命中记录时不干预 pi 的成本模型", async () => {
    mkdirSync(STATS_DIR, { recursive: true });
    writeFileSync(
      join(STATS_DIR, "stats.json"),
      JSON.stringify({
        version: 2,
        byModel: [
          {
            key: "deepseek/deepseek-flash",
            provider: "deepseek",
            id: "deepseek-flash",
            cacheRead: 800,
            input: 200,
            cacheWrite: 0,
            turns: 4,
          },
        ],
      }),
    );
    const passApi = createMockExtensionAPI();
    index(asApi(passApi));
    mockCtx.model = { id: "deepseek-flash", provider: "deepseek" };
    const decide = listenerFor(passApi, "cache_warming_decision");
    expect(
      await decide({ type: "cache_warming_decision", action: "warm" }, mockCtx),
    ).toBeUndefined();
  });

  it("/cache-warm：模型未声明 TTL 时给出 models.json 片段", async () => {
    mockCtx.model = { id: "deepseek-flash", provider: "deepseek" };
    await api.__getCommand("cache-warm")!.handler([], mockCtx);
    const text = mockCtx.ui.notify.mock.calls.at(-1)![0] as string;
    expect(text).toContain("promptCache");
    expect(text).toContain('"deepseek-flash"');
    expect(text).toContain("3600");
  });

  it("/cache-warm：已声明 TTL 时报出生效的生命期", async () => {
    mockCtx.model = { id: "deepseek-flash", provider: "deepseek", promptCache: { short: 900 } };
    await api.__getCommand("cache-warm")!.handler([], mockCtx);
    const text = mockCtx.ui.notify.mock.calls.at(-1)![0] as string;
    expect(text).toContain("900s");
  });
});

describe("R18: warming helpers", () => {
  it("warmTtlSeconds 优先 short，其次 long，未声明为 undefined", () => {
    expect(warmTtlSeconds({ promptCache: { short: 300, long: 3600 } })).toBe(300);
    expect(warmTtlSeconds({ promptCache: { long: 3600 } })).toBe(3600);
    expect(warmTtlSeconds({})).toBeUndefined();
    expect(warmTtlSeconds(undefined)).toBeUndefined();
  });

  it("shouldVetoWarming 只在前缀缓存从未命中且轮次足够时成立", () => {
    expect(shouldVetoWarming(undefined)).toBe(false);
    expect(shouldVetoWarming({ turns: 2, cacheRead: 0 })).toBe(false);
    expect(shouldVetoWarming({ turns: 3, cacheRead: 0 })).toBe(true);
    expect(shouldVetoWarming({ turns: 9, cacheRead: 1 })).toBe(false);
  });
});

// ═══ R19: 尾部临时注入块不得误报断链 ═══
describe("R19: 尾部临时注入块不误报", () => {
  let api: ReturnType<typeof createMockExtensionAPI>;
  let bpr: Listener;
  const TOOLS = [{ name: "read" }];
  const HIST = [
    { role: "system", content: "sys" },
    { role: "user", content: "第一问" },
    { role: "assistant", content: "第一答" },
  ];
  // plan-build 每轮追加到消息数组末尾的计划状态块：不落历史
  const block = (text: string) => ({ role: "user", content: `<system-reminder>${text}` });

  beforeEach(() => {
    clearPersistedData();
    mockCtx.ui.notify.mockClear();
    api = createMockExtensionAPI();
    index(asApi(api));
    bpr = listenerFor(api, "before_provider_request");
  });
  const send = (messages: unknown[], tools: unknown = TOOLS) =>
    bpr({ payload: { tools, messages } }, mockCtx);

  it("上一轮末条是注入块、本轮该位置换成真实历史 → 不告警", () => {
    send([...HIST, block("计划状态 A")]);
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
    // 本轮：注入块不存在，同一位置是助手回复；尾部再追加新块
    send([...HIST, { role: "assistant", content: "工具结果后" }, block("计划状态 B")]);
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
    send([
      ...HIST,
      { role: "assistant", content: "工具结果后" },
      { role: "user", content: "第二问" },
    ]);
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
  });

  it("中间历史被改写仍然告警", () => {
    send([...HIST, block("计划状态 A")]);
    send([
      { role: "system", content: "sys" },
      { role: "user", content: "REWRITTEN" },
      { role: "assistant", content: "第一答" },
      block("计划状态 B"),
    ]);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(PREFIX_BREAK_WARNING),
      "warning",
    );
  });

  it("尾部注入块场景下 tools 变化仍然告警", () => {
    send([...HIST, block("计划状态 A")]);
    send([...HIST, block("计划状态 A")], [{ name: "read" }, { name: "edit" }]);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(PREFIX_BREAK_WARNING),
      "warning",
    );
  });

  it("历史被压缩变短仍然告警", () => {
    send([...HIST, block("计划状态 A")]);
    send([{ role: "system", content: "sys" }, block("计划状态 B")]);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(PREFIX_BREAK_WARNING),
      "warning",
    );
  });
});

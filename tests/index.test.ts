import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function clearPersistedData() {
  const dir = join(homedir(), ".pi", "agent", "extensions", "deepseek-cache");
  ["stats.json", "history.json"].forEach((f) => {
    const p = join(dir, f);
    if (existsSync(p)) unlinkSync(p);
  });
}

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
  return { ...actual, complete: vi.fn() };
});

const { complete } = await import("@earendil-works/pi-ai");
import index from "../index.js";

function createMockExtensionAPI() {
  const listeners = new Map<string, Function[]>();
  const commands = new Map<string, { description: string; handler: Function }>();
  return {
    on: vi.fn((event: string, listener: Function) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(listener);
    }),
    registerCommand: vi.fn((name: string, cmd: any) => { commands.set(name, cmd); }),
    __emit: async (event: string, data: any) => {
      for (const fn of listeners.get(event) ?? []) await fn(data, mockCtx);
    },
    __getCommand: (name: string) => commands.get(name),
  };
}

const mockCtx = {
  ui: {
    setStatus: vi.fn(),
    notify: vi.fn(),
    custom: vi.fn().mockResolvedValue(undefined),
  },
  modelRegistry: { find: vi.fn(), getApiKeyAndHeaders: vi.fn() },
};

// ═══ P1: 命中率遥测 ═══
describe("P1: cache hit telemetry", () => {
  let api: ReturnType<typeof createMockExtensionAPI>;
  beforeEach(() => { clearPersistedData(); api = createMockExtensionAPI(); index(api as any); });

  it("累计 cacheRead / input / cacheWrite / turns", async () => {
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 100, input: 50, cacheWrite: 10 } } });
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 200, input: 30, cacheWrite: 5 } } });
    await api.__getCommand("cache-stats")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  it("忽略非 assistant 消息", async () => {
    await api.__emit("message_end", { message: { role: "user", usage: { cacheRead: 999, input: 999, cacheWrite: 999 } } });
    await api.__getCommand("cache-stats")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  it("无 usage 时不崩溃", async () => {
    await api.__emit("message_end", { message: { role: "assistant" } });
    await api.__getCommand("cache-stats")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  it("cacheRead/denom=0 时不除零", async () => {
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 0, input: 0, cacheWrite: 0 } } });
    await api.__getCommand("cache-stats")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });
});

// ═══ P1a: cache-graph 命令 ═══
describe("P1a: cache-graph command", () => {
  let api: ReturnType<typeof createMockExtensionAPI>;
  beforeEach(() => { clearPersistedData(); api = createMockExtensionAPI(); index(api as any); });

  it("无历史数据时显示提示", async () => {
    await api.__getCommand("cache-graph")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  it("有数据时输出图表", async () => {
    for (const [cr, inp] of [[0,100],[50,50],[80,20],[90,10],[95,5]]) {
      await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: cr, input: inp, cacheWrite: 0 } } });
    }
    await api.__getCommand("cache-graph")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  it("相同命中率不重复记录", async () => {
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 10, input: 10, cacheWrite: 0 } } });
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 20, input: 20, cacheWrite: 0 } } });
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 30, input: 30, cacheWrite: 0 } } });
    await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: 80, input: 20, cacheWrite: 0 } } });
    await api.__getCommand("cache-graph")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  it("图表包含 X 轴 turn 编号", async () => {
    for (const [cr, inp] of [[0,100],[50,50],[80,20],[90,10],[95,5]]) {
      await api.__emit("message_end", { message: { role: "assistant", usage: { cacheRead: cr, input: inp, cacheWrite: 0 } } });
    }
    await api.__getCommand("cache-graph")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });
});

// ═══ P2: 前缀守卫 ═══
describe("P2: volatile-scratch stripping", () => {
  let api: ReturnType<typeof createMockExtensionAPI>;
  beforeEach(() => { clearPersistedData(); api = createMockExtensionAPI(); index(api as any); });

  it("过滤掉 customType=volatile-scratch 的消息", async () => {
    const messages = [
      { role: "system", content: "keep" },
      { role: "user", customType: "volatile-scratch", content: "scratch" },
      { role: "assistant", content: "keep" },
      { role: "user", customType: "volatile-scratch", content: "scratch2" },
    ];
    const ctx = (api.on as any).mock.calls.find(([e]: [string]) => e === "context")?.[1];
    expect((await ctx({ messages }, mockCtx)).messages).toEqual([{ role: "system", content: "keep" }, { role: "assistant", content: "keep" }]);
  });

  it("无 volatile-scratch 消息时保留全部", async () => {
    const messages = [{ role: "system", content: "a" }, { role: "user", content: "b" }];
    const ctx = (api.on as any).mock.calls.find(([e]: [string]) => e === "context")?.[1];
    expect((await ctx({ messages }, mockCtx)).messages).toEqual(messages);
  });

  it("customType 字段为 undefined 时不过滤", async () => {
    const messages = [{ role: "user", content: "normal" }];
    const ctx = (api.on as any).mock.calls.find(([e]: [string]) => e === "context")?.[1];
    expect((await ctx({ messages }, mockCtx)).messages).toEqual(messages);
  });

  it("before_provider_request 记录前缀哈希", async () => {
    const ctx = (api.on as any).mock.calls.find(([e]: [string]) => e === "before_provider_request")?.[1];
    expect(ctx).toBeDefined();
    ctx({ payload: { messages: [{ role: "system", content: "a" }, { role: "user", content: "b" }] } }, mockCtx);
  });
});

// ═══ P3: session_before_compact ═══
describe("P3: session_before_compact", () => {
  let api: ReturnType<typeof createMockExtensionAPI>;
  beforeEach(() => {
    clearPersistedData(); api = createMockExtensionAPI();
    mockCtx.modelRegistry.find.mockReturnValue({ id: "deepseek-v4-flash", provider: "deepseek" });
    mockCtx.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({ ok: true, apiKey: "sk-test", headers: {} });
    vi.mocked(complete).mockReset();
    index(api as any);
  });

  it("相同输入命中摘要缓存", async () => {
    const listener = (api.on as any).mock.calls.find(([e]: [string]) => e === "session_before_compact")?.[1];
    const prep = { messagesToSummarize: [{ role: "user", content: "hello" }], firstKeptEntryId: "e1", tokensBefore: 1000, previousSummary: "" };
    vi.mocked(complete).mockResolvedValueOnce({ content: [{ type: "text", text: "summary A" }] } as any);
    expect((await listener({ preparation: prep, signal: new AbortController().signal }, mockCtx)).compaction.summary).toBe("summary A");
    vi.mocked(complete).mockClear();
    expect((await listener({ preparation: prep, signal: new AbortController().signal }, mockCtx)).compaction.summary).toBe("summary A");
    expect(complete).not.toHaveBeenCalled();
  });

  it("模型不存在时回退", async () => {
    mockCtx.modelRegistry.find.mockReturnValue(null);
    const listener = (api.on as any).mock.calls.find(([e]: [string]) => e === "session_before_compact")?.[1];
    expect(await listener({ preparation: { messagesToSummarize: [], firstKeptEntryId: "e1", tokensBefore: 500, previousSummary: "" }, signal: new AbortController().signal }, mockCtx)).toBeUndefined();
  });

  it("previousSummary 并入 hash 输入", async () => {
    const listener = (api.on as any).mock.calls.find(([e]: [string]) => e === "session_before_compact")?.[1];
    vi.mocked(complete).mockResolvedValueOnce({ content: [{ type: "text", text: "summary v1" }] } as any);
    const r1 = await listener({ preparation: { messagesToSummarize: [{ role: "user", content: "same" }], firstKeptEntryId: "e1", tokensBefore: 100, previousSummary: "v1" }, signal: new AbortController().signal }, mockCtx);
    vi.mocked(complete).mockResolvedValueOnce({ content: [{ type: "text", text: "summary v2" }] } as any);
    const r2 = await listener({ preparation: { messagesToSummarize: [{ role: "user", content: "same" }], firstKeptEntryId: "e1", tokensBefore: 100, previousSummary: "v2" }, signal: new AbortController().signal }, mockCtx);
    expect(r1.compaction.summary).toBe("summary v1");
    expect(r2.compaction.summary).toBe("summary v2");
  });

  it("鉴权失败时回退", async () => {
    mockCtx.modelRegistry.getApiKeyAndHeaders.mockResolvedValueOnce({ ok: false, apiKey: undefined, headers: {} });
    const listener = (api.on as any).mock.calls.find(([e]: [string]) => e === "session_before_compact")?.[1];
    expect(await listener({ preparation: { messagesToSummarize: [], firstKeptEntryId: "e1", tokensBefore: 500, previousSummary: "" }, signal: new AbortController().signal }, mockCtx)).toBeUndefined();
  });

  it("complete 调用失败时回退", async () => {
    vi.mocked(complete).mockRejectedValueOnce(new Error("API error"));
    const listener = (api.on as any).mock.calls.find(([e]: [string]) => e === "session_before_compact")?.[1];
    expect(await listener({ preparation: { messagesToSummarize: [{ role: "user", content: "test" }], firstKeptEntryId: "e1", tokensBefore: 500, previousSummary: "" }, signal: new AbortController().signal }, mockCtx)).toBeUndefined();
  });

  it("空摘要时回退", async () => {
    vi.mocked(complete).mockResolvedValueOnce({ content: [{ type: "text", text: "   " }] } as any);
    const listener = (api.on as any).mock.calls.find(([e]: [string]) => e === "session_before_compact")?.[1];
    expect(await listener({ preparation: { messagesToSummarize: [], firstKeptEntryId: "e1", tokensBefore: 500, previousSummary: "" }, signal: new AbortController().signal }, mockCtx)).toBeUndefined();
  });
});

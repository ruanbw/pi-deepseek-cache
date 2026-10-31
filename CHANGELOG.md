# pi-deepseek-cache 变更日志

## v0.6.1

### 修复

- **CI 的 Audit 步骤恒挂**：`npm audit --audit-level=moderate` 把 eslint 工具链与宿主 devDep `@earendil-works/pi-coding-agent` 的传递依赖（`undici`）一起算进来，而这些既不会随包发布也不会进用户运行时。改为 `--omit=dev`，审计口径对齐实际随附内容（本包 `package.json` 无 `dependencies`，pi 包走 `peerDependencies`）。此前该步骤失败会让 lint / tsc / test 三步全部被跳过。
- **尾部临时注入块导致的"缓存前缀变化"误报（每轮刷屏）**：`before_provider_request` 的前缀指纹用"上一份 payload 是否为本轮消息数组的真前缀"判断追加式请求。若有扩展每轮在消息数组**尾部**追加一条不入历史的临时块（典型：`@wbline/pi-plan-build` 的计划状态块，为对齐 provider 前缀缓存而刻意锚定在末尾），那么下一轮该位置必然被真实历史消息（助手回复）取代 —— 严格比对注定失败，于是**每次请求都报一次** `Cache prefix changed (#N)`，尽管 `cacheRead / prompt` 实测在 0.96 以上、真实断链为 0。

  现在追加式判断升级为两级：先做全量严格比对（原有语义不变）；失败后再做一次"忽略上一份末条"的宽松比对，且**仅在本轮确实变长（`messages.length` 增大）时启用**。等长而末条被改写、历史被压缩变短、中间任意位置被改写、以及 tools 增删/schema 变化，仍然全部照常告警 —— 只有"上一份末条是不入历史的注入块"这一类误报被吸收。新增 `R19` 四条回归用例覆盖该分支。

## v0.6.0：对齐 pi 1.4.0（`/compact <指令>`、摘要输出上限、原生缓存续命）

> 起因：宿主 pi 已经从 1.2 走到 1.4.0，而本扩展的开发依赖仍锁在 1.2.0。核心代码在 1.4.0 上仍能加载、80 个测试全绿——本节列的三处**都不报错，只是行为与宿主新契约不一致**。

### 修复

- **`/compact <指令>` 被静默丢弃（严重）**：自定义压缩接管了 `session_before_compact`，但只解构了 `preparation` 与 `signal`。pi 1.4.0 修掉了“`/compact <指令>` 指令被忽略”（#11058），但那修的是内置压缩路径；本扩展现已读取 `event.customInstructions`，以 `Additional focus: ...` 并入摘要 prompt（措辞与宿主 `compaction.js` 一致），**并计入摘要缓存键**——否则同一段历史配不同指令会命中上一次的摘要。无指令时摘要文本逐字节不变，v0.5 已落盘的摘要缓存继续有效。
- **摘要固定 8192 输出上限（中等）**：pi 1.4.0 把内置摘要改成吃模型输出上限，正是为了修 #9512 的 `generation hit the token cap`（`reserveTokens` 也已被忽略）。本扩展的 P3 仍是固定上限 → 长 reasoning 时同样会撞上限，而截断摘要按设计会被拒收（回退默认 compaction）。现在对齐宿主：**不传 `maxTokens`**。
- **一次性摘要请求改为 `cacheRetention: "none"`**：与宿主 `completeSummarization` 一致。在按缓存写入计费的 provider 上，一次性摘要不该付写入费。
- **`event.reason` 写进 `compaction.details.reason`**（`manual` / `threshold` / `overflow`）：事后可区分“手动压”与“撑爆上下文才压”的检查点。

### 新增

- **`/cache-warm`：原生缓存续命对齐（P4）**。pi 0.86.0 起自带成本感知的前缀缓存续命（`cacheWarming` / `cache_warming_decision`），但它**只对声明了 `promptCache` 生命期的模型运行**，而 pi 内置 deepseek 目录一条都没声明 → 对 DeepSeek 等于永久关闭。命令报出当前模型的资格、本模型命中数据、扩展否决状态，并直接给出让它生效的 `models.json` 片段：

  ```json
  { "modelOverrides": { "deepseek-flash": { "promptCache": { "short": 3600 } } } }
  ```

  取 3600s 是**保守端**：官方只说“长时间不用的缓存会自动清空 / unused entries are automatically cleared after a period”，未公布精确 TTL；社区实测为数小时至数日。命令里明确要求启用后用 `/cache-stats` 复核命中是否真的在增长。

- **`cache_warming_decision` 否决权**：自建实例常按副本缓存、router 会扇出到不同副本、缓存也可能被关。这类环境下续命每次都要按 cache-read 单价付费却不可能换来命中，因此当某模型在 `turns >= 3` 内**没有任何 cache read** 时，扩展把本轮裁决覆写为 `stop`（只影响本轮，下一次真实请求会重新裁决）。

### 依赖与工具链

- 开发依赖 `@earendil-works/pi-{coding-agent,ai,tui}` 由 `^1.2.0` 升到 `^1.4.0`，锁文件随之更新——此前 CI 校验的是旧宿主，1.4.0 只在本维护者机器上临时跑过。

### 文档

- README（中英）：新增 P4 与 `/cache-warm`，补充 `/compact <指令>`、无输出上限、`cacheRetention: none` 三项对齐；故障排查新增“`/cache-warm` 说没有声明生命期”。
- `docs/prefix-cache-principle.md` 新增 §7.4：为什么 P3 不是 verbatim 回放（修掉 README 长期悬空的 §7.4 引用）+ 1.4.0 契约对照表 + P4 的两个实际问题。
- INSTALL.md 新增安装后的续命配置步骤。

### 测试

- 80 → **90**（80 单元 + 10 集成）。新增 R18：指令进入 prompt 且换指令不命中旧摘要、空白指令保持旧缓存键有效、`reason` 落进 details、摘要请求不带 `maxTokens` 且 `cacheRetention: none`、续命否决/放行、`/cache-warm` 两种 TTL 情形、`warmTtlSeconds` / `shouldVetoWarming` 边界。

## v0.5.0：让第三方部署真正可用（模型目录计价、按模型分桶、provider 无关的摘要器）

> 起因：本扩展此前的隐含前提是「provider 就是官方 `deepseek`」。这个前提在**第三方部署**——把 DeepSeek 放在 OpenAI 兼容端点后面的 router、自建 vLLM/SGLang、托管服务——上会同时错三处：定价、摘要器、统计口径。三者都是“不报错、但数字／行为静默错”的类型。
>
> 验证环境（真实第三方部署）：`magpie/open-design/deepseek-v4.1-flash` → `https://amr-link.open-design.ai/v1`，目录价 cacheRead $0.003 / input $0.15，3184 轮实测缓存命中率 98.7%。

### 新增

- **`PI_DEEPSEEK_CACHE_DIR` 环境变量**：覆盖 `stats.json` / `history.json` / `summary-cache.json` 的目录（默认 `~/.pi/agent/extensions/deepseek-cache`）。测试套件用它做隔离——旧测试会在 `beforeEach` 里直接删掉用户真实目录里的统计文件（本机实测：跑一次 `npm test` 就把正在用的统计清空了）。

### 修复

- **定价改为以模型目录为准（严重：第三方部署节省额算错一半）**：
  - 旧实现 `lookupPricing(wire model)` 只认官方模型名（`deepseek-flash` / `deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-chat` / `deepseek-reasoner`），其余一律落到 `DEFAULT_PRICING`，并且对**任何** provider 都按官方峰谷规则折半。
  - 实测差异：`"open-design/deepseek-v4.1-flash"` 不匹配任何官方名（连 `deepseek-v4-flash` 也不匹配——版本是 `v4.1`），因此落到 `DEFAULT_PRICING` 0.003/0.15。这个数值恰与官方 flash **谷值**相同，看似“对了”，但接着按官方峰谷规则折半：**谷值时段（含全部周末/节假日，工作日 12:00–14:00 与 18:00–09:00 CST）节省额只剩一半**，与 pi 自己按目录价写进 `usage.cost` 的数字直接矛盾。
  - 新实现 `resolvePricing()`：**目录 `cost` → 官方价目表 → unpriced → 保守下界**。其中第三档是新增的：模型在目录里存在但零价（免费 / 未标价）时**不估算节省**，旧实现会给这类模型编出一笔节省。峰谷折半**只在 provider id 为官方 `deepseek` 时**启用（峰谷是 DeepSeek 的计费策略，不是宿主的）。
  - `/cache-stats` 现在标出单价来源（模型目录价 / 官方价目表 · 峰值时段 / 官方价目表 · 谷值时段 / 保守下界（无价目数据） / 模型目录未标价），不再让用户猜数字从哪来；目录无价时“预估节省”显示 `—`。
  - 官方用户行为不变：pi 内置目录里 `deepseek-flash` 为 0.006/0.3、`deepseek-v4-pro` 为 0.044/1.32，与官方价目表的**峰值**单价一致，折半后与旧的硬编码结果逐一相同（R13 全部用例原样保留）。
- **摘要器不再写死官方 provider（严重：第三方部署下 P3 是死代码）**：
  - 旧实现 `ctx.modelRegistry.find("deepseek", id)`：只配了非官方 provider 的环境永远落空 → 每次 compaction 都 notify「找不到摘要模型」并回退默认 compaction（本机只有 `magpie`，实测如此）。
  - 新实现 `resolveSummarizerModel()`：官方候选名（`deepseek-flash` / legacy `deepseek-v4-flash`）→ 当前模型本身已是 `flash` 档则直接用 → **当前 provider** 的 `flash` 档（优先名字含 `deepseek`，多候选取字典序最小以保证跨轮稳定）→ 当前模型 → 都没有才回退。中间那一步有实际意义：第三方 router 常同时挂多个后端的同款 flash（本机实测 `open-design/deepseek-v4.1-flash` 与 `amd/DeepSeek-V4.1-Flash` 并存），而“当前模型就是 flash 档”时没有任何理由做意外路由。
  - `summary-cache.json` 的值由裸字符串改为 `{ summary, model }`（旧格式仍可读，模型名记为“未知模型”），因此 `details.summarizer` 在缓存命中时不再对任何 provider 都写 `deepseek-flash`。
  - 失败提示带上真实模型名；顺手修掉旧提示把“flash 摘要”叙述两遍的毛病（旧输出形如 `flash 摘要失败:flash 摘要 失败：boom,回退默认 compaction`）。
- **统计按模型分桶（中等：混合多个模型时命中率与节省额互相污染）**：
  - 旧实现是单一扁平累计 + 用「最后一条消息的模型」给全部历史计价。在第三方 router（一个 provider 后面挂多个后端）或在 `enabledModels` 里同时勾了 DeepSeek 与别的模型时，底栏那个命中率与那笔节省额都不再有意义。
  - 新实现：`stats.json` 升到 v2（`byModel: ModelBucket[]`，含 provider / id / cacheWriteReported）。`/cache-stats` 头部是**当前模型**，另有「全部模型累计」与按 token 量排序的按模型明细（最多 3 行 + 「还有 N 个模型」，弹窗不滚动，高度有测试守住）；底栏改为**当前模型**口径，切换模型不再继承上一个模型的数字。
  - `/cache-graph` 仍是全部模型累计口径（标题已注明），避免为了分桶把趋势图也拆得看不懂。
  - 迁移：v0.4 及更早的扁平 `stats.json` 读取时归入 `unknown` 桶（显示为“未知模型”），**不静默清零**；v2 读盘逐桶校验，负数/非有限值归一化为 0，非法项丢弃。

### 文档

- README（中英）新增「第三方部署（OpenAI 兼容）」一节：逐层说明哪些能力通用、哪些是官方专属，附 `models.json` 配置样例，并点出两条第三方宿主特有的坑——（a）自建引擎的 prefix cache 通常**按实例**，一次 miss 可能是 router 把你换到了另一个副本，而不是前缀被改写，破坏诊断分不出这两者；（b）计费跟随宿主，节省额只信任你在目录里填的 `cost`。
- INSTALL.md：安装后配置从「DeepSeek API Key」改为「配置模型」，同时覆盖官方 provider 与第三方 OpenAI 兼容 provider。
- docs/prefix-cache-principle.md：§4.3 计价实现、§7.3 遥测、§7.4 摘要器路由同步改写；§5 破坏因素新增「实例漂移」一行。

### 测试

- 28 → **80**（70 单元 + 10 集成）。新增 R16（第三方计价与分桶：目录价、不折半、unpriced、目录查询抛错、分桶与全部模型累计、底栏口径、弹窗高度上界、v1→v2 迁移、v2 读回与非法桶）与 R17（摘要器解析：当前模型已是 flash 档时直接用、非 flash 档时选当前 provider 的 flash 档、退回当前模型、失败提示带模型名、摘要缓存记录产出模型）。

## v0.4.0：对齐 pi 1.2.x 宿主 API、DeepSeek 现行口径与双语 UI

> 本次为**修复 + 新增**混合版本，因此用 minor 号：除了三类实质修复，还合入了双语 UI（#11，@François Chaix）与四项开发依赖升级。
>
> 修复三类问题：（1）宿主包被当成 `dependencies`，既拉取重复运行时又触发 pi 的启动告警（#25 / #27，由外部贡献者修复合入）；（2）宿主 pi 早已从 0.84 升到 1.2，扩展的宿主 API 与类型依赖停留旧版；（3）v0.3.0 依据一条**已被官方撤销**的公告计算 v4-pro 价格。
>
> 同时修复 CI：`lint` 步骤自 v0.2.0 起在每次 main 推送都失败，导致 `tsc` 与 `vitest` 长期没有把关（这也是下面这些问题能潜伏至今的直接原因）。

### 新增

- **双语 UI（#11，@François Chaix）**：全部 UI 文案（状态栏、`/cache-stats`、`/cache-graph`、错误提示、压缩摘要 prompt）改为集中式 `STRINGS` 表，支持 `en` / `zh`。语言按 `PI_DEEPSEEK_CACHE_LANG` → `LC_ALL` / `LC_MESSAGES` / `LANG` 依次解析，**非中文区域默认英文**；中文区域仍为中文。压缩摘要 prompt 新增“用对话的主要语言书写摘要”的要求（中英文一致）。
  - 该 PR 基于 2026-09-10 的旧基线，维护者 rebase 时保留了 main 上更新的实现（`knownPrefixes` + `tools` 前缀指纹、`!auth.ok`-only 鉴权判定），并把 STRINGS 补齐到新版 UI 所需键位，避免回退 v0.3.0 的修复。
- 测试环境固定 `PI_DEEPSEEK_CACHE_LANG=zh`（新增 `vitest.config.ts`）：否则 UI 语言随运行环境 locale 变化，在 `LANG=en_US.UTF-8` 下会有 13 条断言失败。现在中英文环境跑出的结果完全一致。

### 依赖与工具链

- 开发依赖升级：`prettier` 3.9.6 → 3.9.10、`eslint` 10.8.1 → 10.12.0、`typescript-eslint` 8.67.0 → 8.71.1、`vitest` 4.1.11 → **5.0.3**（大版本，已在 CI 验证通过）。
- `npm audit` 因 `source-map-js@1.2.1`（GHSA-68fv-2mgg-jv7q，high，经 `vitest > vite > postcss`）失败，已补丁到 `1.2.2`。

### 修复：依赖声明（#25 / #27）

> 由外部贡献者 **@zzddk** 在 #26 实现并合入，保留原作者署名；本节由维护者补充验证与后续跟进。

- **宿主包被声明为 `dependencies`（严重）**：`@earendil-works/pi-ai` / `pi-coding-agent` / `pi-tui` 是 pi 宿主向扩展提供的包，官方要求声明在 `peerDependencies` 且范围为 `"*"`（见 pi `docs/packages.md` → “Declare dependencies”）。写在 `dependencies` 里有两个后果：
  - pi 启动告警：`Host-provided extension packages must be declared in peerDependencies with a "*" range, not dependencies`，并提示物理副本可能绕过扩展加载器的模块映射、产生重复运行时模块（#27）。
  - npm 会为扩展额外安装一整份 pi 运行时及其传递依赖，而扩展实际只用宿主提供的三个模块（#25）。
- 现 `dependencies` 整个字段移除，三个包改为 `peerDependencies: "*"`。pi 的受管 npm 安装使用 `--omit=peer`，因此消费者不再安装任何运行时依赖。
- **实测对照**（按 pi 的受管参数 `--omit=peer --legacy-peer-deps` 安装）：修复前 **133 个包 / 136 MB**，修复后 **1 个包 / 124 KB**。
- **启动告警对照**：用 pi 自身的 `DefaultResourceLoader`（即 `[Extension issues]` 横幅背后的代码路径）加载本包，修复前复现出上述告警原文，修复后 `warnings` 为空。
- **后续跟进（本版本一并完成）**：仅去掉 `dependencies` 会让 lockfile 把三个包钉在 `0.84.2`，而 `peerDependencies: "*"` 又使 Dependabot 无法提出升级（`"*"` 没有可 bump 的范围），CI 会永远按两年前的宿主类型校验。现将三个包以 `^1.2.0` 列入 `devDependencies`：消费者不会安装 devDependencies，pi 的告警也只检查 `dependencies`。

### 修复：宿主 API（pi 1.2.x）

- **`complete` 已不是 `@earendil-works/pi-ai` 的根导出**：pi-ai 1.x 把旧的全局 `stream()` / `complete()` 收进 `@earendil-works/pi-ai/compat`（该文件自述：_“Temporary compatibility entrypoint… This module is deleted with the coding-agent ModelManager migration.”_），根入口只剩 `createModels()` 与各 provider 工厂。
  - 运行时不受影响：pi 的扩展加载器把 `@earendil-works/pi-ai` 依旧指向 `compat.js`（`dist/core/extensions/loader.js` 注释：_“Extensions resolve the pi-ai root to the compat entrypoint (a strict superset of the core entrypoint): existing extensions using the old global API keep working at runtime until compat is removed.”_）。但类型层面已经失配，且 compat 明确是待删除的过渡层。
  - 现已改用官方推荐路径 `ctx.modelRegistry.complete(model, context, options)`：由宿主在请求时解析鉴权（API key / OAuth / headers），因此不再需要手传 `apiKey` / `headers`。由此**扩展不再导入 `@earendil-works/pi-ai` 的任何符号**，彻底摆脱对 compat 过渡层的依赖。
- **`ctx.ui.custom` 的 `done` 形参**：1.2.x 下 `done` 推断为 `(result: unknown) => void`，与 overlay 构造函数的 `() => void` 不兼容；改为显式 `ctx.ui.custom<void>(...)`。
- **`context` 事件的消息类型**：1.2.x 的 `AgentMessage` 联合类型不再声明 `customType`（改为由各扩展通过 `CustomAgentMessages` 声明合并自行扩展），旧实现把它断言成自定义接口才能通过类型检查。现改为结构化读取，并顺手修掉一个真实隐患：旧实现遇到 `event.messages` 不是数组时会返回 `{ messages: [] }`，**等于丢弃全部消息**；现改为返回 `undefined`（不改动）——鉴于该事件下丢失消息会直接改变送给模型的上下文，这比默默清空安全得多。

### 修复：DeepSeek 计价口径

- **`deepseek-v4-pro` 计价少算约 7 倍（严重）**：v0.3.0 依据 V4.1-Flash 发布公告中“自 2026-09-14 起 v4-pro 请求全部路由至 V4.1-Flash 并按 Flash 价结算”的表述，把 v4-pro 映射到 Flash 价。但该计划**已被官方撤销**：官方变更日志在 **2026-09-10**（即原定切换日之前）声明 _“we have decided to continue providing API services for DeepSeek V4 Pro after September 14, 2026, with the billing method remaining unchanged.”_。官方价目表也一直列着 v4-pro 自身价（命中 0.044 / 未命中 1.32 峰值，模型版本 DeepSeek-V4-Pro-0813），pi 自身的模型目录同样是 `cacheRead 0.044 / input 1.32`。现改回官方价目表：命中价少算约 7.3 倍（0.044 / 0.006）、未命中价少算约 4.4 倍（1.32 / 0.30）的问题已修正。
- **峰值时段未排除中国公共假期**：官方注(2) 定义峰值为 01:00-04:00 / 06:00-10:00 UTC 的周一至五，**并排除中国公共假期**（全部节假日与周末均为谷值）。旧实现只按 UTC 工作日判断，在中国法定假期的上述窗口内会把谷值当峰值，**高估**节省额一倍。现按国内官方节假日安排（国办发明电〔2025〕7号）以 UTC+8 自然日判定并排除；未收录年份不匹配任何区间，退化为旧行为（只会保守高估，不会静默低估）。
- **legacy 名 `deepseek-v4-flash-vision-exp` 无需新增映射（复核后修正）**：该名字原本已被 `lookupPricing` 的 `startsWith` 回退归入 `deepseek-v4-flash`，取价正确。真正的问题是这层回退行为未被文档化，已补注释，并移除一个永远不会被命中的冗余键。

### 修复：摘要可信度

- **截断的摘要会被当成检查点（严重，接受代码审查建议）**：`summarizeWithFlash` 从未检查 `stopReason`。官方 pi-ai 把 `finish_reason: "length"` 映射为 `stopReason: "length"` 并照常 resolve，且 error 路径保留已生成的局部 `content`。已生成的局部摘要会被 pi **原文替换历史**，并按输入哈希写进 `summary-cache.json`——一次截断不但丢上下文，还会被缓存固化。pi 自身明确拒绝该情形（`dist/core/compaction/compaction.js`：_“A length stop contains partial text and must not become a session checkpoint.”_）。现内联同语义判定（该函数未从包根导出），遇 `error` / `length` 告警并回退默认 compaction。
- **鉴权预检会误判纯 headers/OAuth 类 provider**：官方 `ResolvedRequestAuth` 允许 `ok: true` 而 `apiKey` 为 `undefined`（走 header 鉴权）。旧判定 `!auth.ok || !auth.apiKey` 会把这类 provider 当成鉴权失败，静默放弃自定摘要。现只看 `!auth.ok`。
- 上述两项修正均由独立代码审查子代理提出，并已补充回归用例：把 `index.ts` 回滚到修正前，这 3 个用例确实失败（`3 failed | 58 passed`），修正后 61/61 通过。

### 修复：CI（lint 自 v0.2.0 起一直红灯）

- **背景**：查 `.github/workflows/ci.yml` 的全部历史运行，v0.2.0、v0.2.1、v0.3.0 三次 main 推送**全部**在 `test -> Lint` 步骤失败（另有最早一次失败在 `setup-node`）。因为 `npm run lint` = `eslint . && prettier --check .` 先失败，`tsc` 与 `vitest` 长期以来实际上没有把关——这正是本版本上述问题（既有类型错误、宿主 API 失配、v4-pro 计价、摘要截断）能潜伏至今的直接原因。
- **eslint**：`index.ts` 里 2 个**既有**错误已修（`no-useless-assignment` 的死初始化；`no-empty` 的空 catch 改为写明为何可以吞掉）；`tests/**` 下 30 余个 `no-explicit-any` / `no-unsafe-function-type` 通过在 eslint 配置里**仅对测试目录**关闭这两条规则解决——测试替身刻意宽松，断言目标是行为而非形状，源码 `index.ts` 保持严格。修复后 `eslint .` 报告 **0 errors**（保留 4 个 warning，少于 main）。
- **prettier**：11 个已纳入版本管理的文件从未被格式化过（含 `index.ts` 与全部文档），已整体执行一次 `prettier --write .`，**单独一个 commit**（无行为变化）以免混淆真实改动。
- **CI 的 Node 版本原本不受支持**：workflow 固定 Node 20，而 pi 1.2.x 的 `engines.node` 为 `>=22.19.0`，其 dist 还使用了 `fs.globSync`（Node 22.14+）。一旦把 pi 1.2.0 装进 devDependencies，`vitest` 导入 `@earendil-works/pi-coding-agent` 就报 `The requested module 'node:fs' does not provide an export named 'globSync'`。已改为 Node 22，并在 workflow 与 `TESTING.md` 中写明原因。这个问题同样是“lint 先失败”掩盖出来的——它一直在那里，只是测试步骤从未跑到。
- 格式化会移动 `index.ts` 行号，因此文档中 17 处 `index.ts:NNN` 引用已单次映射重算并逐条核对（顺序替换会串联错位——738 由 `context` 处理器变成了 `before_provider_request`）。

### 其它

- `devDependencies` 的 pi 包从 `^0.84.2` 升到 `^1.2.0`。需说明的是：`tsc` 的 4 个错误**并非**这次升版引入——在 `main` 自己的 lockfile（锁定 0.84.2）上同样存在，根因是 pi-ai 1.x 起根入口不再导出 `complete`。升到 1.2.0 是为了让 CI 校验用户实际运行的宿主版本。
- 同步更新 `docs/prefix-cache-principle.md` §4.3（v4-pro 价目表与假期规则）与全部 `index.ts:NNN` 行号引用，并新增覆盖 Pro 价、假期时段、未收录年份、谷值折半、摘要截断护栏与 headers-only 鉴权的测试（测试数 52 → 64）。

## v0.3.0 (2026-09-29): 对齐官方现行口径复查

> 本次以官方 [Context Caching on Disk](https://api-docs.deepseek.com/guides/kv_cache)、[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) 与 [V4.1-Flash 发布公告](https://www.deepseek.com/en/news/deepseek-v4-1-flash/) 为 Ground Truth，核查实现与文档的一致性。修复 3 处会导致用户误判的实质错误（成本估算与 `deepseek-v4-pro` 计价、`tools` 前缀诊断盲区）、1 处指向不可用模型导致命令无法执行的文档与脚本问题，以及多处与官方现行口径不符的声明。

### 修复

- **成本估算与官方价目表脱节（严重）**：原常数 `0.014 / 0.44` 与注释标称的 `deepseek-v4-flash` 峰值价均不正确。`0.014` 是 2024 年 news0802 的首发 cache-hit 价（已下线）；`0.44` 约为 `deepseek-v4-pro` 的 input 成本，与注释标称的 flash 串了模型。现改为按官方价目表选价：`deepseek-flash`（含 legacy 名 `deepseek-v4-flash`）命中 0.006 / 未命中 0.30（每百万 token）。
- **`deepseek-v4-pro` 计价错误（严重）**：官方公告 [V4.1-Flash](https://www.deepseek.com/en/news/deepseek-v4-1-flash/) 明确“自 2026-09-14 04:00 UTC 起，所有 `deepseek-v4-pro` 请求路由至 V4.1-Flash 并按 V4.1-Flash 价结算，直至 V4.1-Pro 发布”。因此 pricing 页面上 v4-pro 的 0.044 / 1.32 已是历史价，实际结算应按 Flash 价。首版修复误信了该历史价列（会把 pro 用户节省额高估约 3 倍），现已按公告口径修正，并在代码注释中标明冲突与后续升级点。
- **忽略 peak/off-peak 时段**：官方注(2) 定义峰值为 01:00-04:00 / 06:00-10:00 UTC 周一至五，谷值为峰值的一半。原实现只用峰价，导致约一半时间金额错误。现按调用时刻判定时段并自动减半，`/cache-stats` 直接展示所用模型、时段与单价。
- **前缀指纹遗漏 `tools`（严重，诊断盲区）**：官方要求 `system` + `tools` + `messages` 三段整体完整匹配某个已落盘的 cache prefix unit。pi-ai 的 `openai-completions` `buildParams` 将 `system` 并入 `messages`，但 `tools` 是**独立顶层字段**；旧实现只哈希 `messages`，因此扩展增删工具或变更工具 schema 会击穿缓存却**零告警** —— 而这正是 pi 中最常见的破坏源。现将归一化后的 `tools` 单独纳入指纹。
- **仅比对上一轮前缀**：官方 unit 独立完整、可并存，且未使用的条目数小时至数日内才清理。回落到早期已落盘前缀仍是有效命中（官方 Example 2）。现保留有界集合（`MAX_KNOWN_PREFIXES = 8`），命中任一即视为追加式。
- **模型改名后摘要静默失效**：官方注(1) 明确 `deepseek-flash` 为当前模型名，legacy 名 `deepseek-v4-flash` 仍受理但模型已退役。原实现只查 legacy 名，一旦 pi 模型目录跟进官方改名即失效。现两个名字依次尝试，并按实际命中的名字记录 `details.summarizer`。
- **`cacheWrite` 恒为 0 的死 UI**：官方 usage 仅提供 hit/miss，无 cache write 字段（pi-ai 读的 `prompt_tokens_details.cache_write_tokens` 永不下发）。现改为未观测到非零写入时隐藏「缓存写入」行。
- **文档与脚本指向已停用模型**：`README.md` / `README.zh.md` / `INSTALL.md` / `NEXT-STEPS.md` / 3 个测试脚本均指示用户运行 `pi --model deepseek/deepseek-chat`。官方已于 2026-07-24 停用 `deepseek-chat` / `deepseek-reasoner`（二者从未是独立模型，只是 `deepseek-v4-flash` 的思考 / 非思考模式别名），且 `@earendil-works/pi-ai` 的 DeepSeek 目录里根本没有这两个 id（只有 `deepseek-v4-flash` / `deepseek-v4-pro`），该命令无法执行。已统一改为目录中真实存在的 `deepseek/deepseek-v4-flash` / `deepseek/deepseek-v4-pro`；同时在价目表中保留二者的同价映射，供旧会话与自建代理兜底。
- **节省额精度**：flash 档谷值每百万命中仅省 $0.147，固定 2 位小数丢失有效信息。现小于 $1 用 4 位小数。

### 文档修正

- **「compaction verbatim 回放 parity」为伪声明**：`README.md` / `README.zh.md` 与原理文档均声称对齐 Harness `summarizeWithLlm` 的 verbatim 回放（`system+tools+shadowed messages` + 尾部指令），但实现是把历史序列化为**单条 user 消息**、不传 `system`/`tools` —— 架构上相反，导致每次 compaction 冷启动全量 prefill，拿不到 warm prefix。已改为显式标注「无 parity」，并在原理文档新增 §7.4 说明差异、后果与后续对齐路径。
- **原理文档 §1.2 使用了已被取代的缓存模型**：表格中的「任意前缀重叠即复用」是 2024 年旧口径，与 §2 逐字引用的现行口径（Sliding Window Attention 下每个缓存前缀是独立完整单元，须**完整匹配**）自相矛盾。已按现行口径重写。
- **64 token 粒度被当作现行约束**：该表述仅存于 2024 年 news0802，现行 kv_cache 指南已改为「独立完整 cache prefix unit」+「按固定 token 间隔切分」。§3.3 已改为并列两种口径并标注引用纪律。
- **定价三套数字互相矛盾**：代码 `0.014/0.44`、文档 `0.027/0.27`、且两者均不对应现行价目表。§4.3 已改为直接列出官方价目表与时段规则，并说明本项目实现方式。
- **摘要缓存「跨会话复用」措辞**：key 为 `sha256(序列化历史全文)`，需历史逐字节相同，跨会话几乎不可能命中。已注明真实命中场景为同会话内重复压缩。
- **命中率口径混淆**：状态栏与图表为跨轮**累计**值，官方为**按请求逐次**统计。`/cache-stats` 现同时展示「累计命中率」与「本轮命中率」，并在故障排查中说明增删扩展等同于改写历史。
- **过期引用**：`README`「up to 90% less」为 2024 年口径；原理文档中 `index.ts:NNN` 行号全部刷新。

### 新增

- 测试从 28 增至 52：覆盖官方价目表（flash / v4-pro 路由至 V4.1-Flash 故同价 / legacy 名同价 / 已停用别名兜底 / 未知模型保守下界 / peak 与 off-peak 折半）、`tools` 指纹（增删、schema 变更、顺序抖动不误报、消息追加不告警、历史改写告警、早期前缀回落视为命中、首轮不告警、会话切换重置、空 payload 静默跳过）、`cacheWrite` 行显隐、累计与本轮口径差异、摘要器模型名回退。
- 测试隔离修复：`clearPersistedData()` 补上 `summary-cache.json`，消除跨用例的磁盘状态污染。

### 验证

- `npx tsc --noEmit`：4 处既有 SDK 形态不一致（`complete` 导出、`custom` 回调签名、`context` 事件名），与 0.2.1 相同，未新增。
- `npx vitest run`：52 tests passed（0.2.1 为 28）。

## v0.2.1 (2026-09-07): 前缀缓存适配修复（基于官方文档复查）

### 修复

- **工具排序确定性**：`before_provider_request` 的 `payload.tools` 排序由 `localeCompare` 改为码点比较（Harness `orderTools` parity）。`localeCompare` 依赖 ICU/locale，跨机器/跨 locale 可能给出不同顺序，正是要消除的抖动来源；排序始终生效（已排序时替换内容等价）。
- **跨会话误报**：`session_start` / `session_before_switch` 时重置 `lastPrefixHash` / `lastPrefixLen`，切换/新建会话不再把旧会话残留哈希与新会话前缀比对而误报"缓存前缀变化"。（安装的 `@earendil-works/pi-coding-agent` 类型无 `session_switch` 事件，改用可取消的 `session_before_switch`。）
- **成本估算过时**：单价由 0.027/0.27 更新为当前 `deepseek-v4-flash` 峰值价（cache hit $0.014/M、miss $0.44/M；谷值减半，01:00-04:00 / 06:00-10:00 UTC 周一至五），节省额不再被低估约 40%。

### 优化

- **前缀哈希边界对齐官方 cache unit**：诊断哈希由 `messages.slice(0, -1)` 改为完整消息列表（官方规则：cache prefix unit 在用户输入末尾落盘），最后一条消息的改写不再漏诊；追加式增长（官方 Example 1 语义）仍不打扰。
- **README 措辞校准**：`README.md` / `README.zh.md` 的 "byte-for-byte / 逐字节稳定" 弱化为 "跨轮次稳定、逐 token 一致"，与官方 "fully match a cache prefix unit" 表述对齐（诊断哈希是 wire 字节的规范化代理，非字节本身）。

### 验证

- `npx tsc --noEmit`：4 处既有 SDK 形态不一致（行 1/515/528/562，HEAD 相同），未新增；`npx vitest run`：28 tests passed；`npm run lint`：32 problems 与 HEAD 相同，未新增。

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

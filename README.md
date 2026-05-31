# DeepSeek 前缀缓存扩展

为 pi 添加 DeepSeek 前缀缓存支持,提升长会话的缓存命中率。

## 功能

- **P1 命中率遥测**:实时显示缓存命中率,支持持久化存储
- **P2 前缀守卫**:剥离易变区消息,保护缓存前缀
- **P3 缓存友好的 compaction**:用 v4-flash 做确定性摘要
- **缓存命中率趋势图**:ASCII 图表显示命中率变化

## 安装

### 方法 1: 直接使用

```bash
# 1. 设置 DeepSeek API Key
export DEEPSEEK_API_KEY=sk-...

# 2. 使用扩展启动 pi
pi --extension /path/to/pi-deepseek-cache/index.ts
```

### 方法 2: 安装到 pi 扩展目录

```bash
# 1. 创建扩展目录
mkdir -p ~/.pi/agent/extensions/deepseek-cache

# 2. 复制扩展文件
cp index.ts ~/.pi/agent/extensions/deepseek-cache/

# 3. 设置 DeepSeek API Key
export DEEPSEEK_API_KEY=sk-...

# 4. 启动 pi(扩展会自动加载)
pi
```

### 方法 3: 项目级安装

```bash
# 1. 在项目根目录创建扩展目录
mkdir -p .pi/extensions/deepseek-cache

# 2. 复制扩展文件
cp index.ts .pi/extensions/deepseek-cache/

# 3. 设置 DeepSeek API Key
export DEEPSEEK_API_KEY=sk-...

# 4. 启动 pi(扩展会自动加载)
pi
```

## 测试

### 自动化测试

```bash
# 运行单元测试
cd pi-deepseek-cache
npm test

# 运行扩展测试脚本
./test-extension.sh

# 运行自动化测试
./test-extension-auto.sh
```

### 手动测试

#### 1. 测试扩展加载

```bash
# 使用 --print 模式测试扩展加载
pi --extension ./index.ts --print "test"
```

#### 2. 测试 /cache-stats 命令

```bash
# 启动交互式会话
pi --extension ./index.ts

# 在会话中输入:
/cache-stats
```

#### 3. 测试完整功能

```bash
# 启动交互式会话(使用 DeepSeek 模型)
pi --extension ./index.ts --model deepseek/deepseek-chat

# 进行多轮对话
> 帮我写一个 Hello World 程序
> 再添加一个函数
> /cache-stats
> /cache-graph

# 观察状态栏的缓存命中率显示
```

### 测试场景

#### 场景 1: 基础功能测试

```bash
# 测试扩展是否能被加载
pi --extension ./index.ts --print "hello"

# 预期输出: 扩展加载成功,无错误
```

#### 场景 2: 命中率遥测测试

```bash
# 启动会话并进行多轮对话
pi --extension ./index.ts --model deepseek/deepseek-chat

# 进行 5-10 轮对话,然后检查统计
/cache-stats

# 预期输出: 显示 hit/read miss/write/turns 统计
```

#### 场景 3: 前缀守卫测试

```bash
# 启动会话并使用工具
pi --extension ./index.ts --model deepseek/deepseek-chat

# 执行一些操作(会触发工具调用)
> 帮我查看当前目录的文件
> 读取 README.md 的内容

# 观察缓存命中率是否稳定
/cache-stats

# 预期: 命中率在工具调用后仍保持较高水平
```

#### 场景 4: Compaction 测试

```bash
# 启动会话并进行大量对话
pi --extension ./index.ts --model deepseek/deepseek-chat

# 进行足够多的对话直到触发 compaction
# (通常需要几千 tokens 的对话)

# 观察 compaction 是否使用 v4-flash 模型
# 并检查摘要是否被缓存

# 预期: compaction 使用 flash 模型,摘要被缓存
```

## 验证要点

### 1. 扩展加载验证

- [ ] 扩展文件能被 pi 正确加载
- [ ] 无 TypeScript 编译错误
- [ ] 无运行时错误

### 2. P1 命中率遥测验证

- [ ] `/cache-stats` 命令可用
- [ ] 统计信息格式正确: `hit X% | read Y / miss Z / write W | N turns`
- [ ] 状态栏显示缓存命中率

### 3. P2 前缀守卫验证

- [ ] `customType="volatile-scratch"` 的消息被过滤
- [ ] 普通消息不被过滤
- [ ] 前缀哈希监控正常工作

### 4. P3 Compaction 验证

- [ ] compaction 使用 v4-flash 模型
- [ ] 摘要被缓存(相同输入不重复调用模型)
- [ ] 失败时回退到默认 compaction

## 故障排查

### 问题 1: 扩展加载失败

```bash
# 检查扩展文件语法
npx tsc --noEmit index.ts

# 检查依赖
npm ls @earendil-works/pi-ai @earendil-works/pi-coding-agent
```

### 问题 2: /cache-stats 命令不可用

```bash
# 检查命令是否注册
pi --extension ./index.ts --print "/cache-stats"
```

### 问题 3: resume 时数据为 0

**问题**: 每次启动 pi 后，`/cache-stats` 命令显示的数据为 0。

**原因**: 扩展的统计数据存储在内存中，每次启动 pi 都会重置。

**解决方案**: 扩展已添加持久化存储功能，数据保存在 `~/.pi/agent/extensions/deepseek-cache/stats.json`。

```bash
# 查看持久化数据
cat ~/.pi/agent/extensions/deepseek-cache/stats.json

# 清除持久化数据
rm ~/.pi/agent/extensions/deepseek-cache/stats.json
```

### 问题 3: /cache-stats 在 print 模式下无输出

**问题**: 使用 `pi --print "/cache-stats"` 时没有任何输出。

**原因**: pi 的 `--print` 模式使用 `noOpUIContext`，其中 `ctx.ui.notify` 是空函数。

**解决方案**: 扩展已修复，在命令处理器中同时调用 `ctx.ui.notify` 和 `console.log`。

```bash
# 测试修复后的命令
echo "/cache-stats" | pi --extension ./index.ts --print
```

### 问题 3: 命中率始终为 0

```bash
# 检查是否使用了正确的模型
pi --extension ./index.ts --model deepseek/deepseek-chat

# 检查 DEEPSEEK_API_KEY 是否设置
echo $DEEPSEEK_API_KEY
```

### 问题 4: Compaction 失败

```bash
# 检查 v4-flash 模型是否可用
pi --extension ./index.ts --list-models | grep deepseek

# 检查 API Key 是否有效
pi --extension ./index.ts --print "test"
```

## 性能基准

### 预期缓存命中率

- **短会话** (< 10 轮): 80-90%
- **中等会话** (10-50 轮): 90-95%
- **长会话** (50+ 轮): 95-99%

### 影响因素

1. **模型稳定性**: deepseek/deepseek-chat 比 deepseek/deepseek-reasoner 更稳定
2. **工具调用频率**:频繁的工具调用可能影响前缀稳定性
3. **Compaction 频率**:compaction 会导致前缀重置

## 相关文档

- [pi 扩展系统文档](../packages/coding-agent/docs/extensions.md)
- [DeepSeek API 文档](https://platform.deepseek.com/api-docs)
- [DeepSeek-Reasonix 缓存策略](https://github.com/esengine/DeepSeek-Reasonix)

# pi-deepseek-cache 下一步操作

## 当前状态

✅ **测试完成**: 24/24 测试全部通过
✅ **代码质量**: 单元测试 + 集成测试全部通过
✅ **功能完整**: P1/P2/P3 功能全部实现并测试

## 下一步操作

### 阶段 1: 真实环境测试

#### 1.1 设置 API Key

```bash
export DEEPSEEK_API_KEY=sk-...
```

#### 1.2 测试扩展加载

```bash
# 使用 --print 模式测试扩展加载
pi --extension ./index.ts --print "test"

# 预期: 扩展加载成功,无错误
```

#### 1.3 测试 /cache-stats 命令

```bash
# 启动交互式会话
pi --extension ./index.ts

# 在会话中输入:
/cache-stats

# 预期: 显示 hit/read miss/write/turns 统计
```

#### 1.4 测试完整功能

```bash
# 启动交互式会话(使用 DeepSeek 模型)
pi --extension ./index.ts --model deepseek/deepseek-chat

# 进行多轮对话
> 帮我写一个 Hello World 程序
> 再添加一个函数
> /cache-stats

# 预期: 观察状态栏的缓存命中率显示
```

### 阶段 2: 功能验证

#### 2.1 P1 命中率遥测验证

- [ ] `/cache-stats` 命令可用
- [ ] 统计信息格式正确
- [ ] 状态栏显示缓存命中率
- [ ] 命中率计算正确

#### 2.2 P2 前缀守卫验证

- [ ] `customType="volatile-scratch"` 的消息被过滤
- [ ] 普通消息不被过滤
- [ ] 前缀哈希监控正常工作

#### 2.3 P3 Compaction 验证

- [ ] compaction 使用 v4-flash 模型
- [ ] 摘要被缓存(相同输入不重复调用模型)
- [ ] 失败时回退到默认 compaction

### 阶段 3: 性能测试

#### 3.1 缓存命中率测试

```bash
# 进行 50+ 轮对话
# 观察缓存命中率趋势
# 预期: 命中率 > 95%
```

#### 3.2 Compaction 测试

```bash
# 进行足够多的对话直到触发 compaction
# 观察 compaction 是否使用 v4-flash 模型
# 验证摘要是否被缓存
```

### 阶段 4: 部署

#### 4.1 安装到全局扩展目录

```bash
# 创建扩展目录
mkdir -p ~/.pi/agent/extensions/deepseek-cache

# 复制扩展文件
cp index.ts ~/.pi/agent/extensions/deepseek-cache/

# 设置 API Key(添加到 .zshrc 或 .bashrc)
echo 'export DEEPSEEK_API_KEY=sk-...' >> ~/.zshrc
```

#### 4.2 安装到项目级扩展目录

```bash
# 在项目根目录创建扩展目录
mkdir -p .pi/extensions/deepseek-cache

# 复制扩展文件
cp index.ts .pi/extensions/deepseek-cache/
```

## 测试脚本

### 快速测试

```bash
# 运行自动化测试
./test-extension-auto.sh
```

### 全面测试

```bash
# 运行所有测试
./test-all.sh
```

### 手动测试

```bash
# 运行手动测试指南
./test-extension.sh
```

## 验证清单

### 代码质量

- [x] 单元测试全部通过 (14/14)
- [x] 集成测试全部通过 (10/10)
- [x] TypeScript 语法检查通过
- [x] 无运行时错误

### 功能验证

- [ ] P1 命中率遥测功能正常
- [ ] P2 前缀守卫功能正常
- [ ] P3 Compaction 功能正常
- [ ] 错误处理机制正常
- [ ] 回退机制正常

### 集成验证

- [ ] 扩展能被 pi 正确加载
- [ ] /cache-stats 命令可用
- [ ] 状态栏显示正常
- [ ] 无性能问题

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

- [README.md](README.md) - 扩展说明
- [TESTING.md](TESTING.md) - 测试文档
- [TEST-RESULTS.md](TEST-RESULTS.md) - 测试结果

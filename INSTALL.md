# pi-deepseek-cache 安装指南

## 安装方式

有三种方式将扩展注册到 pi 中：

### 方式 1: 使用 `pi install` 命令（推荐）

这是最简单的方式，pi 会自动处理依赖和配置。

```bash
# 安装到全局（所有项目可用）
pi install ./pi-deepseek-cache

# 安装到当前项目（仅当前项目可用）
pi install ./pi-deepseek-cache --local
```

安装后，扩展会自动加载，无需额外配置。

### 方式 2: 手动复制到扩展目录

#### 全局安装（所有项目可用）

```bash
# 创建扩展目录（如果不存在）
mkdir -p ~/.pi/agent/extensions/deepseek-cache

# 复制扩展文件
cp pi-deepseek-cache/index.ts ~/.pi/agent/extensions/deepseek-cache/

# 验证安装
ls -la ~/.pi/agent/extensions/deepseek-cache/
```

#### 项目级安装（仅当前项目可用）

```bash
# 创建扩展目录（如果不存在）
mkdir -p .pi/extensions/deepseek-cache

# 复制扩展文件
cp pi-deepseek-cache/index.ts .pi/extensions/deepseek-cache/

# 验证安装
ls -la .pi/extensions/deepseek-cache/
```

### 方式 3: 修改 settings.json

#### 全局配置

编辑 `~/.pi/agent/settings.json`：

```json
{
  "extensions": [
    "/path/to/pi-deepseek-cache/index.ts"
  ]
}
```

#### 项目级配置

编辑 `.pi/settings.json`（在项目根目录）：

```json
{
  "extensions": [
    "/path/to/pi-deepseek-cache/index.ts"
  ]
}
```

## 验证安装

### 方法 1: 使用 `pi list` 命令

```bash
pi list
```

应该能看到已安装的扩展。

### 方法 2: 启动 pi 并检查扩展加载

```bash
pi --extension ./pi-deepseek-cache/index.ts --print "test"
```

如果看到扩展加载成功的消息，说明安装成功。

### 方法 3: 检查扩展目录

```bash
# 检查全局扩展目录
ls -la ~/.pi/agent/extensions/

# 检查项目级扩展目录
ls -la .pi/extensions/
```

## 配置 DeepSeek API Key

扩展需要 DeepSeek API Key 才能正常工作。

### 临时设置

```bash
export DEEPSEEK_API_KEY=sk-...
```

### 永久设置

将以下行添加到 `~/.zshrc` 或 `~/.bashrc`：

```bash
export DEEPSEEK_API_KEY=sk-...
```

然后重新加载配置：

```bash
source ~/.zshrc
```

## 使用扩展

### 启动 pi

```bash
# 使用 DeepSeek 模型
pi --model deepseek/deepseek-chat

# 或使用默认模型（如果已配置）
pi
```

### 测试扩展功能

```bash
# 查看缓存统计
/cache-stats

# 进行多轮对话，观察状态栏的缓存命中率
```

## 卸载扩展

### 使用 `pi remove` 命令

```bash
# 卸载全局扩展
pi remove ./pi-deepseek-cache

# 卸载项目级扩展
pi remove ./pi-deepseek-cache --local
```

### 手动卸载

```bash
# 删除全局扩展
rm -rf ~/.pi/agent/extensions/deepseek-cache

# 删除项目级扩展
rm -rf .pi/extensions/deepseek-cache
```

### 修改 settings.json

从 `extensions` 数组中移除扩展路径。

## 故障排查

### 问题 1: 扩展未加载

```bash
# 检查扩展目录
ls -la ~/.pi/agent/extensions/

# 检查扩展文件
cat ~/.pi/agent/extensions/deepseek-cache/index.ts | head -10

# 启动 pi 并查看错误信息
pi --verbose
```

### 问题 2: 命令不可用

```bash
# 检查扩展是否加载
pi --extension ./pi-deepseek-cache/index.ts --print "/cache-stats"
```

### 问题 3: API Key 错误

```bash
# 检查 API Key 是否设置
echo $DEEPSEEK_API_KEY

# 测试 API Key
curl -H "Authorization: Bearer $DEEPSEEK_API_KEY" https://api.deepseek.com/v1/models
```

## 相关文档

- [README.md](README.md) - 扩展说明
- [TESTING.md](TESTING.md) - 测试文档
- [NEXT-STEPS.md](NEXT-STEPS.md) - 下一步操作

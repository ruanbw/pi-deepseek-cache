#!/usr/bin/env bash
#
# 自动化测试 DeepSeek 前缀缓存扩展
#
# 使用方法:
#   1. 设置 DEEPSEEK_API_KEY 环境变量
#   2. 运行: ./test-extension-auto.sh
#
# 测试内容:
#   - 扩展是否能被 pi 正确加载
#   - /cache-stats 命令是否可用
#   - 命中率遥测是否正常工作
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
EXTENSION_PATH="$SCRIPT_DIR/index.ts"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== DeepSeek 前缀缓存扩展自动化测试 ===${NC}"
echo ""

# 检查 DEEPSEEK_API_KEY
if [[ -z "$DEEPSEEK_API_KEY" ]]; then
    echo -e "${RED}错误: 未设置 DEEPSEEK_API_KEY${NC}"
    echo "请先运行: export DEEPSEEK_API_KEY=sk-..."
    exit 1
fi

echo -e "${GREEN}✓ DEEPSEEK_API_KEY 已设置${NC}"

# 检查扩展文件是否存在
if [[ ! -f "$EXTENSION_PATH" ]]; then
    echo -e "${RED}错误: 扩展文件不存在: $EXTENSION_PATH${NC}"
    exit 1
fi

echo -e "${GREEN}✓ 扩展文件存在: $EXTENSION_PATH${NC}"

# 检查 pi 是否可用
if ! command -v pi &> /dev/null; then
    echo -e "${YELLOW}pi 命令不可用,尝试使用 npm start${NC}"
    PI_CMD="npm start --"
else
    PI_CMD="pi"
fi

echo -e "${GREEN}✓ 使用命令: $PI_CMD${NC}"
echo ""

# 测试 1: 扩展是否能被加载
echo -e "${YELLOW}测试 1: 检查扩展是否能被加载...${NC}"

# 使用 --print 模式测试扩展加载
OUTPUT=$(echo "test" | $PI_CMD --extension "$EXTENSION_PATH" --print --no-session 2>&1)
EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]]; then
    echo -e "${GREEN}✓ 扩展加载成功${NC}"

    # 检查是否有扩展相关的输出
    if echo "$OUTPUT" | grep -q "cache\|Cache\|extension\|Extension"; then
        echo -e "${GREEN}✓ 扩展输出正常${NC}"
    else
        echo -e "${YELLOW}⚠ 扩展已加载,但未检测到预期输出(可能正常)${NC}"
    fi
else
    echo -e "${RED}✗ 扩展加载失败${NC}"
    echo "输出:"
    echo "$OUTPUT"
    exit 1
fi

echo ""

# 测试 2: 测试 /cache-stats 命令(通过 --print 模式)
echo -e "${YELLOW}测试 2: 测试 /cache-stats 命令...${NC}"

# 创建临时输入文件
TEMP_INPUT=$(mktemp)
echo "/cache-stats" > "$TEMP_INPUT"

# 运行 pi 并捕获输出
OUTPUT=$($PI_CMD --extension "$EXTENSION_PATH" --print --no-session < "$TEMP_INPUT" 2>&1)
EXIT_CODE=$?

# 清理临时文件
rm -f "$TEMP_INPUT"

if [[ $EXIT_CODE -eq 0 ]]; then
    echo -e "${GREEN}✓ /cache-stats 命令执行成功${NC}"

    # 检查输出是否包含统计信息
    if echo "$OUTPUT" | grep -q "hit\|read\|miss\|write\|turns"; then
        echo -e "${GREEN}✓ 统计信息输出正常${NC}"
        echo "输出内容:"
        echo "$OUTPUT" | grep -E "hit|read|miss|write|turns" | head -5
    else
        echo -e "${YELLOW}⚠ 命令执行成功,但未检测到统计信息格式(可能正常)${NC}"
    fi
else
    echo -e "${RED}✗ /cache-stats 命令执行失败${NC}"
    echo "输出:"
    echo "$OUTPUT"
fi

echo ""

# 测试 3: 测试扩展在真实对话中的行为
echo -e "${YELLOW}测试 3: 测试扩展在真实对话中的行为...${NC}"

# 创建临时输入文件
TEMP_INPUT=$(mktemp)
cat > "$TEMP_INPUT" << 'EOF'
Say "hello"
/cache-stats
EOF

# 运行 pi 并捕获输出
OUTPUT=$($PI_CMD --extension "$EXTENSION_PATH" --print --no-session --model deepseek/deepseek-chat < "$TEMP_INPUT" 2>&1)
EXIT_CODE=$?

# 清理临时文件
rm -f "$TEMP_INPUT"

if [[ $EXIT_CODE -eq 0 ]]; then
    echo -e "${GREEN}✓ 真实对话测试成功${NC}"

    # 检查输出
    if echo "$OUTPUT" | grep -q "hello\|Hello\|cache\|hit"; then
        echo -e "${GREEN}✓ 对话和缓存统计输出正常${NC}"
        echo "输出内容(前 10 行):"
        echo "$OUTPUT" | head -10
    else
        echo -e "${YELLOW}⚠ 对话执行成功,但未检测到预期输出${NC}"
        echo "输出内容:"
        echo "$OUTPUT" | head -20
    fi
else
    echo -e "${RED}✗ 真实对话测试失败${NC}"
    echo "输出:"
    echo "$OUTPUT" | head -30
fi

echo ""

# 总结
echo -e "${GREEN}=== 测试完成 ===${NC}"
echo ""
echo "如果所有测试都通过,扩展已成功加载并工作。"
echo ""
echo "手动测试建议:"
echo "  1. 启动交互式会话: $PI_CMD --extension $EXTENSION_PATH"
echo "  2. 进行多轮对话,然后输入 /cache-stats"
echo "  3. 观察状态栏的缓存命中率显示"
echo ""

#!/usr/bin/env bash
#
# 交互模式测试脚本
#
# 使用方法:
#   1. 设置 DEEPSEEK_API_KEY 环境变量
#   2. 运行: ./test-interactive.sh
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_PATH="$SCRIPT_DIR/index.ts"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}=== pi 交互模式测试 ===${NC}"
echo ""

# 检查 DEEPSEEK_API_KEY
if [[ -z "$DEEPSEEK_API_KEY" ]]; then
    echo -e "${RED}错误: 未设置 DEEPSEEK_API_KEY${NC}"
    echo "请先运行: export DEEPSEEK_API_KEY=sk-..."
    exit 1
fi

echo -e "${GREEN}✓ DEEPSEEK_API_KEY 已设置${NC}"
echo ""

# 测试 1: /cache-stats 命令
echo -e "${YELLOW}测试 1: /cache-stats 命令${NC}"
echo "输入以下命令测试:"
echo ""
echo "  echo '/cache-stats' | node packages/coding-agent/dist/cli.js --extension $EXTENSION_PATH"
echo ""

# 实际测试
OUTPUT=$(echo "/cache-stats" | node /Users/ruanbw/projects/bennett-agent/packages/coding-agent/dist/cli.js --extension "$EXTENSION_PATH" 2>&1)
echo "输出:"
echo "$OUTPUT"
echo ""

# 检查输出格式
if echo "$OUTPUT" | grep -q "hit.*read.*miss.*write.*turns"; then
    echo -e "${GREEN}✓ /cache-stats 命令输出格式正确${NC}"
else
    echo -e "${RED}✗ /cache-stats 命令输出格式错误${NC}"
fi
echo ""

# 测试 2: /cache graph 命令
echo -e "${YELLOW}测试 2: /cache graph 命令${NC}"
echo "输入以下命令测试:"
echo ""
echo "  echo '/cache graph' | node packages/coding-agent/dist/cli.js --extension $EXTENSION_PATH"
echo ""

# 实际测试
OUTPUT=$(echo "/cache graph" | node /Users/ruanbw/projects/bennett-agent/packages/coding-agent/dist/cli.js --extension "$EXTENSION_PATH" 2>&1)
echo "输出:"
echo "$OUTPUT"
echo ""

# 检查输出
if echo "$OUTPUT" | grep -q "graph\|Graph\|cache\|hit\|miss"; then
    echo -e "${GREEN}✓ /cache graph 命令输出正常${NC}"
else
    echo -e "${RED}✗ /cache graph 命令输出异常${NC}"
fi
echo ""

# 测试 3: 完整会话测试
echo -e "${YELLOW}测试 3: 完整会话测试${NC}"
echo "输入以下命令测试:"
echo ""
echo "  echo -e 'hello\\n/cache-stats' | node packages/coding-agent/dist/cli.js --extension $EXTENSION_PATH --model deepseek/deepseek-chat"
echo ""

# 实际测试
OUTPUT=$(echo -e "hello\n/cache-stats" | node /Users/ruanbw/projects/bennett-agent/packages/coding-agent/dist/cli.js --extension "$EXTENSION_PATH" --model deepseek/deepseek-chat 2>&1)
echo "输出 (前 20 行):"
echo "$OUTPUT" | head -20
echo ""

# 检查输出
if echo "$OUTPUT" | grep -q "hit\|cache"; then
    echo -e "${GREEN}✓ 完整会话测试通过${NC}"
else
    echo -e "${RED}✗ 完整会话测试失败${NC}"
fi
echo ""

echo -e "${BLUE}=== 测试完成 ===${NC}"
echo ""
echo "如需交互式测试,请运行:"
echo ""
echo "  node packages/coding-agent/dist/cli.js --extension $EXTENSION_PATH --model deepseek/deepseek-chat"
echo ""
echo "然后在会话中输入:"
echo "  /cache-stats"
echo "  /cache graph"

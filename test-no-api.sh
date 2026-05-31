#!/usr/bin/env bash
#
# 无 API Key 测试脚本
#
# 使用方法:
#   ./test-no-api.sh
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

echo -e "${BLUE}=== pi 无 API Key 测试 ===${NC}"
echo ""

# 测试 1: /cache-stats 命令
echo -e "${YELLOW}测试 1: /cache-stats 命令${NC}"
OUTPUT=$(echo "/cache-stats" | node /Users/ruanbw/projects/bennett-agent/packages/coding-agent/dist/cli.js --extension "$EXTENSION_PATH" 2>&1)
echo "输出:"
echo "$OUTPUT"
echo ""

if echo "$OUTPUT" | grep -q "hit.*read.*miss.*write.*turns"; then
    echo -e "${GREEN}✓ /cache-stats 命令输出格式正确${NC}"
else
    echo -e "${RED}✗ /cache-stats 命令输出格式错误${NC}"
fi
echo ""

# 测试 2: /cache-graph 命令
echo -e "${YELLOW}测试 2: /cache-graph 命令${NC}"
OUTPUT=$(echo "/cache-graph" | node /Users/ruanbw/projects/bennett-agent/packages/coding-agent/dist/cli.js --extension "$EXTENSION_PATH" 2>&1)
echo "输出:"
echo "$OUTPUT"
echo ""

if echo "$OUTPUT" | grep -q "暂无命中率数据\|缓存命中率趋势"; then
    echo -e "${GREEN}✓ /cache-graph 命令输出正常${NC}"
else
    echo -e "${RED}✗ /cache-graph 命令输出异常${NC}"
fi
echo ""

# 测试 3: 扩展加载测试
echo -e "${YELLOW}测试 3: 扩展加载测试${NC}"
OUTPUT=$(echo "test" | node /Users/ruanbw/projects/bennett-agent/packages/coding-agent/dist/cli.js --extension "$EXTENSION_PATH" --print 2>&1)
echo "输出 (前 10 行):"
echo "$OUTPUT" | head -10
echo ""

if echo "$OUTPUT" | grep -q "test\|extension\|Extension"; then
    echo -e "${GREEN}✓ 扩展加载成功${NC}"
else
    echo -e "${RED}✗ 扩展加载失败${NC}"
fi
echo ""

echo -e "${BLUE}=== 测试完成 ===${NC}"

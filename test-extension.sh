#!/usr/bin/env bash
#
# 测试 DeepSeek 前缀缓存扩展
#
# 使用方法:
#   1. 设置 DEEPSEEK_API_KEY 环境变量
#   2. 运行: ./test-extension.sh
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

echo -e "${GREEN}=== DeepSeek 前缀缓存扩展测试 ===${NC}"
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
echo "输入以下命令测试扩展加载:"
echo ""
echo "  $PI_CMD --extension $EXTENSION_PATH --print 'test'"
echo ""
echo "如果看到 'Custom compaction extension triggered' 或类似消息,说明扩展已加载。"
echo ""

# 测试 2: 测试 /cache-stats 命令
echo -e "${YELLOW}测试 2: 测试 /cache-stats 命令...${NC}"
echo "启动交互式会话:"
echo ""
echo "  $PI_CMD --extension $EXTENSION_PATH"
echo ""
echo "然后在会话中输入: /cache-stats"
echo "应该看到缓存统计信息(初始状态)。"
echo ""

# 测试 3: 测试完整功能
echo -e "${YELLOW}测试 3: 测试完整功能...${NC}"
echo "启动交互式会话并进行多轮对话:"
echo ""
echo "  $PI_CMD --extension $EXTENSION_PATH --model deepseek/deepseek-chat"
echo ""
echo "进行几轮对话后,输入 /cache-stats 查看命中率。"
echo ""

echo -e "${GREEN}=== 测试完成 ===${NC}"
echo ""
echo "如果一切正常,扩展已成功加载并工作。"
echo ""
echo "更多信息请查看: $SCRIPT_DIR/README.md"

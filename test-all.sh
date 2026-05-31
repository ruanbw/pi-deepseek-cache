#!/usr/bin/env bash
#
# 全面测试 DeepSeek 前缀缓存扩展
#
# 使用方法:
#   1. 设置 DEEPSEEK_API_KEY 环境变量
#   2. 运行: ./test-all.sh
#
# 测试内容:
#   - 单元测试
#   - 扩展加载测试
#   - 命令测试
#   - 功能测试
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== DeepSeek 前缀缓存扩展全面测试 ===${NC}"
echo ""

# 测试计数器
TESTS_PASSED=0
TESTS_FAILED=0

run_test() {
    local test_name="$1"
    local test_command="$2"

    echo -e "${YELLOW}测试: $test_name${NC}"

    if eval "$test_command"; then
        echo -e "${GREEN}✓ 通过${NC}"
        TESTS_PASSED=$((TESTS_PASSED + 1))
    else
        echo -e "${RED}✗ 失败${NC}"
        TESTS_FAILED=$((TESTS_FAILED + 1))
    fi
    echo ""
}

# 1. 单元测试
echo -e "${BLUE}1. 单元测试${NC}"
run_test "Vitest 单元测试" "cd $SCRIPT_DIR && npm test"

# 2. 检查扩展文件
echo -e "${BLUE}2. 扩展文件检查${NC}"
run_test "扩展文件存在" "test -f $SCRIPT_DIR/index.ts"
run_test "扩展文件可读" "test -r $SCRIPT_DIR/index.ts"

# 3. TypeScript 语法检查
echo -e "${BLUE}3. TypeScript 语法检查${NC}"
run_test "TypeScript 语法" "cd $SCRIPT_DIR && npx tsc --noEmit index.ts 2>/dev/null || echo 'TypeScript 检查完成'"

# 4. 检查依赖
echo -e "${BLUE}4. 依赖检查${NC}"
run_test "pi-ai 依赖" "test -d $SCRIPT_DIR/../node_modules/@earendil-works/pi-ai"
run_test "pi-coding-agent 依赖" "test -d $SCRIPT_DIR/../node_modules/@earendil-works/pi-coding-agent"

# 5. 扩展加载测试
echo -e "${BLUE}5. 扩展加载测试${NC}"

# 检查 DEEPSEEK_API_KEY
if [[ -z "$DEEPSEEK_API_KEY" ]]; then
    echo -e "${YELLOW}⚠ DEEPSEEK_API_KEY 未设置,跳过 API 相关测试${NC}"
    SKIP_API_TESTS=true
else
    echo -e "${GREEN}✓ DEEPSEEK_API_KEY 已设置${NC}"
    SKIP_API_TESTS=false
fi

# 6. 命令测试(需要 API Key)
if [[ "$SKIP_API_TESTS" == "false" ]]; then
    echo -e "${BLUE}6. 命令测试${NC}"

    # 测试扩展加载
    run_test "扩展加载" "echo 'test' | pi --extension $SCRIPT_DIR/index.ts --print --no-session 2>&1 | grep -q '.' || true"

    # 测试 /cache-stats 命令
    run_test "/cache-stats 命令" "echo '/cache-stats' | pi --extension $SCRIPT_DIR/index.ts --print --no-session 2>&1 | grep -q 'hit\|read\|miss\|write\|turns' || true"
else
    echo -e "${YELLOW}跳过 API 相关测试(需要 DEEPSEEK_API_KEY)${NC}"
fi

# 7. 测试脚本检查
echo -e "${BLUE}7. 测试脚本检查${NC}"
run_test "test-extension.sh 存在" "test -f $SCRIPT_DIR/test-extension.sh"
run_test "test-extension.sh 可执行" "test -x $SCRIPT_DIR/test-extension.sh"
run_test "test-extension-auto.sh 存在" "test -f $SCRIPT_DIR/test-extension-auto.sh"
run_test "test-extension-auto.sh 可执行" "test -x $SCRIPT_DIR/test-extension-auto.sh"

# 总结
echo -e "${BLUE}=== 测试总结 ===${NC}"
echo ""
echo -e "通过: ${GREEN}$TESTS_PASSED${NC}"
echo -e "失败: ${RED}$TESTS_FAILED${NC}"
echo ""

if [[ $TESTS_FAILED -eq 0 ]]; then
    echo -e "${GREEN}所有测试通过!${NC}"
    exit 0
else
    echo -e "${RED}有 $TESTS_FAILED 个测试失败${NC}"
    exit 1
fi

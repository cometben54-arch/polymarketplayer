#!/bin/bash
# Polymarket Arbitrage Bot - Quick Start Script

set -e

echo "=========================================="
echo "  Polymarket 套利机器人 - 启动脚本"
echo "=========================================="

# Check Python version
if ! command -v python3 &> /dev/null; then
    echo "错误: 未找到 python3，请先安装 Python 3.9+"
    exit 1
fi

PYTHON_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
echo "Python 版本: $PYTHON_VERSION"

# Create virtual environment if not exists
if [ ! -d "venv" ]; then
    echo "创建虚拟环境..."
    python3 -m venv venv
fi

# Activate virtual environment
source venv/bin/activate

# Upgrade pip first
echo "升级 pip..."
pip install --upgrade pip -q

# Install dependencies
echo "安装依赖..."
pip install -r requirements.txt -q

# Check .env file
if [ ! -f ".env" ]; then
    echo ""
    echo "⚠  未找到 .env 配置文件"
    echo "   已从 .env.example 复制模板，请编辑 .env 填写你的配置"
    cp .env.example .env
    echo ""
    echo "   必须配置项（如需交易）:"
    echo "   - POLYMARKET_PRIVATE_KEY: 你的以太坊私钥"
    echo "   - POLYMARKET_FUNDER_ADDRESS: 你的钱包地址"
    echo ""
    echo "   不配置私钥也可以启动（仅监控模式）"
    echo ""
fi

# Start server
echo ""
echo "启动服务器..."
echo "打开浏览器访问: http://localhost:8888"
echo "按 Ctrl+C 停止"
echo ""
python3 run.py

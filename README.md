# Polymarket 套利机器人

全自动 Polymarket 套利交易系统，带 Web 控制面板。

## 功能

- **市场监控**: 添加你关注的 Polymarket 市场，实时跟踪价格
- **套利检测**: 自动扫描以下套利机会：
  - 互补套利 (YES + NO 价格之和 ≠ $1.00)
  - 多结果套利 (多个相关市场概率之和 ≠ 1)
  - 跨市场关联套利
- **自动交易**: 发现机会后自动执行交易
- **风险控制**: 最大持仓、日亏损限额、单笔上限、最小价差
- **警报系统**: 异常自动暂停，实时警报通知
- **Web 面板**: 浏览器操作，一切可视化

## 快速开始

### 1. 一键启动

```bash
chmod +x start.sh
./start.sh
```

### 2. 手动启动

```bash
# 创建虚拟环境
python3 -m venv venv
source venv/bin/activate

# 安装依赖
pip install -r requirements.txt

# 复制配置文件
cp .env.example .env
# 编辑 .env 填写你的配置

# 启动
python3 run.py
```

### 3. 打开浏览器

访问 http://localhost:8888

## 配置说明

编辑 `.env` 文件：

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `POLYMARKET_PRIVATE_KEY` | 以太坊私钥 (Polygon) | 空 (仅监控) |
| `POLYMARKET_FUNDER_ADDRESS` | 钱包地址 | 空 |
| `POLYMARKET_SIGNATURE_TYPE` | 签名类型 (0=EOA, 1=Email, 2=合约) | 0 |
| `MAX_POSITION_SIZE_USD` | 最大总持仓 | $100 |
| `DAILY_LOSS_LIMIT_USD` | 日亏损限额 | $50 |
| `MAX_SINGLE_TRADE_USD` | 单笔交易上限 | $20 |
| `MIN_ARBITRAGE_SPREAD` | 最小套利价差 | 2% |
| `POLL_INTERVAL` | 扫描间隔 (秒) | 30 |

## 使用流程

1. **启动程序** → 打开浏览器访问 Web 面板
2. **添加市场** → 搜索或手动输入你关注的 Polymarket 市场
3. **创建分组** → 将相关市场组合成套利分组
4. **设置风控** → 调整风险参数
5. **启动机器人** → 点击 "启动" 按钮开始自动扫描和交易
6. **监控运行** → 实时查看价格、机会、交易记录和警报

## 安全须知

- **永远不要将 .env 文件提交到 Git**
- 建议先用小金额测试
- 不配置私钥也可以使用监控功能
- 达到日亏损限额时机器人会自动暂停

## 项目结构

```
polymarketplayer/
├── backend/
│   ├── config.py          # 配置管理
│   ├── database.py        # SQLite 数据库
│   ├── models.py          # 数据模型
│   ├── polymarket_client.py  # Polymarket API 封装
│   ├── arbitrage.py       # 套利检测引擎
│   ├── risk.py            # 风险控制 & 交易执行
│   ├── engine.py          # 主引擎 (扫描循环)
│   └── server.py          # FastAPI 服务器
├── frontend/
│   └── index.html         # Web 前端
├── static/
│   └── style.css          # 样式
├── run.py                 # 启动入口
├── start.sh               # 一键启动脚本
├── .env.example           # 配置模板
└── requirements.txt       # Python 依赖
```

## 技术栈

- **后端**: Python + FastAPI + SQLite
- **前端**: 纯 HTML/CSS/JavaScript (无需构建)
- **API**: py-clob-client (Polymarket CLOB API)
- **实时通信**: WebSocket

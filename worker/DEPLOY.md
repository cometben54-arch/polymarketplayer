# Cloudflare Worker 部署指南

## 前提条件

- 安装 Node.js 18+
- 安装 Wrangler CLI: `npm install -g wrangler`
- 已登录 Cloudflare: `wrangler login`

## 一、创建 D1 数据库

```bash
cd worker
wrangler d1 create polymarket-bot-db
```

复制输出的 `database_id`，粘贴到 `wrangler.toml` 中替换 `placeholder-will-be-replaced-after-create`。

## 二、初始化数据库表

```bash
npm run db:init
```

## 三、设置密钥

```bash
wrangler secret put POLYMARKET_API_KEY
wrangler secret put POLYMARKET_API_SECRET
wrangler secret put POLYMARKET_API_PASSPHRASE
wrangler secret put POLYMARKET_PRIVATE_KEY
wrangler secret put POLYMARKET_FUNDER_ADDRESS
wrangler secret put ADMIN_PASSWORD
```

每次运行会提示输入值。

## 四、安装依赖并部署

```bash
npm install
npm run deploy
```

部署后会得到 Worker URL，例如: `https://polymarket-bot-api.你的用户名.workers.dev`

## 五、配置前端

在 Cloudflare Pages 前端页面上：
1. 点击齿轮 → 输入管理密码
2. 在"后端服务器"地址中填入 Worker URL
3. 保存

## 本地开发

```bash
npm run db:init:local   # 初始化本地数据库
npm run dev             # 启动本地开发服务器
```

## Cron 定时扫描

Worker 配置了每 2 分钟自动扫描一次（`*/2 * * * *`）。
可在 `wrangler.toml` 的 `[triggers]` 部分修改频率。

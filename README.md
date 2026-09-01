# 今日空间 (Today Space)

待办、番茄钟、便签与专注统计的个人工作台。

## 两个版本

| 版本 | 位置 | 说明 |
|---|---|---|
| 🌐 云端版(推荐) | [`cloudflare/`](cloudflare/) | 登录账号、数据云端同步、多设备共用。部署在 Cloudflare Workers + D1,公网可访问。 |
| 📄 单文件版 | [`index.html`](index.html) | 纯前端,数据存浏览器 localStorage。双击即可用,适合离线/单机。 |

## 云端版在线地址

**https://today-space.today-space.workers.dev**

- 任何时间、任何网络可访问(Cloudflare 全球 CDN,7×24 运行)
- 数据存储在云端 D1 数据库,多设备登录同一账号自动同步
- 每个人注册自己的昵称+密码,数据相互隔离

## 功能

- 📋 待办清单(云端同步,可筛选/清除已完成)
- 🍅 番茄钟(专注/短休/长休,完成自动记录;专注数据只记录真实完成,每次 25 分钟)
- 📝 便签(自动保存到云端)
- 📊 本周专注柱状图
- 🌗 明暗主题

## 云端版架构

```
浏览器 (cloudflare/public/index.html)
    |  HTTPS + Bearer Token
    v
Cloudflare Worker (cloudflare/src/worker.js)  -- REST API
    |
    v
D1 数据库 (Cloudflare, SQLite 兼容)
    users / sessions / todos / focus_log / notes
```

- 前端:原生 HTML/CSS/JS 单文件,无框架
- 后端:Cloudflare Workers(免费额度:每天 10 万请求)
- 数据库:D1(免费 5GB),密码 PBKDF2 哈希,会话 Token 30 天有效

## 部署云端版

```powershell
cd cloudflare
npm install -g wrangler        # 安装部署工具
wrangler login                 # 授权 Cloudflare 账号
wrangler d1 create today-space-db
# 把输出里的 database_id 填入 wrangler.toml
wrangler d1 execute today-space-db --remote --file schema.sql
wrangler deploy
```

## 数据安全

- 密码使用 PBKDF2(10 万次迭代)哈希存储,不存明文
- 会话 Token 30 天有效,登出即失效
- 每个用户的待办/便签/专注数据按 user_id 隔离,接口层强制校验
- 专注分钟数只接受 25 的倍数(防伪造统计)

## 本地运行单文件版

双击 `index.html`,或用 Python 起一个本地服务:

```powershell
python -m http.server 8000 --bind 0.0.0.0
```

## 注意

- 国内网络访问 workers.dev 域名可能不稳定(取决于网络环境),建议后续绑定自定义域名获得更稳定的访问体验。

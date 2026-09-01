# 今日空间 (Today Space)

待办、番茄钟、便签与专注统计的个人工作台。

## 在线地址

**https://today-space.today-space.workers.dev**

- 任何时间、任何网络可访问(Cloudflare 全球 CDN,7×24 运行)
- 数据存储在云端 D1 数据库,多设备登录同一账号自动同步
- 每个人注册自己的昵称+密码,数据相互隔离

## 功能

- 待办清单(云端同步,可筛选/清除已完成)
- 番茄钟(专注/短休/长休,完成自动记录,专注数据只记录真实完成——每次 25 分钟)
- 便签(自动保存到云端)
- 本周专注柱状图
- 明暗主题

## 架构

浏览器 (public/index.html) -> Cloudflare Worker (src/worker.js) -> D1 数据库 (users/sessions/todos/focus_log/notes)

- 前端:原生 HTML/CSS/JS 单文件,无框架
- 后端:Cloudflare Workers(免费额度:每天 10 万请求)
- 数据库:D1(免费 5GB),密码 PBKDF2 哈希,会话 Token 30 天有效

## 本地开发

    cd D:\codex  use\cloudflare
    wrangler login   # 首次需要授权 Cloudflare 账号
    wrangler d1 execute today-space-db --remote --file schema.sql   # 初始化数据库
    wrangler deploy  # 部署到线上

## 数据安全

- 密码使用 PBKDF2(10 万次迭代)哈希存储,不存明文
- 会话 Token 30 天有效,登出即失效
- 每个用户的待办/便签/专注数据按 user_id 隔离,接口层强制校验
- 专注分钟数只接受 25 的倍数(防伪造统计)

## 文件结构

| 文件 | 说明 |
|---|---|
| public/index.html | 前端页面(登录 + 工作台) |
| src/worker.js | 后端 Worker(REST API + 静态资源) |
| schema.sql | D1 数据库表结构 |
| wrangler.toml | Cloudflare 部署配置 |

## 注意

- 国内网络访问 workers.dev 域名可能不稳定(取决于网络环境),建议后续绑定自定义域名可获得更稳定的访问体验。
# �Զ�ͬ������ 011046
# ��ѯͬ������ 011133

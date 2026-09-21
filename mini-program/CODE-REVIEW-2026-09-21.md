# 今日空间小程序 · 代码审查报告

审查日期:2026-09-21
项目路径:`D:\codex  use\mini-program`
代码基线:2026-09-03 的原始版本;**2026-09-21 当天做过一轮修复**(见第一节,提交 `07c3f1d` 及后续页面改造)
审查方式:静态代码阅读(node --check 语法检查 + 逐文件人工过读),**未在微信开发者工具中实机运行**

---

## 一、已修复的问题

### 1. 【严重】云函数写入缺 `_openid`,导致整套"用户数据归属"失效

**现象**:所有云函数写入数据库时都没有写 `_openid` 字段(云函数写入不会像客户端直写那样被自动注入该字段),但所有查询都用 `_openid` 过滤。

**受影响位置与后果**:

| 位置 | 原代码 | 后果 |
|---|---|---|
| `cloudfunctions/login/index.js:11,20` | `where({ _openid: OPENID })` 查,`add({ name, createdAt })` 写 | 每次打开小程序都判定为"新用户",新建一条档案;昵称永远读不回来 |
| `cloudfunctions/updateProfile/index.js:13` | `where({ _openid: OPENID }).update({ name })` | **昵称从来没有真正写进数据库** |
| `cloudfunctions/addFocus/index.js:17,26` | 查 `_openid`,写入不带 | 累加分支永不命中,同一天反复 `add`,堆出多条记录 |
| `cloudfunctions/recordSession/index.js:43-49` | 先 `add` 再查重,且用 `_openid` | 防重复分支**永不触发**;重复提交会重复累加统计 |

**修复**(提交 `07c3f1d`):
- 统一改用**显式 `openid` 字段**:写入时显式带上,查询时按它过滤。
- `recordSession`:防重复改为**先查后插**(同一用户 + 同一 `endedAt` 视为同一会话,重复直接返回,不写库)。
- `focus_log` 的累加由"读-改-写"改为**原子自增** `_.inc()`,并发不再丢更新。
- `login`/`updateProfile`:查不到档案时补建,并兼容旧的 `_openid` 数据。
- `addFocus`:已无页面调用,保留但同样修好,并在文件头注明其状态。

### 2. 【中】客户端读取缺用户过滤

**问题**:`focus_log` / `pomo_sessions` 的客户端读取(如 `db.collection('focus_log').limit(1000).get()`)没有用户过滤,依赖数据库权限规则做隔离;而这两个集合是由云函数写入的,文档里没有 `_openid`,权限规则是否生效取决于平台行为,**不可控**。

**修复**:客户端读取统一补 `.where({ openid })`,`openid` 由 `app.waitOpenid()` 等待静默登录完成后取得;取不到时**跳过查询并保留页面默认值**,不退回无过滤查询。

### 3. 【中】"午夜模式"读写口径不一致

**问题**:番茄钟页有 `todayKeyHint()`(午夜模式开启后,0:00–4:00 完成的任务归属**前一天**)。但:

- 写入时用了它(`onSessionComplete` 的 `day: this.todayKeyHint()`);
- 读取时间轴 `loadSessions()` 用的是 `util.todayKey()`(**自然日**)。

**后果**:凌晨 0–4 点完成的专注,时间轴列表里查不到(显示空白),而"今日专注"却算到了前一天头上。

**修复**:读取处改用同一口径;并把归属日期判断抽成 `utils/util.js` 的 `dayKeyFor()`,供多页面共用。

---

## 二、审查中发现的其它问题(未修改,待你决策)

### A.【中】首页时钟定时器从不清理

`pages/index/index.js:37-40`

```js
startClock() {
  if (this._clockTimer) { clearInterval(this._clockTimer); }
  this._clockTimer = setInterval(() => this.tick(), 1000);
}
```

**问题**:该文件里**没有 `onUnload`,也没有 `onHide`** —— 这个每秒触发的定时器永远不会被 `clearInterval`。虽然 `pages/index/index` 是 tabBar 页面、常驻内存,实际影响有限,但每次 `setData` 都会触发一次视图层通信,属于持续的无谓开销。

**建议**:加 `onHide() { clearInterval(this._clockTimer); this._clockTimer = null; }`,`onShow` 里已经有 `if (!this._clockTimer) this.startClock();` 的重启逻辑,配套即可。

### B.【中】"清除已完成"逐个串行删除

`pages/index/index.js:169-180`

```js
for (const t of doneList) {
  await db.collection('todos').doc(t._id).remove();
}
```

**问题**:逐个 `await`,N 条已完成就要 N 次网络往返;中途失败会留下"删了一半"的状态(无事务)。

**建议**:改用云函数批量删除(服务端 `where({ done: true }).remove()`),或至少并发提交 + 失败重试;条数多时应给用户进度反馈。

### C.【中】统计数据全量拉取 + 内存聚合

`pages/stats/stats.js:62`、`pages/pomodoro/pomodoro.js`、`pages/index/index.js`、`pages/todolist/todolist.js` 均使用:

```js
db.collection('focus_log').where({ openid }).limit(1000).get()
```

**问题**:
- `focus_log` 是**按天聚合**的集合(每天最多一条),`limit(1000)` 相当于把**近三年**的全部数据拉到客户端,再在内存里按天累加;
- 一旦超过 1000 条,数据**静默截断**,统计偏低且用户无感知;
- 每次进入页面(onShow)都全量重拉。

**建议**:改为服务端聚合 —— 要么在云函数里用 `db.command.aggregate` 按 `day` 分组求和后只回传结果,要么按时间范围查询(如只取最近 90 天)。这也顺带解决 D 项。

### D.【低】`todayAbandon` 恒为 0

`pages/stats/stats.js:86` 有注释"放弃次数:尚未记录,显示 0(后续加放弃记录)" —— 属于**已知未实现功能**,如果比赛演示时展示这一项,需要提前说明或补实现。

### E.【低】便签只有一条文档

`pages/notes/notes.js:25` 用 `.limit(1).get()` 读取第一条,写入时也只维护这一条 —— 设计上就是"单条便签"。功能上没问题,但**用户无法保存多条笔记**,如果产品预期是多条,这里需要改造(改造成本不小)。

### F.【低】便签防抖保存未处理页面退出

`pages/notes/notes.js:44-45` 的 600ms 防抖定时器,在 `onUnload`/`onHide` 时没有 `clearTimeout` 或补一次保存。用户输入后立刻切页,最后一次输入可能丢失(取决于定时器能否在页面卸载后跑完)。

**建议**:`onHide`/`onUnload` 里补一次 `this.saveNotes()`。

### G.【低】倒计时可重复添加同一条

`pages/countdown/countdown.js:59-76`:同一标题 + 同一日期的目标可以无限重复添加,没有查重。

---

## 三、确认没有问题的部分

- **番茄钟计时不漂移**:使用 `endAt` 绝对时间戳计算剩余时间(`remaining = endAt - Date.now()`),锁屏、切后台、系统休眠后恢复都能算回正确进度,**没有采用"每秒减一"的错误做法**;`onHide` 清掉定时器、`onShow` 按时间戳重算,设计正确。
- **番茄钟到点补记录**:若在后台期间计时结束,`onShow` 会检测 `remaining <= 0` 并调用 `doAlerts()` + `onSessionComplete()` 尝试补记 —— **但注意:该分支实际执行不到**,因为 `doAlerts()` 未定义会先抛异常,详见下面的 H1(本节原结论有误,已更正)。
- **重复提交双重防护**:`recordSession` 的"先查后插"防重复(修复后生效)+ 客户端 `stopTimer()` 在回调前先停机,可防连点。
- **云开发初始化时机**:`app.js` 的 `onLaunch` 里 `wx.cloud.init()`,页面 `onShow` 晚于它,不存在"未初始化就查询"的问题。
- **数据库权限模型自洽**:`todos` / `notes` / `countdowns` 由**客户端直写**(会带 `_openid`),权限规则按创建者隔离,这几个集合的读写是匹配的。

---

## 四、需要你确认或实机验证的事项

1. **云函数是否已部署**:`recordSession` 是 9-3 凌晨新建的,当时还在自测(`chk3.ps1`)。若未上传部署,番茄钟完成时会报"记录失败,请检查网络"。**修复后的 4 个云函数都需要重新上传部署。**
2. **旧数据不会自动迁移**:历史文档里没有 `openid` 字段,修复后客户端按 `openid` 过滤,**旧记录不会出现在统计里**(统计从修复上线那天重新开始)。如果需要保留历史数据,需要写一次性的迁移脚本回填 `openid`(可以用云函数按 `_openid` 匹配回填,前提是旧文档确实有 `_openid`)。
3. **"云函数写入是否会自动带 `_openid`"** 这一平台行为,我无法在本机验证。修复方案**不依赖**这个行为(统一用显式 `openid`),因此无论平台行为如何都成立;但这也意味着上一条的迁移脚本能否按 `_openid` 匹配旧数据,需要在云开发控制台里看一眼真实文档结构才能确定。

---

## 五、附:本次改动文件清单

| 文件 | 改动 |
|---|---|
| `cloudfunctions/login/index.js` | 改用 `openid`;查不到补建;兼容旧 `_openid` |
| `cloudfunctions/updateProfile/index.js` | 改用 `openid`;档案不存在时补建 |
| `cloudfunctions/addFocus/index.js` | 改用 `openid`;累加改原子自增;标注"已无人调用" |
| `cloudfunctions/recordSession/index.js` | 防重复改先查后插;显式写 `openid`;累加改原子自增 |
| `app.js` | 新增 `waitOpenid()`,供页面做数据归属过滤 |
| `utils/util.js` | 新增 `dayKeyFor()`,统一"午夜模式"归属日期口径 |
| `pages/pomodoro/pomodoro.js` | `focus_log` / `pomo_sessions` 查询补用户过滤;读写口径统一 |
| `pages/stats/stats.js` | `focus_log` 查询补用户过滤 |
| `pages/index/index.js` | `focus_log` 查询补用户过滤 |
| `pages/todolist/todolist.js` | `focus_log` 查询补用户过滤 |

Git 提交:
- `b5f41ad` chore: 首次快照(修改前存档)
- `07c3f1d` fix(cloud): 云函数改用显式 openid 字段

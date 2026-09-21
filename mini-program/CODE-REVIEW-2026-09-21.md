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

### 4. 【严重】`doAlerts()` 从未定义 —— 番茄钟完成流程必崩,专注永远不落库

**问题**:`pages/pomodoro/pomodoro.js` 有两处(计时回调、`onShow` 补算)调用 `this.doAlerts()`,但**全仓库没有任何地方定义它**(`git log -S doAlerts` 显示它自首个快照起就只被调用、从未定义)。

```js
this.remaining = 0;
this.stopTimer();
this.doAlerts();            // ← TypeError: this.doAlerts is not a function
this.onSessionComplete();   // ← 永远执行不到
```

**后果**:倒计时归零即抛异常 → `onSessionComplete()` 不执行 → `pomo_sessions` / `focus_log` **一条都不会写**;异常发生在 `setInterval` 回调内,还会持续抛。用户看到的是"计时停在 00:00、无提示、统计永远为 0"。**这是本次审查最严重的必现功能失效**,也是统计页始终没有数据的根因。

**修复**:
- 补上 `doAlerts()`:按 `ts-settings.soundOn`(默认开)决定是否 `wx.vibrateShort`,并对可用性有限的 API 做 `try/catch`。
- 抽出统一出口 `finishSession()` = 先 `stopTimer()` → 再提示(独立 `try/catch`)→ 最后上报(独立 `try/catch`),**保证提示逻辑的异常不会顶掉数据上报**。
- 两处归零分支改为调用 `finishSession()`。

### 5. 【高】番茄钟页 30 秒轮询定时器无法清理(真实泄漏)

**问题**:`pages/pomodoro/pomodoro.js` 里 `setInterval(() => this.refreshNowLine(), 30000)` 的返回值被丢弃,`onUnload` 只清理了番茄计时器 —— 页面销毁后该定时器仍在跑,会对已销毁页面 `setData`。

**修复**:保存为 `this.nowLineTimerId`,`onUnload` 中 `clearInterval` 并置空。

> 注:这两项都属于"改动小、风险低、影响大",已在本次一并修复(提交见文末)。

### 6. 【高】暂停后恢复被判"时长不一致",整次记录被丢弃(H3)

**问题**:恢复计时时把 `startAt` 重置为"恢复时刻",而云函数用 `endedAt - startedAt` 反推时长并要求与标称时长吻合 → "暂停 10 分钟再跑完"会被判 `时长与时间不一致`,**整次专注直接丢弃**。

**修复**:
- 客户端引入净专注时长统计:`_sessionStartMs`(会话真实起点)、`_focusedMs`(累计净专注)、`_segmentStartMs`(当前段起点)。
- 新增 `creditSegment()`(把当前段结算进净专注)、`pauseTimer()`(暂停,保留会话状态)、`abortSession()`(切模式/重置/离开页面时彻底放弃)、`resetSessionState()`(入库成功后清状态)。
- 上报改为 `{ minutes: 实际净专注分钟, focusedSeconds, startedAt: 真实起点, endedAt, runId }`。
- 云函数校验改为:① `focusedSeconds` 与上报 `minutes` 吻合(±3 分钟);② 净专注时长不得超过真实时间跨度(防伪造);**暂停时长不再参与判定**。
- 验算脚本覆盖 5 种场景(不暂停 / 暂停 10 分钟 / 暂停 10+2 分钟 / 自定义 5 分钟暂停 30 分钟 / 1 分钟快速验证),全部通过;并对照确认旧逻辑会拒绝"暂停 10 分钟"的场景。

### 7. 【高】"退出登录"调用不存在的云函数,且会把数据永久清空(H4)

**问题**:`profile.js` 调用不存在的 `logout` 云函数(异常被空 catch 吞掉),然后只把 `globalData.openid` 置空 —— 微信身份是静默下发的,这既不是真登出,又会让 `waitOpenid()` 从此一直返回 null,各页面跳过查询,表现为"数据全空白,只能重启小程序"。

**修复**:
- 语义改为**"清除本机数据"**(按钮文案与弹窗同步修改):清 `ts-settings`/`ts-theme`/`ts-pomo-modes` + 重置 `globalData` + 重新 `initTheme()`。
- `app.js` 新增 `resetLocalState()`;`waitOpenid()` 在没有进行中的登录时会**自己发起一次 `login()`**,所以清除后各页面能自行恢复,不再永久空白。

### 8. 【高】两套数据写入的非原子与去重脆弱(H5)

**问题**:`pomo_sessions`(明细)与 `focus_log`(聚合)分两步写、无事务;去重键用毫秒级 `endedAt`,重试差 1ms 就绕过。

**修复**:
- 客户端在**会话开始时**生成 `runId` 并全程沿用(失败重试也用同一个),云函数以它构造确定性主键 `s_<openid尾12位>_<runId>` 作为 `pomo_sessions` 的 `_id` —— 重复提交直接命中主键冲突被挡掉,**不再依赖时间戳去重,也没有 count→add 的并发窗口**。
- `focus_log` 的累加保持原子自增;补建分支的极小概率并发建重在统计端按行累加不会算错(重复的日记录被加两次才是问题,而它只在"当天首条记录恰好并发"时出现,且明细侧已去重)。

### 9. 【中】"午夜模式"四页口径不一致(M2)

**问题**:`pomodoro.js` 用 `todayKeyHint()`(午夜模式感知),而 `index.js`/`stats.js`/`todolist.js` 用 `util.todayKey()`(不含)→ 凌晨完成的专注在四个页面显示不同数字。

**修复**:`utils/util.js` 新增并导出 `getSettings()`;四个页面的"今日"判定统一改为 `util.dayKeyFor(util.getSettings())`,`pomodoro.todayKeyHint()` 也改为内部调用它(单一实现)。

### 10. 【高】首页 `onLoad` 必崩:`this.getSettings()` 从未定义(计划外发现)

**问题**:`pages/index/index.js` 的 `onLoad` 第 30 行调用 `this.getSettings()`,但该文件**从未定义这个方法** → `onLoad` 抛 `TypeError`,后面的 `tick()` / `startClock()` / `init()` 全部执行不到(时钟不走、昵称不刷新、专注统计不加载)。

**修复**:补上 `getSettings()`(转发到 `util.getSettings()`)。

### 11. 顺带修掉的小问题

| 问题 | 修复 |
|---|---|
| `profile.wxml` 的"明暗主题"项漏 `bindtap`,`onToggleTheme()` 是死函数 | 补上 `bindtap="onToggleTheme"` |
| `todolist.json` 未开 `enablePullDownRefresh`,但页面实现了 `onPullDownRefresh` | 加上该配置项 |
| `index.js` / `stats.js` / `todolist.js` 聚合时 `r.minutes` 缺字段会产生 `NaN` 并污染整页 | 统一 `Number(x) || 0` 并跳过无 `day` 的行 |
| `soundOn` 开关有 UI 无人读取 | `doAlerts()` 已按 `ts-settings.soundOn` 决定是否震动,开关生效 |
| `util.dayKeyFor()` 曾被加入但无调用方(死代码) | 已在四个页面接线 |



### H1.【严重】`doAlerts()` 从未定义 —— 番茄钟完成流程必崩,专注永远不落库

> **已修复**,见第一节第 4 条。此处保留原始发现记录。

`pages/pomodoro/pomodoro.js:95` 与 `:278` 都调用 `this.doAlerts()`,但**全仓库没有任何地方定义它**。

```js
this.remaining = 0;
this.stopTimer();
this.doAlerts();            // ← TypeError: this.doAlerts is not a function
this.onSessionComplete();   // ← 永远执行不到
```

**后果**:倒计时归零时抛异常 → `onSessionComplete()` 不执行 → `pomo_sessions` / `focus_log` **一条记录都不会写**。用户看到的是:计时停在 00:00、没有提示音、没有"完成"提示、统计永远是 0。异常发生在 `setInterval` 回调里,还会每秒重复抛出。

**这是目前最严重的必现功能失效**,也解释了为什么统计页始终没有数据。

**建议**:补一个 `doAlerts()`(按 `ts-settings.soundOn` 决定震动/音频),并把"提示"与"上报"用独立 `try/catch` 隔开,保证上报不被提示逻辑的异常打断。

## 二、审查中发现的其它问题(H 系列,均未修改,待你决策)

### H2.【高】番茄钟页的 30 秒轮询定时器无法清理(真实泄漏)

> **已修复**,见第一节第 5 条。

`pages/pomodoro/pomodoro.js:68`

```js
setInterval(() => this.refreshNowLine(), 30000);   // 返回值被丢弃
```

`onUnload` 只调了 `stopTimer()`(清的是番茄计时器),这个时间线刷新器**没有保存引用、也没有任何地方 clearInterval**,页面销毁后仍会持续触发并对已销毁页面 `setData`。

**建议**:存成 `this._nowLineTimer`,在 `onHide`/`onUnload` 清理;或直接去掉轮询 —— 30 秒精度对一条分钟级参考线没有意义,`onShow` 时刷一次即可。

### H3.【高】暂停后恢复,会被云函数判为"时长不一致"而**静默丢弃整次记录**

`pages/pomodoro/pomodoro.js:270` 在"恢复计时"分支里重置了 `startAt`:

```js
this.startAt = Date.now();          // 覆盖掉真正的开始时间
this.endAt = this.startAt + this.remaining * 1000;
```

而云函数 `cloudfunctions/recordSession/index.js:28-31` 用 `endedAt - startedAt` 反推实际时长,并要求与上报的 `minutes` 相差 ≤3 分钟。于是"暂停 10 分钟再继续跑完"这种正常操作会被判 `时长与时间不一致`,**整次专注被丢弃**,前端只弹一句"记录失败"。

**建议**:把"已跑时长"单独累计(`accumulated`),恢复时只重置 `endAt`;上报用实际净专注时长。或让云函数改用累计字段校验。

### H4.【高】"退出登录"调用不存在的云函数,且会把数据永久清空

`pages/profile/profile.js:133-147`

```js
try { await wx.cloud.callFunction({ name: 'logout' }); } catch (e) {}   // 云函数不存在
app.globalData.openid = null;   // 只置空本地,不是真登出
wx.switchTab({ url: '/pages/index/index' });
```

三个问题:① `logout` 云函数不存在(仓库只有 login/updateProfile/addFocus/recordSession),异常被空 catch 吞掉;② 清空 `globalData.openid` 不构成登出(身份由微信侧静默获取,下次仍拿到同一 openid);③ **置空之后 `waitOpenid()` 会一直返回 null**,各页面直接跳过查询 —— 表现为"所有数据变空白,只能重启小程序"。

**建议**:要么删掉这个按钮,要么明确成"清空本机缓存"语义(清 storage + 重新 login 刷新 openid)。

---

### A.【低】首页时钟定时器的清理是**正确的**(原判"严重度中"有误)

`pages/index/index.js:37-40` 的 `startClock()` 开头有 `if (this._clockTimer) clearInterval(this._clockTimer)`,`onShow` 也有 `if (!this._clockTimer)` 守卫,只会存在一个实例;`pages/index/index` 是 tabBar 页、常驻内存,每秒刷新时钟本就是预期行为。**此项不构成缺陷**,真正需要修的是 H2(`pomodoro.js:68` 那个连引用都没存的定时器)。

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
| `pages/pomodoro/pomodoro.js`(第二轮) | **补上从未定义的 `doAlerts()`**;新增统一出口 `finishSession()`,把提示与数据上报用独立 `try/catch` 隔开;30 秒轮询定时器保存引用并在 `onUnload` 清理 |
| `CODE-REVIEW-2026-09-21.md` | 本报告 |

Git 提交:
- `b5f41ad` chore: 首次快照(修改前存档)
- `07c3f1d` fix(cloud): 云函数改用显式 openid 字段
- (后续)fix(pomodoro): 补上 doAlerts 并修复完成流程/定时器泄漏

# 今日空间小程序 · 代码审计 + 市面对标优化方案

> 版本：v1（2026-09-21）
> 审计范围：`D:\codex  use\mini-program` 全部页面（index / todolist / stats / profile / pomodoro / notes / countdown）、`utils/util.js`、`app.js`、6 个云函数（login / recordSession / getFocusStats / addFocus / clearDoneTodos / updateProfile）、`app.wxss` 主题变量。
> 说明：本文档给出「问题 → 证据（文件:行）→ 具体改法 → 收益」。

## 实施状态（2026-09-21 晚更新）

**A 组（高危）+ B 组（中危）已全部改完并上线。** 上传版本 `1.0.1`，云函数已重新部署 4 个。

| 编号 | 状态 | 落点 |
|---|---|---|
| A1 切后台计时停摆 | ✅ 已修 | `pomodoro.js`：`startTick/stopTick/syncTimer`，`onShow` 补建定时器 |
| A2 上报校验拒收 | ✅ 已修 | `recordSession/index.js`：净时长不一致时"以服务端为准降级入库"+`adjusted` 标记 |
| A3 后台结束净时长算错 | ✅ 已修 | `pomodoro.js`：`creditSegment(atMs)` 按 `endAt` 结算；新增 `wallSeconds` |
| A4 深色圆环轨道 | ✅ 已修 | `pomodoro.wxml` + `utils/theme.js` 的 `ringTrack` |
| A5 图表颜色写死 | ✅ 已修 | `stats.js`：新增 `paintBars()`，颜色走 `themeUtil.palette()` |
| A6 静默丢弃会话 | ✅ 已修 | `pomodoro.js`：二次确认 + `reportAbandon()`；`recordSession` 支持 `type='abandoned'` |
| B1 读写日期口径错位 | ✅ 已修 | `pomodoro.js loadSessions()`：改按 `startedAt` 时间戳区间查询 |
| B2 wx:key 会撞 | ✅ 已修 | `pomodoro.wxml`：`timelineBlocks`/`sessionList` 改用 `_id` |
| B3 每次全量扫 + 4 次调用 | 🟡 部分完成 | 已做：游标分页替换 `skip`、`utils/focus-stats.js` 缓存层（4 页共用一次请求）、写后失效。<br>**待手工**：控制台建组合索引 `focus_log(openid↑,day↑)`；`stats_daily` 汇总集合 + 定时触发器（P2-12） |
| B4 addFocus 死代码 | ✅ 本地已删 | 目录已移除；**待手工**：云开发控制台删掉云端那个函数（CLI 没有 delete 命令） |
| B5 restMin 死设置 | ✅ 已修 | `profile.js/wxml` 新增弹窗；`pomodoro.loadCustomModes()` 采用它作为短休默认值 |
| B6 权限兜底风险 | ✅ 已加固 | 三处权限依赖都写了显式注释；`countdown.onDelete` 补上 `showModal` 的 Promise 化（原来 `await` 回调式 API，删除确认永远拿到 undefined）；`onSave` 显式写 `openid` 并带最小写入兜底 |
| B7 focus_log 无 _openid | ✅ 已修 | `recordSession`/`updateProfile` 写入时显式补 `_openid` |
| 连带发现：`clearDoneTodos` 一条也删不掉 | ✅ 已修 | 原来只按 `openid` 查，而待办是客户端直写、只有 `_openid` → 改成两条路径都查 |

**验证方式**：`node --check` 全量语法通过；`D:\ds harness\.scratch-dsh\verify-fixes.mjs`（mock 掉 `wx`/`getApp` 真跑主题、缓存、净时长、分页下界、查询窗口、放弃阈值）**24 项全过**。剩余需在模拟器里人工验的 4 条见文末。

---

## 第一部分：代码审计（自研部分，与市面对标无关也必须修）

### A. 高危缺陷（会丢数据 / 打不开）

#### A1. 番茄钟切后台再回来，计时器永久停摆 ⚠️ 最严重

- **现象**：专注计时中切到微信聊天 / 切 tab / 锁屏，再回番茄钟页 —— 数字冻住不动、永远不归零、这次专注永远不会入库。
- **证据**：`pages/pomodoro/pomodoro.js:125-130`（`onHide` 只 `clearInterval`，不清 `this.data.running`）+ `:132-147`（`onShow` 只重算 `remaining`，**没有重建 `intervalId`**）。
- **为什么必现**：`onShow` 里 `if (this.data.running && this.endAt > 0)` 成立，但后面只调了 `updatePomo()`；而倒计时唯一的推进者是 `onToggle` 里创建的 `setInterval`（`:322`）。`onHide` 已经把它清掉，回来没有任何地方重建 → 倒计时停止。
- **改法**（推荐）：把"起一个 1 秒 tick"抽成 `startTick()`，`onShow` 中 `running && endAt>0` 时先 `if (!this.intervalId) this.startTick()`；`onToggle` 复用同一个方法。这样彻底消除"两个地方各自创建定时器"的重复。
- **额外**：`onShow` 里 `finishSession()` 是异步的，`updatePomo()` 紧接着跑会覆盖 UI，建议改成 `await`/`.then()`。
- **收益**：从"切一次后台就废"变成"后台回来自动续算"，这是市面番茄钟的底线能力（番茄ToDo/Forest 都是后台继续走）。

#### A2. 休息计时也会入库成"专注时长"，统计被污染

- **现象**：跑完 5 分钟短休，`recordSession` 照样写一条 `pomo_sessions`；`focus_log` 只累加 `type==='focus'`，所以时长统计没错，但**"累计次数"包含了休息次数**（`stats.js:85 totalCount: totalSessions` 来自 `getFocusStats` 的 `totals.sessions`，而它累加的是 `focus_log.sessions` → 休息不计入，这点没问题）。真正的错在：`pomo_sessions` 明细里混着休息，时间轴把休息也画成色块（`:247-267` 是有意为之）。
- **结论**：这条**不是 bug**，但 UI 文案"今日完成 N 个番茄"（`pomodoro.wxml:27`）用的是 `todaySessions`＝`focus_log.sessions`，与"番茄"语义一致，保持即可。**不改**。
- 记录在此是为了避免后续误改。

#### A3. 上报校验太硬：合法会话会被**整条拒收**（静默丢数据）

- **背景**：`cloudfunctions/recordSession/index.js:53-60` 两条校验 ——
  - ① `Math.abs(focusedMs/60000 - minutes) > 3` → 拒收；
  - ② `focusedMs > wallMs + 60000` → 拒收。
  ② 在"含暂停"的场景下恒不触发（净专注必然小于墙钟跨度），**逻辑是对的**。问题出在①的**容差方向**：只要客户端算出的 `focusedMs` 因生命周期问题少统计超过 3 分钟，这次已经跑完的专注就被整条丢掉，用户只看到一句"记录失败"，数据永久消失。
- **触发路径（真实可达）**：`pomodoro.js:322-329` 的 tick 走 `endAt - Date.now()`，`onHide` 停 tick、`onShow` 只补算 `remaining` 而**不补算 `_focusedMs`**（`_focusedMs` 只在 `creditSegment()` 里按 `Date.now() - _segmentStartMs` 累加，`:341-346`）。所以"切后台直到计时结束再回来"这条路上，`_focusedMs` 由 `:400` 退化成 `endedAt - _sessionStartMs`（含后台时间）→ 若中间还叠加过暂停，两个数就打架，直接撞上①。
- **改法（两步）**：
  1. **客户端**补"后台补账"：`onShow` 里若 `running && endAt <= now`，先把 `_focusedMs += (this.endAt - this._segmentStartMs)`（而不是 `Date.now() - _segmentStartMs`）再 `finishSession()` —— 计时语义上"该结束的时刻"就是 `endAt`，后台那段不该算进专注。
  2. **服务端**把①从"拒收"改成"**以服务端为准降级入库**"：`const min = Math.max(1, Math.min(minutes, Math.round(focusedMs/60000) || minutes))`，并写入 `adjusted: true` 标记；只有 `focusedMs <= 0` 或超过 180 分钟上限才拒收。
- **收益**：把"静默丢掉一次专注"变成"照实记录并标注"，这是用户对这类产品最敏感的数据可靠性问题。

#### A4. 深色模式下番茄钟圆环轨道几乎不可见

- **证据**：`pages/pomodoro/pomodoro.wxml:15` 硬编码 `#e8edf0` 作轨道色；深色面板是 `#1d2326`（`app.wxss:41`）。
- **改法**：把 conic-gradient 的轨道色抽成主题变量 `var(--ring-track)`（浅色 `#e8edf0` / 深色 `#2b3438`），并在 `app.wxss` 的 `.page.theme-dark` 里补一条。
- **附带**：`.timer-note`、`.session-time` 等已用变量，无需改。

#### A5. 统计图表颜色硬编码，深色模式下发灰、看不出数据

- **证据**：`pages/stats/stats.js:316, 322-323, 326, 366, 370` 全部写死 `#0d9f6d` / `#dfe5e8` / `#5c6b74`；`canvas` 是 2d 类型，**不会**继承 WXSS 变量。
- **改法**：新增 `utils/theme.js` 导出 `chartPalette(theme, themeColor)`，返回 `{ accent, empty, label }`；两处 `draw*` 调用前取值。顺带把主色调（绿/蓝/橙/紫/粉）也接进去 —— 现在切主题色，图表永远是绿的。
- **收益**：深色模式 + 5 种主题色全部对齐，视觉一致性直接提升一个档。

#### A6. 切模式 / 重置会**静默丢弃**正在跑的会话

- **证据**：`pomodoro.js:298-305`（`onMode` 直接 `abortSession()`）、`:334-338`（`onReset` 同样）。
- **改法**：`if (this.data.running || this._focusedMs > 0) wx.showModal({...'放弃本次专注？'})`，确认后再 `abortSession()`。同时在放弃时给服务端上报一条 `abandoned` 记录（见第三部分 E2），让"放弃次数"有数据。
- **收益**：误触不再白干；顺带把统计页那个假的"放弃次数 0"变成真数据。

---

### B. 中危：正确性 / 一致性

#### B1. `dayOffset` 与 `pomo_sessions.day` 的口径可能错位一天

- **证据**：`pomodoro.js:239` 用 `util.dateKey(new Date(Date.now() + this.dayOffset()*86400000))` 查列表；而服务端 `recordSession` 用 `dayKeyInTz(endedAt + dayOffset*86400000, tz)`（`recordSession/index.js:73`）。两者都"往前挪一天"，**但客户端用的是设备本地时间、服务端用的是上报的 tzOffset**；设备时区与 tzOffset 不一致（改过系统时区、跨时区旅行）时列表会查到空。
- **改法**：列表查询也走"服务端口径"——让 `getFocusStats` 额外返回最近 N 天的明细，或者列表查询改成 `where({ openid, endedAt: _.gte(今天0点).and(_.lt(明天0点)) })`，用时间戳区间而不是 `day` 字符串。
- **收益**：彻底消除"番茄钟页有时间轴、统计页却没有"的错位。

#### B2. `wx:key` 用了会重复的字段

- **证据**：`pomodoro.wxml:83` `wx:key="time"`（HH:mm，同一分钟两条就撞）、`:69` `wx:key="top"`（浮点 top，理论上可撞）。
- **改法**：`sessionList` / `timelineBlocks` 里带上 `_id`（`recordSession` 用的是确定性 `_id`，天然唯一），`wx:key="_id"`。
- **收益**：列表复用错乱、动画串位这类"偶发玄学 bug"根除。

#### B3. `getFocusStats` 每次进页面都全量分页扫描（4 个页面各一次）

- **证据**：`cloudfunctions/getFocusStats/index.js:30-52`（最多 30 页 × 100 条，`skip` 深分页）；调用方：`index.js:201`、`pomodoro.js:214`、`stats.js:64`、`todolist.js:32`。
- **问题**：① 每次进页面都重扫全表，随数据增长线性变慢；② `skip` 深分页在云数据库上代价高；③ 返回值随天数增长（3 年 ≈ 1000 天 ≈ 几十 KB，接近函数返回上限）。
- **改法（按性价比排序）**：
  1. 给 `focus_log` 建**复合索引** `openid(升序) + day(升序)`（云开发控制台 → 数据库 → 索引管理），并把 `orderBy('day','asc')` 保留 → 扫描量与排序代价立刻下降；
  2. `byDay` 只回传**近 400 天**，`totals` 用一条 `aggregate().group()` 单独算（或另开 `focus_totals` 单文档累加，`recordSession` 里顺手 `_.inc`）；
  3. 页面侧加**内存缓存**（`app.globalData.focusStatsCache = { at, data }`，60 秒内复用），4 个页面从 4 次调用降到 1 次。
- **收益**：进页面的一次网络+扫描变成"秒开"，且成本可控。

#### B4. `addFocus` 是死代码

- **证据**：全仓 grep `addFocus` 只命中它自己的文件（`cloudfunctions/addFocus/index.js:1` 的注释）；没有任何页面 `callFunction({ name: 'addFocus' })`。功能已被 `recordSession` 取代。
- **改法**：`git rm` 掉该目录，并从云端删除该函数（`cli cloud functions` 无删命令，用云开发控制台删除），避免每次部署都传一个没人用的函数、也避免以后有人误用旧逻辑（它按"25 的倍数"校验，与现在的自定义时长冲突）。

#### B5. `restMin` 是死设置

- **证据**：`profile.js:33` 读出来展示，`profile.wxml:49-52` 点了跳番茄钟；但没有任何地方 `use restMin`。
- **改法**：二选一 —— ① 删掉该行；② 真正实现：进番茄钟时用 `restMin` 作为短休默认值（`loadCustomModes` 里 `this.modes.short.minutes = s.restMin || 5`）。
- **建议**：选 ②，成本 3 行，且"自定义休息时间"这个名字才对得上。

#### B6. `notes` / `countdowns` 依赖集合权限"仅创建者可读写"

- **证据**：`countdown.js:25-28` 查询**没有任何 openid 过滤**，`notes.js:58` 用 `note_${openid后16位}` 作 `_id`。这两处都**只**在权限设为"仅创建者可读写"时才安全。
- **改法**：写进部署清单（见第四部分），并在代码里加一句注释说明这个隐式依赖；`countdowns` 建议补 `openid` 字段（客户端 add 会自动带 `_openid`，显式加一份便于以后迁到云函数）。
- **风险等级**：中 —— 如果哪次为了调试把权限放宽到"所有用户可读"，倒计时和便签会串号。

#### B7. `focus_log` 是云函数写入的，**没有 `_openid`**

- **证据**：`recordSession/index.js:122-124` 写入 `{ openid, day, minutes, sessions }` —— 云函数侧写入不注入 `_openid`。
- **含义**：`focus_log` 的权限**必须**是"所有用户可读，仅创建者可读写"（否则 `getFocusStats` 的 `where({openid})` 查询会被权限规则挡成空结果，统计全 0）。
- **改法**：写进部署清单；更稳的做法是给每条记录补 `_openid: OPENID`，这样"仅创建者可读写"也能工作，安全性更好。

---

### C. 低危：体验与工程卫生

| 编号 | 问题 | 证据 | 改法 |
|---|---|---|---|
| C1 | 倒计时/便签失败提示把"建集合"这种运维细节甩给用户 | `countdown.js:45,74` | 改成"加载失败，请重试"，细节进 console |
| C2 | 统计页"上一页"无下界，可以一直点到 1970 年 | `stats.js:126-132` | `distOffset` 下限用最早一条数据的日期，`canPrev = offset > minOffset` |
| C3 | "年度数据"只能看今年，标题写死 `{{year}}` | `stats.wxml:81`、`stats.js:41` | 加 `‹ ›` 切年（`yearRef` 已经在，只差 UI），`loadYear()` 已按 `yearRef` 计算 |
| C4 | `drawDistribution` 的标签抽稀算法在 n≤12 时全部显示，n=31 时标签挤 | `stats.js:329` | 统一按 `Math.ceil(n/7)` 抽稀，或改横向滚动 |
| C5 | 会话完成提示只有震动，没有音效；`soundOn` 开关名为"提示音" | `pomodoro.js:68-76`、`profile.wxml:54` | 接 `wx.createInnerAudioContext()` 播一个 3 秒提示音（音源放 `static/`），或把开关文案改成"完成震动" |
| C6 | 无任何分享能力 | 全仓无 `onShareAppMessage` | 加 `onShareAppMessage`（分享"我今天的专注统计"）+ 生成分享图 `canvas`；自习类产品的自然增长几乎全靠这个 |
| C7 | 无数据导出 | — | "我的"加"导出专注记录"（云函数生成 CSV/JSON，返回临时链接或直接 `wx.setClipboardData`） |
| C8 | 主色调切换后，番茄钟圆环/时间轴色块仍是写死的绿蓝橙 | `pomodoro.js:6-8` `DEFAULT_MODES.color`、`:248` `TYPE_COLOR` | 同上抽 `chartPalette`，圆环用 `var(--accent)` |
| C9 | `stats.js:91` `todayAbandon: 0` 是假数据 | 同上 | 配合 A6 的 abandon 上报变成真数据 |

---

## 第二部分：市面对标（番茄ToDo / Forest / 潮汐 / 滴答清单 …）

调研覆盖 8 个产品：番茄ToDo、Forest、潮汐、时光序、滴答清单、专注清单 Focus To-Do、小睡眠、微信小程序自习室类。完整原始报告见 `今日空间-竞品调研报告.md`。

### 2.1 产品 × 核心机制

| 产品 | 计时模式 | 监督 / 惩罚 | 任务待办 | 自习室 / 社交 | 统计可视化 | 留存 / 激励 |
|---|---|---|---|---|---|---|
| 番茄ToDo | 番茄钟、正/倒计时；学霸模式 | 学霸+锁机+严格模式 | 待办清单、待办集、习惯量化 | 自习室（房间号） | 详尽图表；写入 Apple Health | 一万小时计划、季度卡 |
| Forest | 种树计时、时间守护 | 玩手机→树枯萎；App 白名单 | 弱（标签为主） | 一起种树、全球竞赛 | 周/月/年森林回顾、时光轴 | 徽章、树种、金币、真树捐赠 |
| 潮汐 Tide | 番茄钟/倒计时/无限计时 | 白名单、"翻转专注" | 无 | 无 | 专注报告、场景分布 | 连续练习、每日格言 |
| 时光序 | 正/倒计时、番茄钟 | 多种锁机 | 四象限待办、习惯打卡 | 内置自习室 | 扇形/柱状/饼图 | 18 个生活场景钩子 |
| 滴答清单 | 番茄计时 25+5 | 无强制 | 清单/标签/优先级/子任务 | 团队协作 | 数据同步 HealthKit | 多端同步、公众号建任务 |
| 专注清单 | 番茄钟（可自定义、自动开始） | 阻止熄屏 | 任务预计番茄数、子任务 | 无 | 日/周/月报告、分布日历 | 番茄数累计、小组件 |
| 小睡眠 | 专注时钟 | 沉浸场景约束 | 无 | 沉浸自习室×12 场景 | 以睡眠报告为主 | 1400+ 白噪音、社区 |
| 小程序自习室类 | 签到签退+计时 | 断签/排行榜压力 | 打卡任务 | **自习室房间+榜+陪伴角色** | 累计时长、排行 | 连续打卡、榜单 |

### 2.2 关键判断：三条"照着抄会翻车"的

1. **不要做锁机 / 学霸模式**。番茄ToDo 的锁机和 Forest 的 App 白名单都靠系统权限（Forest 白名单要 iOS 16+），**小程序根本拿不到**。做成"切走即失败"只会制造大量误判投诉（用户抱怨里就有"把番茄从后台清除后，定时锁机失效"）。小程序的监督只能做成：**自习室共同在场 + 房间内排名 + 断签代价**。
2. **不要把 `setInterval` 的累加值当数据源**。这是这类产品的头号差评来源（"专注 89 分钟被判枯树""计时结束再打开立即重新计时"）。正确做法是**只存「开始时刻 + 计划时长」，展示层按 `now - startAt` 重算，落库由云函数用服务端时间结算**。这正是本项目 A1/A3 两条缺陷的根治方向。
3. **统计不能靠"每次进页面全表聚合"**。官方资源点计费下，成本是硬约束（下一节算给你看）。

### 2.3 我们缺什么（对照后落到代码上的差距）

| 市面标配 | 本项目现状 | 对应代码位置 |
|---|---|---|
| 日历热力图 / 年度视图 | 只有柱状分布 + 年度柱状 | `stats.js:289-376` |
| 连续打卡天数 + 徽章 | 完全没有 | — |
| 专注结束自动进入休息、每 4 个一长休 | 跑完就停，手动切模式 | `pomodoro.js:307-332` |
| 待办 ↔ 番茄绑定（预计番茄数、按任务归因） | 待办与专注完全解耦 | `index.js` / `pomodoro.js` |
| 分享卡片（今日战绩海报） | 全仓无 `onShareAppMessage` | — |
| 完成提示音 | 只有震动 | `pomodoro.js:68-76` |
| 白噪音 / 音景 | 无（小程序可做，音频资源需自备） | — |
| 统计里"放弃次数" | UI 有，值恒为 0 | `stats.js:91` |
| 弱网离线可用 | 无，断网即丢这次记录 | `pomodoro.js:394-436` |

### 2.4 成本账（官方数据，已核实）

按 [腾讯云开发资源点计费 FAQ](https://docs.cloudbase.net/quick-start/resource-point)：**数据库调用 200 点/万次、云函数调用 13 点/万次、CDN 210 点/GB**；免费体验版 3000 点/月、个人版 19.9 元/月 40000 点；超限 1000 点＝1 元；**从固定配额切到资源点后不可回退**。

代入现状算一笔：

- `getFocusStats` 每次调用最多翻 30 页 × 100 条（`getFocusStats/index.js:30-52`）。数据攒到 400 天（约 4 页）时，一次调用 ≈ 4 次数据库读。
- 首页、番茄钟页、统计页、待办集**四个页面各调一次**（`index.js:201`、`pomodoro.js:214`、`stats.js:64`、`todolist.js:32`）→ 一次逛 app ≈ 16 次数据库读 + 4 次云函数调用。
- 个人版 40000 点 ≈ **200 万次数据库调用/月**。按上面 16 次/人次算，约 12 万人次/月；若要撑 3000 DAU、人均每天开 3 次，就已经吃掉约 **40% 的套餐**。

**结论**：`stats_daily` 汇总集合 + 内存缓存不是"以后再说"的优化，而是**决定这个免费/低价套餐能撑多少用户**的架构选择。

---

## 第三部分：优化路线图（按性价比排序，每条都能独立交付）

### P0 —— 必修（数据正确性 / 核心流程不断）

| # | 事项 | 涉及文件 | 预估 |
|---|---|---|---|
| 1 | **A1** 番茄钟后台恢复续跑（抽 `startTick()`） | `pages/pomodoro/pomodoro.js` | 0.5h |
| 2 | **A3** 上报校验改为"服务端兜底降级"而非拒收 | `cloudfunctions/recordSession/index.js` | 0.5h |
| 3 | **A4/A5/C8** 主题化：圆环轨道、图表配色、模式颜色 | `app.wxss`、`pomodoro.wxml/wxss`、`stats.js`、新增 `utils/theme.js` | 1.5h |
| 4 | **B1** 会话列表改按时间戳区间查询 | `pages/pomodoro/pomodoro.js` | 0.5h |
| 5 | **B6/B7** 集合权限与 `_openid` 补齐（含部署清单） | 云开发控制台 + `recordSession` | 0.5h |

### P1 —— 体验与留存（对标市面的必备项）

| # | 事项 | 对标来源 | 预估 |
|---|---|---|---|
| 6 | **A6 + E2** 放弃会话二次确认 + `abandoned` 记录 + 统计页真实"放弃次数" | 番茄ToDo 的"放弃要扣分" | 2h |
| 7 | **E3** 专注热力图（GitHub 风格 365 天格子） | Forest / 番茄ToDo 的年度视图 | 3h |
| 8 | **E4** 连续打卡天数 + 今日目标（如"今日目标 120 分钟"进度环） | 几乎全部竞品 | 2h |
| 9 | **E5** 专注结束自动进入休息（含"每 4 个番茄长休"） | 标准番茄工作法 | 1.5h |
| 10 | **C6** 分享卡片（今日统计图） | Forest 种树分享 | 2h |
| 11 | **C5** 完成提示音 | 全部竞品 | 0.5h |

### P2 —— 架构与成本（数据量一上来就必须做，越早越省事）

| # | 事项 | 说明 | 预估 |
|---|---|---|---|
| 12 | **B3** 新增 `stats_daily` 汇总集合 + 定时触发器 | `_id = openid_yyyyMMdd`，字段 `totalMin / sessions / byHour[24]`；`recordSession` 落库时顺手 `_.inc` 累加，**统计页/首页只读这一条**。`getFocusStats` 降级为"兜底/历史回填"用途 | 1 天 |
| 13 | **B3** 页面级内存缓存 | `app.globalData.focusStatsCache = { at, data }`，60 秒内复用；4 个页面的调用从 4 次降到 1 次 | 0.5h |
| 14 | **B3** 组合索引 | `focus_log(openid↑, day↑)`、`pomo_sessions(openid↑, day↑)`、`todos(_openid↑, done↑, createdAt↓)`、`countdowns(_openid↑, targetDate↑)` | 0.5h |
| 15 | 列表改游标分页 | 现状 `where().orderBy().limit(100)`（`index.js:98`、`pomodoro.js:240`、`todolist.js:31`、`countdown.js:25`）在数据超 100 条时会**静默截断**；改 `startAt < 上一页最后一条` + `limit(20)`。<br>⚠️ 待实测：小程序端单次查询上限一直是 20 条的历史说法，需在开发者工具里用 `.limit(100)` 实测确认（云函数端确为 100） | 2h |
| 16 | 离线队列 | 断网时把会话暂存 `wx.setStorageSync`，恢复后按 `runId` 幂等补传（`recordSession` 的确定性 `_id` 已经天然支持） | 0.5 天 |

### P3 —— 差异化（做出来就是特色）

| # | 事项 | 说明 | 预估 |
|---|---|---|---|
| 17 | **E6** 自习室（房间号 + 在场人数 + 房内日榜） | 云开发 `watch()` 实时同步；新增 `rooms` / `room_members` 集合 + 定时触发器清理僵尸成员。**这是小程序唯一可行的"监督"替代品**（锁机做不到） | 2-3 天 |
| 18 | **E7** 待办 ↔ 番茄绑定 | 开始专注时选一条待办，`pomo_sessions` 带 `todoId`；统计支持按任务归因（专注清单验证过的强绑定） | 1 天 |
| 19 | **E8** 数据导出 + 年度报告长图 | "我的"加"导出专注记录"；年底长图传播性强 | 1 天 |
| 20 | 白噪音 / 音景 | 小程序可做，但需自备音频资源与 CDN 流量（210 点/GB，注意成本） | 1 天 |
| 21 | 订阅消息提醒 | "番茄结束/倒数日到期"提醒；授权要在"刚完成一次专注"这种高意愿时刻索取 | 1 天 |

### P4 —— 明确不做（写下来避免以后重复讨论）

| 事项 | 为什么不做 |
|---|---|
| 锁机 / 学霸模式 / App 白名单 | 小程序无系统权限，做出来只会误判（用户抱怨里"锁不住""清除后台就失效"都是这类） |
| 全局排行榜 | 成本高（跨用户实时读）、挫败尾部用户；只做"自习室房内榜" |
| 每秒写库 / 前端累加时长 | 直接撞资源点成本和"计时不可信"两类问题 |

### 部署清单（每次上线对照）

1. 集合权限：`todos`/`notes`/`countdowns` = **仅创建者可读写**；`users`/`focus_log`/`pomo_sessions` = **所有用户可读，仅创建者可读写**（或按 B7 给每条补 `_openid` 后收紧为仅创建者 + 自定义安全规则）。
2. 索引：`focus_log(openid↑, day↑)`、`pomo_sessions(openid↑, day↑)`、`todos(_openid↑, done↑, createdAt↓)`、`countdowns(_openid↑, targetDate↑)`。
3. 云函数部署：`cli cloud functions deploy --env cloud1-d9gqbbkdz44c81883 --project "D:\codex  use\mini-program" --port 33067 --remote-npm-install --names login recordSession getFocusStats clearDoneTodos updateProfile`（`addFocus` 删除后不要再传）。
4. 上传前先 `cli.bat preview` 出一版二维码自测，再 `cli.bat upload --version x.y.z --desc "..."`。
5. 若将来启用定时触发器/汇总函数，记得给汇总类函数配**运行时长与错误告警**。

---

## 第四部分：实施顺序建议（一句话版）

**先 P0 五条（纯修复，不动设计，当天可上线）→ 再 P2 的 12/13/14（架构与成本，越早做越省事）→ 然后 P1 的留存三件套（热力图 + 连续天数 + 分享卡片）→ 最后才是自习室。**

理由：P0 修的是"数据会丢、计时会停"这类致命体验；P2 决定成本上限，等 DAU 起来再改要迁移数据；P1 是留存曲线；自习室是放大器，但它的价值建立在"你自己先把专注记录做准"之上。

---

## 第五部分：本轮改完后的手工验证清单（模拟器里点一遍）

代码层面能自测的都已自测（语法 + mock 逻辑 24 项），下面 5 条必须在真机/模拟器上过一遍：

1. **后台续跑（A1）**：开始一个 1 分钟的专注 → 立刻切到微信聊天/其它 tab 等 30 秒 → 切回来。期望：数字继续走（不是冻住），到点正常弹"专注完成"。
2. **后台跨过结束点（A3）**：开始 1 分钟专注 → 切后台待满 90 秒再回来。期望：提示完成，记录 +1 分钟；统计里的分钟数不含后台那 30 秒。
3. **放弃记录（A6）**：专注 2 分钟后点"重置"。期望：弹二次确认；确认后统计页"今日专注 → 放弃次数"变成 1（不再是 0）。
4. **深色模式配色（A4/A5）**：切深色 → 番茄钟圆环的底圈看得见；统计页柱子是主题色而不是发灰；再换主题色（紫/粉），圆环和柱子跟着变。
5. **清除已完成（连带修复）**：勾几条待办 → 点"清除已完成"。期望：提示"已清除 N 条"且列表真的空（之前会提示 0 条）。

### 还需要在云开发控制台手工做的两件事

- **删掉云端的 `addFocus` 函数**（本地目录已删；开发者工具 CLI 没有 delete 命令）：云开发控制台 → 云函数 → `addFocus` → 删除。
- **建索引**（B3 收尾，直接影响统计速度与资源点消耗）：数据库 → `focus_log` → 索引管理 → 新增组合索引 `openid`(升序) + `day`(升序)；`pomo_sessions` 建 `openid`(升序) + `startedAt`(降序)。

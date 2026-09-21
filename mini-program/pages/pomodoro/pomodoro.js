// pages/pomodoro/pomodoro.js — 番茄钟(自定义时长 + 会话时间轴 + 流水记录)
//
// 2026-09-21 第二轮修复（对应 OPTIMIZATION-PLAN 的 A1/A3/A4/A6/B1/B2/B5/C8）：
//   A1 切后台回来后倒计时不再永久停摆：定时器统一由 startTick() 创建，
//      onShow 检测到"应该在跑但没有定时器"时补建。
//   A3 "后台跑到结束"的会话，净专注时长按 endAt 结算，不把后台时间算进来。
//   A6 切模式 / 重置会丢掉正在跑的会话 → 现在二次确认，并把已专注的时长
//      作为 abandoned 记录上报（不再无声蒸发）。
//   B1 会话列表查询改用"时间戳区间"而不是服务端 day 字段，读接口径与
//      服务端归属日期彻底对齐。
//   B2 列表 wx:key 改用文档 _id，避免同一分钟两条记录撞 key。
//   B5 "自定义休息时间"(profile 的 restMin) 真正生效：作为短休默认值。
//   A4/C8 圆环轨道色、模式色走 utils/theme.js，跟随深色模式与主题色。
const util = require('../../utils/util.js');
const themeUtil = require('../../utils/theme.js');
const statsApi = require('../../utils/focus-stats.js');

// 默认模式(可被自定义覆盖)
const DEFAULT_MODES = {
  focus: { label: '专注', minutes: 25, note: '保持专注', color: '#0d9f6d' },
  short: { label: '短休', minutes: 5, note: '休息一下', color: '#3b6fd4' },
  long: { label: '长休', minutes: 15, note: '好好放松', color: '#c9871c' }
};

// 时间轴:每小时高度(px),24 小时
const HOUR_H = 56;
const DAY_H = 24 * HOUR_H;

const PENDING_KEY = 'ts-pomo-pending';
const PENDING_WINDOW_MS = 10 * 60 * 1000; // 落库失败后 10 分钟内允许自动补传

// ---- 上报暂存(离线/失败重试) ----
// 计时结束先写本机待补队列,再尝试上云;失败不会被丢弃,下次进页面自动补传。
function readPending() {
  try { return wx.getStorageSync(PENDING_KEY) || []; } catch (e) { return []; }
}

function writePending(list) {
  try {
    if (list && list.length) wx.setStorageSync(PENDING_KEY, list);
    else wx.removeStorageSync(PENDING_KEY);
  } catch (e) { /* 存储写失败不影响主流程 */ }
}

function pushPending(record) {
  const list = readPending().filter((r) => r && r.runId !== record.runId);
  list.push(record);
  writePending(list.slice(-20)); // 只留最近 20 条,避免异常情况下无限堆积
}

function dropPending(runId) {
  writePending(readPending().filter((r) => r && r.runId !== runId));
}

Page({
  data: {
    themeClass: '',
    colorClass: '',
    mode: 'focus',
    timer: '25:00',
    note: '保持专注',
    ringColor: '#0d9f6d',
    ringPct: '100%',
    ringTrack: '#e8edf0',
    running: false,
    todaySessions: 0,
    todayMinutes: 0,
    showDoneBanner: false,
    lastRecord: 0,
    modeFocusLabel: '专注 25',
    modeShortLabel: '短休 5',
    modeLongLabel: '长休 15',
    showCustom: false,
    cFocus: 25,
    cShort: 5,
    cLong: 15,
    timelineHeight: DAY_H,
    timelineBlocks: [],
    nowLineTop: 0,
    sessionList: [],
    hourMarks: []
  },

  modes: JSON.parse(JSON.stringify(DEFAULT_MODES)),
  startAt: 0,
  total: DEFAULT_MODES.focus.minutes * 60,
  remaining: DEFAULT_MODES.focus.minutes * 60,
  intervalId: null,
  nowLineTimerId: null,
  endAt: 0,
  motto: '',
  // 计时统计(2026-09-21 新增,修"暂停后恢复被判时长不符"的问题):
  //   _sessionStartMs  本次会话真实开始时刻(含暂停,只在会话开始时赋值一次)
  //   _focusedMs       本次会话累计的净专注时长
  //   _segmentStartMs  当前这段"正在跑"的起点
  //   _runId           幂等键,会话开始时生成一次,重试沿用,服务端据此挡重复
  _sessionStartMs: 0,
  _focusedMs: 0,
  _segmentStartMs: 0,
  _runId: '',
  _completing: false,

  getSettings() {
    return util.getSettings();
  },

  // ---- 主题 ----
  applyTheme() {
    const app = getApp();
    const p = themeUtil.palette(app);
    this.setData({
      themeClass: p.dark ? 'theme-dark' : '',
      colorClass: themeUtil.colorClass(p.color),
      ringTrack: p.ringTrack
    });
    this.updatePomo();
  },

  // 会话结束提示(震动)。
  // 2026-09-21:此前这个方法**从未定义**,而计时归零时会被调用两次路径命中,
  // 抛出的 TypeError 直接把后面的 onSessionComplete() 顶掉 —— 番茄钟跑完
  // 永远不落库。所有可用性有限的 API 都必须包 try/catch。
  doAlerts() {
    const s = this.getSettings();
    if (s.soundOn === false) return; // 默认开启;设置页的开关存的就是这个字段
    try {
      wx.vibrateShort({ type: 'heavy' });
    } catch (e) {
      console.warn('doAlerts: vibrateShort unavailable', e);
    }
  },

  // ---- 定时器管理(A1 的核心) ----
  // 只有这一个地方创建 1 秒 tick。之前 onShow 只知道"应该在跑"却不会重建定时器,
  // 于是切后台(清 interval)再回来就永久停摆、永远不归零。
  startTick() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => {
      if (!this.endAt) return;
      this.remaining = Math.max(0, Math.round((this.endAt - Date.now()) / 1000));
      if (this.remaining <= 0) {
        this.remaining = 0;
        this.finishSession({ endAt: this.endAt });
      }
      this.updatePomo();
    }, 1000);
  },

  stopTick() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  },

  // 从后台回来:先用"计划结束时刻"对齐一次,再决定是结束还是继续跑
  syncTimer() {
    if (!this.data.running || !this.endAt) return;
    const remain = Math.max(0, Math.round((this.endAt - Date.now()) / 1000));
    if (remain <= 0) {
      // 后台期间就该结束了:按 endAt 结算这一段,不把后台时间算成专注
      this.remaining = 0;
      this.finishSession({ endAt: this.endAt });
      return;
    }
    this.remaining = remain;
    this.updatePomo();
    this.startTick();   // A1:补建定时器
  },

  // 计时归零的统一出口:先停机,再提示,最后上报。
  // 提示失败不能影响上报,所以两步各自独立 try/catch。
  finishSession(opts) {
    const plan = opts || {};
    if (this._completing) return;   // 防重:onShow 与 tick 可能同时判定结束
    this._completing = true;
    if (this._segmentStartMs) this.creditSegment(plan.endAt || null); // 结算最后一段净专注时长
    this.stopTimer();
    try {
      this.doAlerts();
    } catch (e) {
      console.warn('finishSession: alert failed', e);
    }
    try {
      this.onSessionComplete(plan.endAt || null);
    } catch (e) {
      console.error('finishSession: record failed', e);
      this._completing = false;
    }
  },

  onLoad() {
    const s = this.getSettings();
    this.motto = s.motto || '';
    const marks = [];
    for (let h = 0; h < 24; h++) {
      marks.push({ top: h * HOUR_H, label: String(h).padStart(2, '0') + ':00' });
    }
    this.setData({ hourMarks: marks });
    this.loadCustomModes();
    this.applyTheme();
    this.updatePomo();
    this.loadToday();
    this.loadSessions();
    this.flushPending();   // 上次没传上去的记录,进页面先补
    // 时间线"当前时刻"参考线:30 秒刷新一次。引用必须留住,
    // 否则页面销毁后定时器仍在跑(对已销毁页面 setData)。
    this.nowLineTimerId = setInterval(() => this.refreshNowLine(), 30000);
    this.refreshNowLine();
    // 恢复"正在跑的会话"(页面被销毁重建 / 小程序被回收后重进)
    this.restoreRunning();
  },

  onUnload() {
    // B:不在 onUnload 里无条件 abort —— 底部 tab 切换会触发 onUnload,
    // 之前那版会把正在专注的会话静默丢掉。这里改为:有进度就转成放弃记录,
    // 然后停止本页的定时器(下次进入由 restoreRunning 恢复)。
    this.stopTimer();
    if (this.data.running && this._focusedMs > 30000) {
      this.reportAbandon('离开页面');
    }
    this.abortSession();
    if (this.nowLineTimerId) {
      clearInterval(this.nowLineTimerId);
      this.nowLineTimerId = null;
    }
  },

  onHide() {
    // 只停 tick,保留会话状态:回来后 syncTimer 会按 endAt 对齐
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  },

  onShow() {
    this.applyTheme();
    this.loadToday();
    this.loadSessions();
    this.syncTimer();     // A1 + A3:对齐进度/结束判定/补建定时器
    this.flushPending();
  },

  // ---- 会话恢复(小程序被回收后重进) ----
  restoreRunning() {
    if (this.data.running) return;   // onShow 已经处理过
    let saved = null;
    try { saved = wx.getStorageSync('ts-pomo-running') || null; } catch (e) { saved = null; }
    if (!saved || !saved.endAt) return;
    if (Date.now() >= saved.endAt) {
      try { wx.removeStorageSync('ts-pomo-running'); } catch (e) {}
      return;   // 已经结束了,交给正常流程(记录已在上次结束时上报或进了补传队列)
    }
    this.modes.focus.minutes = saved.focusMinutes || this.modes.focus.minutes;
    this.setData({ mode: saved.mode || 'focus', running: true });
    this.total = saved.total || this.total;
    this.remaining = Math.max(0, Math.round((saved.endAt - Date.now()) / 1000));
    this.endAt = saved.endAt;
    this._sessionStartMs = saved.sessionStartMs || Date.now();
    this._focusedMs = saved.focusedMs || 0;
    this._segmentStartMs = Date.now();
    this._runId = saved.runId || '';
    wx.showToast({ title: '已恢复上次的专注计时', icon: 'none' });
    this.updatePomo();
    this.startTick();
  },

  persistRunning() {
    try {
      if (this.data.running && this.endAt) {
        wx.setStorageSync('ts-pomo-running', {
          mode: this.data.mode,
          endAt: this.endAt,
          total: this.total,
          sessionStartMs: this._sessionStartMs,
          focusedMs: this._focusedMs,
          runId: this._runId,
          focusMinutes: this.modes.focus.minutes
        });
      } else {
        wx.removeStorageSync('ts-pomo-running');
      }
    } catch (e) { /* ignore */ }
  },

  // ---- 自定义时长 ----
  loadCustomModes() {
    try {
      const saved = wx.getStorageSync('ts-pomo-modes');
      if (saved) {
        for (const k of ['focus', 'short', 'long']) {
          const v = Number(saved[k]);
          if (v >= 1 && v <= 180) this.modes[k].minutes = Math.round(v);
        }
      }
      // B5:"自定义休息时间"此前是个死设置(profile 里存了没人用)。
      // 现在它作为短休的默认值,只有用户单独改过短休(ts-pomo-modes)时才被覆盖。
      if (!saved || saved.short === undefined) {
        const rest = Number(util.getSettings().restMin);
        if (rest >= 1 && rest <= 180) this.modes.short.minutes = Math.round(rest);
      }
    } catch (e) { /* ignore */ }
    this.syncModeLabels();
    const m = this.modes[this.data.mode];
    this.total = m.minutes * 60;
    this.remaining = this.total;
  },

  syncModeLabels() {
    this.setData({
      modeFocusLabel: '专注 ' + this.modes.focus.minutes,
      modeShortLabel: '短休 ' + this.modes.short.minutes,
      modeLongLabel: '长休 ' + this.modes.long.minutes
    });
  },

  openCustom() {
    this.setData({
      showCustom: true,
      cFocus: this.modes.focus.minutes,
      cShort: this.modes.short.minutes,
      cLong: this.modes.long.minutes
    });
  },

  closeCustom() { this.setData({ showCustom: false }); },
  onCFocus(e) { this.setData({ cFocus: e.detail.value }); },
  onCShort(e) { this.setData({ cShort: e.detail.value }); },
  onCLong(e) { this.setData({ cLong: e.detail.value }); },
  noop() {},

  saveCustom() {
    const v = (s) => { const n = Math.round(Number(s)); return n >= 1 && n <= 180 ? n : null; };
    const f = v(this.data.cFocus), s = v(this.data.cShort), l = v(this.data.cLong);
    if (f === null || s === null || l === null) {
      wx.showToast({ title: '请输入 1-180 的整数', icon: 'none' });
      return;
    }
    this.modes.focus.minutes = f;
    this.modes.short.minutes = s;
    this.modes.long.minutes = l;
    try { wx.setStorageSync('ts-pomo-modes', { focus: f, short: s, long: l }); } catch (e) {}
    this.stopTimer();
    const m = this.modes[this.data.mode];
    this.total = m.minutes * 60;
    this.remaining = this.total;
    this.syncModeLabels();
    this.setData({ showCustom: false });
    this.updatePomo();
    wx.showToast({ title: '已保存', icon: 'success' });
  },

  // ---- 数据加载 ----
  async loadToday(force) {
    try {
      const r = await statsApi.getFocusStats(!!force);
      if (r.code !== 0) {
        console.error('getFocusStats failed', r.error);
        return;
      }
      const row = (r.byDay || {})[this.todayKeyHint()];
      this.setData({
        todayMinutes: row ? (Number(row.minutes) || 0) : 0,
        todaySessions: row ? (Number(row.sessions) || 0) : 0
      });
    } catch (err) {
      console.error('loadToday failed', err);
    }
  },

  async loadSessions() {
    try {
      const app = getApp();
      const openid = await app.waitOpenid();
      if (!openid) {
        console.warn('loadSessions skipped: openid 未就绪');
        return;
      }
      const db = wx.cloud.database();
      const _ = db.command;
      // B1:不再用服务端 day 字段过滤,改成"本机当天 [00:00, 次日00:00)"的时间戳区间。
      // 归属日期的口径由 util.dayKeyFor 决定(午夜模式 0-4 点算前一天),
      // 这里用同样的偏移把窗口一起前移,读与写在同一天上一致。
      const offset = this.dayOffset();
      const base = new Date(Date.now() + offset * 86400000);
      const start = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, 0, 0);
      const end = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, 0, 0, 0, 0);
      const res = await db.collection('pomo_sessions')
        .where({
          openid,
          type: _.in(['focus', 'short', 'long']),
          startedAt: _.gte(start.toISOString()).and(_.lt(end.toISOString()))
        })
        .orderBy('startedAt', 'desc')
        .limit(100)
        .get();
      const blocks = [];
      const sessionList = [];
      const colors = themeUtil.modeColors(app);
      const TYPE_LABEL = { focus: '专注', short: '短休', long: '长休' };
      for (const s of res.data) {
        const st = new Date(s.startedAt);
        const et = new Date(s.endedAt);
        const startMin = st.getHours() * 60 + st.getMinutes();
        const durMin = Math.max(1, Math.round((et - st) / 60000));
        const hh = String(st.getHours()).padStart(2, '0');
        const mm = String(st.getMinutes()).padStart(2, '0');
        const color = colors[s.type] || colors.focus;
        blocks.push({
          key: s._id,
          top: (startMin / 1440) * DAY_H,
          height: Math.max(10, (durMin / 1440) * DAY_H - 2),
          color,
          title: (TYPE_LABEL[s.type] || '') + ' ' + s.minutes + '分'
        });
        sessionList.push({
          key: s._id,   // B2:wx:key 必须是稳定唯一值(HH:mm 会撞)
          time: hh + ':' + mm,
          typeLabel: (TYPE_LABEL[s.type] || '专注') + ' ' + s.minutes + ' 分钟',
          color,
          isFocus: s.type === 'focus'
        });
      }
      blocks.sort((a, b) => a.top - b.top);
      this.setData({ timelineBlocks: blocks, sessionList });
      this.refreshNowLine();
    } catch (err) {
      console.error('loadSessions failed', err);
    }
  },

  refreshNowLine() {
    const now = new Date();
    const top = ((now.getHours() * 60 + now.getMinutes()) / 1440) * DAY_H;
    this.setData({ nowLineTop: top });
  },

  // ---- 计时 UI ----
  updatePomo() {
    const mm = String(Math.floor(this.remaining / 60)).padStart(2, '0');
    const ss = String(this.remaining % 60).padStart(2, '0');
    const m = this.modes[this.data.mode];
    const pct = Math.max(0, Math.min(100, Math.round((this.remaining / this.total) * 100)));
    const note = this.motto || m.note;
    // C8:模式色跟随主题色(专注=accent),运行中用暖色表示"正在专注"
    const colors = themeUtil.modeColors(getApp());
    this.setData({
      timer: mm + ':' + ss,
      note: note,
      ringColor: this.data.running ? (themeUtil.palette(getApp()).dark ? '#ff8a66' : '#e05f3a') : (colors[this.data.mode] || colors.focus),
      ringPct: pct + '%'
    });
  },

  // A6:切模式/重置前确认,并把已经专注的时长记成"放弃"
  confirmDiscard(actionLabel) {
    return new Promise((resolve) => {
      if (!this.data.running && this._focusedMs < 30000) return resolve(true);
      const mins = Math.max(1, Math.round(this._focusedMs / 60000));
      wx.showModal({
        title: '要放弃这次专注吗?',
        content: `已经专注 ${mins} 分钟,${actionLabel}会结束本次计时并记一次"放弃"。`,
        confirmText: '放弃',
        cancelText: '继续专注',
        success: (res) => resolve(!!res.confirm),
        fail: () => resolve(false)
      });
    });
  },

  async onMode(e) {
    const mode = e.currentTarget.dataset.mode;
    if (mode === this.data.mode) return;
    const ok = await this.confirmDiscard('切换模式');
    if (!ok) return;
    this.reportAbandon('切换模式');
    this.abortSession();
    this.setData({ mode });
    this.total = this.modes[mode].minutes * 60;
    this.remaining = this.total;
    this.updatePomo();
  },

  onToggle() {
    if (this.data.running) {
      this.pauseTimer();      // 暂停:结算这一段净专注时长
    } else {
      if (this.remaining <= 0) this.remaining = this.total;
      if (!this._sessionStartMs) {
        // 本次会话的第一段:记录真实起点并发一个只属于本次会话的幂等键
        this._sessionStartMs = Date.now();
        this._runId = `r${this._sessionStartMs.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
        this._focusedMs = 0;
      }
      this.startAt = this._sessionStartMs;
      this._segmentStartMs = Date.now();
      this.endAt = this._segmentStartMs + this.remaining * 1000;
      this.setData({ running: true });
      this.persistRunning();
      this.startTick();
    }
    this.updatePomo();
  },

  async onReset() {
    const ok = await this.confirmDiscard('重置');
    if (!ok) return;
    this.reportAbandon('重置');
    this.abortSession();
    this.remaining = this.total;
    this.updatePomo();
  },

  // 把当前这段运行时长结算进 _focusedMs(用户暂停 / 结束时调用)
  // atMs 用于"后台期间就该结束"的场景:该段的真实结束时刻是 endAt,不是现在
  creditSegment(atMs) {
    if (!this._segmentStartMs) return;
    const end = atMs && atMs > this._segmentStartMs ? atMs : Date.now();
    this._focusedMs += Math.max(0, end - this._segmentStartMs);
    this._segmentStartMs = 0;
  },

  // 暂停:清定时器但保留会话状态,恢复后接着算
  pauseTimer() {
    this.creditSegment(null);
    this.stopTick();
    this.endAt = 0;
    this.setData({ running: false });
    this.persistRunning();
  },

  // 彻底中止本次会话(切模式 / 重置):不结算、不上报
  abortSession() {
    this.stopTick();
    this.endAt = 0;
    this._sessionStartMs = 0;
    this._focusedMs = 0;
    this._segmentStartMs = 0;
    this._runId = '';
    this._completing = false;
    this.setData({ running: false });
    try { wx.removeStorageSync('ts-pomo-running'); } catch (e) {}
  },

  stopTimer() {
    this.stopTick();
    this.endAt = 0;
    this.setData({ running: false });
    try { wx.removeStorageSync('ts-pomo-running'); } catch (e) {}
  },

  // 归属日期:午夜模式开启时,0-4 点计入前一天。
  // 统一走 util.dayKeyFor,保证与首页/统计/待办集口径一致。
  todayKeyHint() {
    return util.dayKeyFor(this.getSettings());
  },

  // 相对自然日的天偏移(午夜模式归前一天时为 -1)。列表查询与上报都用它,
  // 保证"读"和"写"落在同一天。
  dayOffset() {
    return this.todayKeyHint() === util.todayKey() ? 0 : -1;
  },

  buildRecord(opts) {
    const plan = opts || {};
    const mode = plan.mode || this.data.mode;
    const nominalMinutes = this.modes[mode] ? this.modes[mode].minutes : 25;
    const endedAt = plan.endedAt || Date.now();
    const startedAt = this._sessionStartMs || (endedAt - nominalMinutes * 60000);
    // 净专注时长:暂停的那段不计入,所以它可能小于模式标称时长
    const focusedMs = Math.max(0, this._focusedMs);
    const focusedSeconds = Math.max(1, Math.round(focusedMs / 1000));
    const minutes = Math.max(1, Math.round(focusedSeconds / 60));
    const runId = this._runId || `r${startedAt.toString(36)}`;
    return {
      type: mode,
      minutes,               // 实际专注分钟(暂停不计)
      focusedSeconds,        // 净专注秒数,服务端据此校验/兜底
      wallSeconds: Math.max(0, Math.round((endedAt - startedAt) / 1000)),
      startedAt, endedAt,    // 真实起止(含暂停),用于时间轴展示
      runId,                 // 幂等键:重试沿用同一个值,不会重复入库
      // 日期由服务端按下面两个参数推导,客户端不再直接传 day
      //(防止把 day 填成任意历史日期刷数据)
      tzOffsetMinutes: new Date().getTimezoneOffset(),
      dayOffset: this.dayOffset() // 午夜模式:归前一天
    };
  },

  async onSessionComplete(plannedEndAt) {
    const record = this.buildRecord({ endedAt: plannedEndAt || Date.now() });
    const minutes = record.minutes;
    const mode = record.type;
    pushPending(record);              // 先落本机待补队列,网络失败也不丢
    this.resetSessionState();         // 无论云端结果如何,本机这次会话已结束
    try {
      const r = await this.callRecord(record);
      if (r.code === 0) {
        dropPending(record.runId);
        statsApi.invalidateFocusStats();     // B3:写后失效,下次读拿到新数据
        const label = mode === 'focus' ? '专注' : (mode === 'short' ? '短休' : '长休');
        this.setData({ showDoneBanner: true, lastRecord: minutes });
        wx.showToast({ title: label + '完成 +' + minutes + ' 分钟', icon: 'success' });
        setTimeout(() => this.setData({ showDoneBanner: false }), 4000);
        this.loadToday(true);
        this.loadSessions();
      } else {
        // 服务端明确拒绝(不是网络问题):留在补传队列里没有意义,提示用户
        dropPending(record.runId);
        wx.showToast({ title: r.error || '记录失败', icon: 'none' });
        console.error('recordSession rejected', r.error);
      }
    } catch (err) {
      console.error('recordSession failed', err);
      wx.showToast({ title: '网络不稳,记录已暂存,稍后自动重试', icon: 'none' });
    }
  },

  callRecord(record) {
    return wx.cloud.callFunction({ name: 'recordSession', data: record })
      .then((res) => (res && res.result) || { code: 1, error: '空响应' });
  },

  // 补传上次没成功的记录(离线队列)
  async flushPending() {
    const list = readPending();
    if (!list.length) return;
    const now = Date.now();
    for (const rec of list) {
      if (!rec || !rec.endedAt || now - rec.endedAt > PENDING_WINDOW_MS) {
        dropPending(rec && rec.runId);   // 太旧的补传没有意义,避免把久远数据塞进今天
        continue;
      }
      try {
        const r = await this.callRecord(rec);
        if (r.code === 0) {
          dropPending(rec.runId);
          statsApi.invalidateFocusStats();
        } else {
          dropPending(rec.runId);
          console.warn('flushPending rejected', r.error);
        }
      } catch (e) {
        console.warn('flushPending: still offline', e);
        break;   // 还是不通,下次进页面再试
      }
    }
  },

  // A6:放弃记录(不再静默丢弃)
  async reportAbandon(reason) {
    if (this._focusedMs < 30000) return;   // 不到 30 秒不算一次放弃,避免误触刷数据
    const endedAt = Date.now();
    const startedAt = this._sessionStartMs || (endedAt - this._focusedMs);
    const record = {
      type: 'abandoned',
      minutes: Math.max(1, Math.round(this._focusedMs / 60000)),
      focusedSeconds: Math.max(1, Math.round(this._focusedMs / 1000)),
      wallSeconds: Math.max(0, Math.round((endedAt - startedAt) / 1000)),
      startedAt,
      endedAt,
      runId: this._runId || `a${startedAt.toString(36)}`,
      abandonReason: reason || '',
      tzOffsetMinutes: new Date().getTimezoneOffset(),
      dayOffset: this.dayOffset()
    };
    try {
      await this.callRecord(record);
      statsApi.invalidateFocusStats();
    } catch (e) {
      console.warn('reportAbandon failed', e);   // 放弃记录丢了不影响主流程
    }
  },

  // 一次会话真正结束(已入库或已进补传队列)后调用
  resetSessionState() {
    this._sessionStartMs = 0;
    this._focusedMs = 0;
    this._segmentStartMs = 0;
    this._runId = '';
    this._completing = false;
    this.startAt = 0;
    try { wx.removeStorageSync('ts-pomo-running'); } catch (e) {}
  },

  onPullDownRefresh() {
    this.loadToday(true);
    this.loadSessions();
    wx.stopPullDownRefresh();
  }
});

// pages/pomodoro/pomodoro.js — 番茄钟(自定义时长 + 会话时间轴 + 流水记录)
const util = require('../../utils/util.js');

// 默认模式(可被自定义覆盖)
const DEFAULT_MODES = {
  focus: { label: '专注', minutes: 25, note: '保持专注', color: '#0d9f6d' },
  short: { label: '短休', minutes: 5, note: '休息一下', color: '#3b6fd4' },
  long: { label: '长休', minutes: 15, note: '好好放松', color: '#c9871c' }
};

// 时间轴:每小时高度(px),24 小时
const HOUR_H = 56;
const DAY_H = 24 * HOUR_H;

Page({
  data: {
    themeClass: '',
    colorClass: '',
    mode: 'focus',
    timer: '25:00',
    note: '保持专注',
    ringColor: '#0d9f6d',
    ringPct: '100%',
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
  // 计时统计(2026-09-21 新增,修"暂停后恢复被判时长不符"的问题):
  //   _sessionStartMs  本次会话真实开始时刻(含暂停,只在会话开始时赋值一次)
  //   _focusedMs       本次会话累计的净专注时长
  //   _segmentStartMs  当前这段"正在跑"的起点
  //   _runId           幂等键,会话开始时生成一次,重试沿用,服务端据此挡重复
  _sessionStartMs: 0,
  _focusedMs: 0,
  _segmentStartMs: 0,
  _runId: '',

  getSettings() {
    try { return wx.getStorageSync('ts-settings') || {}; } catch (e) { return {}; }
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

  // 计时归零的统一出口:先停机,再提示,最后上报。
  // 提示失败不能影响上报,所以两步各自独立 try/catch。
  finishSession() {
    if (this._segmentStartMs) this.creditSegment();  // 结算最后一段净专注时长
    this.stopTimer();
    try {
      this.doAlerts();
    } catch (e) {
      console.warn('finishSession: alert failed', e);
    }
    try {
      this.onSessionComplete();
    } catch (e) {
      console.error('finishSession: record failed', e);
    }
  },

  motto: '',

  onLoad() {
    const s = this.getSettings();
    this.motto = s.motto || '';
    const marks = [];
    for (let h = 0; h < 24; h++) {
      marks.push({ top: h * HOUR_H, label: String(h).padStart(2, '0') + ':00' });
    }
    this.setData({ hourMarks: marks });
    this.loadCustomModes();
    this.updatePomo();
    this.loadToday();
    this.loadSessions();
    // 时间线"当前时刻"参考线:30 秒刷新一次。引用必须留住,
    // 否则页面销毁后定时器仍在跑(对已销毁页面 setData)。
    this.nowLineTimerId = setInterval(() => this.refreshNowLine(), 30000);
    this.refreshNowLine();
  },

  onUnload() {
    this.stopTimer();
    // 离开页面即放弃未完成的会话(不落库),避免残留的计时/幂等键影响下一次
    this.abortSession();
    if (this.nowLineTimerId) {
      clearInterval(this.nowLineTimerId);
      this.nowLineTimerId = null;
    }
  },

  onHide() {
    if (this.data.running && this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  },

  onShow() {
    const app = getApp();
    if (app.setNavBar) app.setNavBar();
    this.setData({ themeClass: app.theme === 'dark' ? 'theme-dark' : '',
      colorClass: app.themeColor ? ({"green":"","blue":"theme-blue","orange":"theme-orange","purple":"theme-purple","pink":"theme-pink"})[app.themeColor] || '' : '' });
    this.loadToday();
    this.loadSessions();
    if (this.data.running && this.endAt > 0) {
      this.remaining = Math.max(0, Math.round((this.endAt - Date.now()) / 1000));
      if (this.remaining <= 0) {
        this.remaining = 0;
        this.finishSession();
      }
      this.updatePomo();
    }
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
  async loadToday() {
    try {
      const app = getApp();
      const openid = await app.waitOpenid();
      if (!openid) {
        console.warn('loadToday skipped: openid 未就绪');
        return;
      }
      const db = wx.cloud.database();
      const res = await db.collection('focus_log').where({ openid }).limit(1000).get();
      const today = this.todayKeyHint();
      let minutes = 0, sessions = 0;
      for (const r of res.data) {
        if (r.day === today) {
          minutes += r.minutes;
          sessions += r.sessions;
        }
      }
      this.setData({ todayMinutes: minutes, todaySessions: sessions });
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
      const today = this.todayKeyHint();
      const res = await db.collection('pomo_sessions')
        .where({ openid, day: today })
        .orderBy('startedAt', 'desc')
        .limit(100)
        .get();
      const blocks = [];
      const sessionList = [];
      const TYPE_LABEL = { focus: '专注', short: '短休', long: '长休' };
      const TYPE_COLOR = { focus: '#0d9f6d', short: '#3b6fd4', long: '#c9871c' };
      for (const s of res.data) {
        const st = new Date(s.startedAt);
        const et = new Date(s.endedAt);
        const startMin = st.getHours() * 60 + st.getMinutes();
        const durMin = Math.max(1, Math.round((et - st) / 60000));
        const hh = String(st.getHours()).padStart(2, '0');
        const mm = String(st.getMinutes()).padStart(2, '0');
        blocks.push({
          top: (startMin / 1440) * DAY_H,
          height: Math.max(10, (durMin / 1440) * DAY_H - 2),
          color: TYPE_COLOR[s.type] || '#0d9f6d',
          title: (TYPE_LABEL[s.type] || '') + ' ' + s.minutes + '分'
        });
        sessionList.push({
          time: hh + ':' + mm,
          typeLabel: (TYPE_LABEL[s.type] || '专注') + ' ' + s.minutes + ' 分钟',
          color: TYPE_COLOR[s.type] || '#0d9f6d',
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
    this.setData({
      timer: mm + ':' + ss,
      note: note,
      ringColor: this.data.running ? '#e05f3a' : m.color,
      ringPct: pct + '%'
    });
  },

  onMode(e) {
    const mode = e.currentTarget.dataset.mode;
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
      this.intervalId = setInterval(() => {
        this.remaining = Math.max(0, Math.round((this.endAt - Date.now()) / 1000));
        if (this.remaining <= 0) {
          this.remaining = 0;
          this.finishSession();
        }
        this.updatePomo();
      }, 1000);
    }
    this.updatePomo();
  },

  onReset() {
    this.abortSession();
    this.remaining = this.total;
    this.updatePomo();
  },

  // 把当前这段运行时长结算进 _focusedMs(用户暂停 / 结束时调用)
  creditSegment() {
    if (this._segmentStartMs) {
      this._focusedMs += Math.max(0, Date.now() - this._segmentStartMs);
      this._segmentStartMs = 0;
    }
  },

  // 暂停:清定时器但保留会话状态,恢复后接着算
  pauseTimer() {
    this.creditSegment();
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.endAt = 0;
    this.setData({ running: false });
  },

  // 彻底中止本次会话(切模式 / 重置):不结算、不上报
  abortSession() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.endAt = 0;
    this._sessionStartMs = 0;
    this._focusedMs = 0;
    this._segmentStartMs = 0;
    this._runId = '';
    this.setData({ running: false });
  },

  stopTimer() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.endAt = 0;
    this.setData({ running: false });
  },

  // 归属日期:午夜模式开启时,0-4 点计入前一天。
  // 统一走 util.dayKeyFor,保证与首页/统计/待办集口径一致。
  todayKeyHint() {
    return util.dayKeyFor(this.getSettings());
  },

  async onSessionComplete() {
    const mode = this.data.mode;
    const nominalMinutes = this.modes[mode].minutes;
    const endedAt = Date.now();
    const startedAt = this._sessionStartMs || (endedAt - nominalMinutes * 60000);
    // 净专注时长:暂停的那段不计入,所以它可能小于模式标称时长
    const focusedMs = this._focusedMs > 0 ? this._focusedMs : (endedAt - startedAt);
    const focusedSeconds = Math.max(1, Math.round(focusedMs / 1000));
    const minutes = Math.max(1, Math.round(focusedSeconds / 60));
    const runId = this._runId || `r${startedAt.toString(36)}`;
    try {
      const res = await wx.cloud.callFunction({
        name: 'recordSession',
        data: {
          type: mode,
          minutes,               // 实际专注分钟(暂停不计)
          focusedSeconds,        // 净专注秒数,服务端据此校验
          startedAt, endedAt,    // 真实起止(含暂停),用于时间轴展示
          runId,                 // 幂等键:重试沿用同一个值,不会重复入库
          // 日期由服务端按这个偏移从 endedAt 推导,客户端不再直接传 day
          // (防止把 day 填成历史任意一天刷数据)
          tzOffsetMinutes: new Date().getTimezoneOffset()
        }
      });
      const r = res.result || {};
      if (r.code === 0) {
        const label = mode === 'focus' ? '专注' : (mode === 'short' ? '短休' : '长休');
        this.setData({ showDoneBanner: true, lastRecord: minutes });
        wx.showToast({ title: label + '完成 +' + minutes + ' 分钟', icon: 'success' });
        setTimeout(() => this.setData({ showDoneBanner: false }), 4000);
        this.resetSessionState();   // 已入库,清掉本次会话的计时与幂等键
        this.loadToday();
        this.loadSessions();
      } else {
        // 入库失败:保留 _runId 与计时状态,用户可重试且不会重复计数
        wx.showToast({ title: r.error || '记录失败', icon: 'none' });
      }
    } catch (err) {
      console.error('recordSession failed', err);
      wx.showToast({ title: '记录失败,请检查网络', icon: 'none' });
    }
  },

  // 一次会话真正结束(已入库)后调用
  resetSessionState() {
    this._sessionStartMs = 0;
    this._focusedMs = 0;
    this._segmentStartMs = 0;
    this._runId = '';
    this.startAt = 0;
  },

  onPullDownRefresh() {
    this.loadToday();
    this.loadSessions();
    wx.stopPullDownRefresh();
  }
});
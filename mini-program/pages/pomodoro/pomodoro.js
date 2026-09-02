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
  endAt: 0,

  getSettings() {
    try { return wx.getStorageSync('ts-settings') || {}; } catch (e) { return {}; }
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
    setInterval(() => this.refreshNowLine(), 30000);
    this.refreshNowLine();
  },

  onUnload() {
    this.stopTimer();
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
        this.stopTimer();
        this.doAlerts();
        this.onSessionComplete();
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
      const db = wx.cloud.database();
      const res = await db.collection('focus_log').limit(1000).get();
      const today = util.todayKey();
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
      const db = wx.cloud.database();
      const today = util.todayKey();
      const res = await db.collection('pomo_sessions')
        .where({ day: today })
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
    this.stopTimer();
    this.setData({ mode });
    this.total = this.modes[mode].minutes * 60;
    this.remaining = this.total;
    this.updatePomo();
  },

  onToggle() {
    if (this.data.running) {
      this.stopTimer();
    } else {
      if (this.remaining <= 0) this.remaining = this.total;
      this.startAt = Date.now();
      this.endAt = this.startAt + this.remaining * 1000;
      this.setData({ running: true });
      this.intervalId = setInterval(() => {
        this.remaining = Math.max(0, Math.round((this.endAt - Date.now()) / 1000));
        if (this.remaining <= 0) {
          this.remaining = 0;
          this.stopTimer();
          this.doAlerts();
          this.onSessionComplete();
        }
        this.updatePomo();
      }, 1000);
    }
    this.updatePomo();
  },

  onReset() {
    this.stopTimer();
    this.remaining = this.total;
    this.updatePomo();
  },

  stopTimer() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.endAt = 0;
    this.setData({ running: false });
  },

  // 归属日期:午夜模式开启时,0-4 点计入前一天
  todayKeyHint() {
    const s = this.getSettings();
    if (s.midnightOn) {
      const now = new Date();
      const h = now.getHours();
      if (h >= 0 && h < 4) {
        const d = new Date(now);
        d.setDate(d.getDate() - 1);
        return util.dateKey(d);
      }
    }
    return util.todayKey();
  },

  async onSessionComplete() {
    const mode = this.data.mode;
    const minutes = this.modes[mode].minutes;
    const startedAt = this.startAt || (Date.now() - minutes * 60000);
    const endedAt = Date.now();
    try {
      const res = await wx.cloud.callFunction({
        name: 'recordSession',
        data: { type: mode, minutes, startedAt, endedAt, day: this.todayKeyHint() }
      });
      const r = res.result || {};
      if (r.code === 0) {
        const label = mode === 'focus' ? '专注' : (mode === 'short' ? '短休' : '长休');
        this.setData({ showDoneBanner: true, lastRecord: minutes });
        wx.showToast({ title: label + '完成 +' + minutes + ' 分钟', icon: 'success' });
        setTimeout(() => this.setData({ showDoneBanner: false }), 4000);
        this.loadToday();
        this.loadSessions();
      } else {
        wx.showToast({ title: r.error || '记录失败', icon: 'none' });
      }
    } catch (err) {
      console.error('recordSession failed', err);
      wx.showToast({ title: '记录失败,请检查网络', icon: 'none' });
    }
  },

  onPullDownRefresh() {
    this.loadToday();
    this.loadSessions();
    wx.stopPullDownRefresh();
  }
});
// pages/pomodoro/pomodoro.js — 番茄钟(完成专注后调用云函数记录,防造假)
const util = require('../../utils/util.js');

const MODES = {
  focus: { label: '专注', minutes: 25, note: '保持专注', color: '#0d9f6d' },
  short: { label: '短休', minutes: 5, note: '休息一下', color: '#3b6fd4' },
  long: { label: '长休', minutes: 15, note: '好好放松', color: '#c9871c' }
};

Page({
  data: {
    themeClass: '',
    mode: 'focus',
    timer: '25:00',
    note: '保持专注',
    ringColor: '#0d9f6d',
    ringPct: '100%',
    running: false,
    todaySessions: 0,
    todayMinutes: 0,
    showDoneBanner: false,
    lastRecord: 0
  },

  total: MODES.focus.minutes * 60,
  remaining: MODES.focus.minutes * 60,
  intervalId: null,
  endAt: 0,   // 结束时间戳(后台计时用)

  onLoad() {
    this.updatePomo();
    this.loadToday();
  },

  onUnload() {
    this.stopTimer();
  },

  onHide() {
    // 切后台不停表:endAt 时间戳继续走,onShow 回来时校准
    if (this.data.running && this.intervalId) {
      clearInterval(this.intervalId); // 后台 interval 不可靠,回来再校准
      this.intervalId = null;
    }
  },

  onShow() {
    const app = getApp();
    if (app.setNavBar) app.setNavBar();
    this.setData({ themeClass: app.theme === 'dark' ? 'theme-dark' : '' });
    this.loadToday();
    // 从后台回来:如果计时器本应运行,校准剩余时间
    if (this.data.running && this.endAt > 0) {
      this.remaining = Math.max(0, Math.round((this.endAt - Date.now()) / 1000));
      if (this.remaining <= 0) {
        this.remaining = 0;
        this.stopTimer();
        wx.vibrateLong();
        if (this.data.mode === 'focus') this.recordFocus();
      }
      this.updatePomo();
    }
  },

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

  updatePomo() {
    const mm = String(Math.floor(this.remaining / 60)).padStart(2, '0');
    const ss = String(this.remaining % 60).padStart(2, '0');
    const m = MODES[this.data.mode];
    const pct = Math.round((this.remaining / this.total) * 100);
    this.setData({
      timer: mm + ':' + ss,
      note: m.note,
      ringColor: this.data.running ? '#e05f3a' : m.color,
      ringPct: pct + '%'
    });
  },

  onMode(e) {
    const mode = e.currentTarget.dataset.mode;
    this.stopTimer();
    this.setData({ mode });
    this.total = MODES[mode].minutes * 60;
    this.remaining = this.total;
    this.updatePomo();
  },

  onToggle() {
    if (this.data.running) {
      this.stopTimer();
    } else {
      if (this.remaining <= 0) this.remaining = this.total;
      // 时间戳计时:记下结束时刻,后台切回时按真实时间校准
      this.endAt = Date.now() + this.remaining * 1000;
      this.setData({ running: true });
      this.intervalId = setInterval(() => {
        this.remaining = Math.max(0, Math.round((this.endAt - Date.now()) / 1000));
        if (this.remaining <= 0) {
          this.remaining = 0;
          this.stopTimer();
          wx.vibrateLong();
          setTimeout(() => wx.vibrateShort({ fail: () => {} }), 300);
          if (this.data.mode === 'focus') this.recordFocus();
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

  // 完成专注 → 云函数记录(服务端校验 25 的倍数)
  async recordFocus() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'addFocus',
        data: { day: util.todayKey(), minutes: 25 }
      });
      const r = res.result || {};
      if (r.code === 0) {
        this.setData({ showDoneBanner: true, lastRecord: r.minutes || 25 });
        wx.showToast({ title: '专注完成 +25 分钟', icon: 'success' });
        setTimeout(() => this.setData({ showDoneBanner: false }), 4000);
        this.loadToday();
      } else {
        wx.showToast({ title: r.error || '记录失败', icon: 'none' });
      }
    } catch (err) {
      console.error('recordFocus failed', err);
      wx.showToast({ title: '记录失败,请检查网络', icon: 'none' });
    }
  },

  onPullDownRefresh() {    this.loadToday();
    wx.stopPullDownRefresh();
  },
});
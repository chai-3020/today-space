// pages/pomodoro/pomodoro.js — 番茄钟(完成专注后调用云函数记录,防造假)
const util = require('../../utils/util.js');

const MODES = {
  focus: { label: '专注', minutes: 25, note: '保持专注', color: '#0d9f6d' },
  short: { label: '短休', minutes: 5, note: '休息一下', color: '#3b6fd4' },
  long: { label: '长休', minutes: 15, note: '好好放松', color: '#c9871c' }
};

Page({
  data: {
    mode: 'focus',
    timer: '25:00',
    note: '保持专注',
    ringColor: '#0d9f6d',
    ringPct: '100%',
    running: false,
    todaySessions: 0,
    todayMinutes: 0
  },

  total: MODES.focus.minutes * 60,
  remaining: MODES.focus.minutes * 60,
  intervalId: null,

  onLoad() {
    this.updatePomo();
    this.loadToday();
  },

  onUnload() {
    this.stopTimer();
  },

  onHide() {
    this.stopTimer();
    this.updatePomo();
  },

  onShow() { this.loadToday(); },

  async loadToday() {
    try {
      const db = wx.cloud.database();
      const res = await db.collection('focus_log').get();
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
      this.setData({ running: true });
      this.intervalId = setInterval(() => {
        this.remaining -= 1;
        if (this.remaining <= 0) {
          this.remaining = 0;
          this.stopTimer();
          wx.vibrateLong();
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
        wx.showToast({ title: '专注完成 +25 分钟', icon: 'success' });
        this.loadToday();
      } else {
        wx.showToast({ title: r.error || '记录失败', icon: 'none' });
      }
    } catch (err) {
      console.error('recordFocus failed', err);
      wx.showToast({ title: '记录失败,请检查网络', icon: 'none' });
    }
  }
});

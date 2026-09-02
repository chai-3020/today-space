// pages/todolist/todolist.js — 待办集(汇总+入口)
const util = require('../../utils/util.js');

Page({
  data: {
    themeClass: '',
    colorClass: '',
    todayKey: '',
    todoAll: 0,
    todoDone: 0,
    focusMins: 0
  },

  onShow() {
    const app = getApp();
    if (app.setNavBar) app.setNavBar();
    this.setData({ themeClass: app.theme === 'dark' ? 'theme-dark' : '',
      colorClass: app.themeColor ? ({"green":"","blue":"theme-blue","orange":"theme-orange","purple":"theme-purple","pink":"theme-pink"})[app.themeColor] || '' : '', todayKey: util.todayKey() });
    this.loadData();
  },

  async loadData() {
    try {
      const db = wx.cloud.database();
      const [todoRes, focusRes] = await Promise.all([
        db.collection('todos').limit(100).get(),
        db.collection('focus_log').limit(1000).get()
      ]);
      const todos = todoRes.data || [];
      const done = todos.filter((t) => t.done).length;
      const today = util.todayKey();
      let mins = 0;
      for (const r of focusRes.data || []) {
        if (r.day === today) mins += r.minutes || 0;
      }
      this.setData({ todoAll: todos.length, todoDone: done, focusMins: mins });
    } catch (err) {
      console.error('todolist load failed', err);
    }
  },

  goTodo() { wx.switchTab({ url: '/pages/index/index' }); },
  goPomodoro() { wx.navigateTo({ url: '/pages/pomodoro/pomodoro' }); },
  goNotes() { wx.navigateTo({ url: '/pages/notes/notes' }); },
  goStats() { wx.switchTab({ url: '/pages/stats/stats' }); },

  onPullDownRefresh() {
    this.loadData();
    wx.stopPullDownRefresh();
  }
});
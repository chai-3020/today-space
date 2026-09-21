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
      colorClass: app.themeColor ? ({"green":"","blue":"theme-blue","orange":"theme-orange","purple":"theme-purple","pink":"theme-pink"})[app.themeColor] || '' : '', todayKey: util.dayKeyFor(util.getSettings()) });
    this.loadData();
  },

  async loadData() {
    try {
      const app = getApp();
      const openid = await app.waitOpenid();
      if (!openid) console.warn('todolist loadData: openid 未就绪,focus_log 查询已跳过');
      const db = wx.cloud.database();
      const [todoRes, focusRes] = await Promise.all([
        db.collection('todos').limit(100).get(),
        openid
          ? db.collection('focus_log').where({ openid }).limit(1000).get()
          : Promise.resolve({ data: [] })
      ]);
      const todos = todoRes.data || [];
      const done = todos.filter((t) => t.done).length;
      // 归属日期统一走 util.dayKeyFor(午夜模式),与番茄钟写入端、其它页面同口径
      const today = util.dayKeyFor(util.getSettings());
      let mins = 0;
      for (const r of focusRes.data || []) {
        if (r && r.day === today) mins += Number(r.minutes) || 0;
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
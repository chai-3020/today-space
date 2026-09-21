// pages/todolist/todolist.js — 待办集(汇总+入口)
const util = require('../../utils/util.js');
const themeUtil = require('../../utils/theme.js');
const statsApi = require('../../utils/focus-stats.js');

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
      colorClass: themeUtil.colorClass(app.themeColor), todayKey: util.dayKeyFor(util.getSettings()) });
    this.loadData();
  },

  async loadData(force) {
    try {
      const app = getApp();
      const openid = await app.waitOpenid();
      if (!openid) console.warn('todolist loadData: openid 未就绪,focus 统计已跳过');
      const db = wx.cloud.database();
      // 待办仍然直读客户端集合(权限规则保证只返回自己的);
      // focus_log 的全量拉取已改为云函数服务端聚合(见 getFocusStats),
      // 并由 utils/focus-stats.js 做会话内缓存,避免四个页面各请求一次。
      const [todoRes, stats] = await Promise.all([
        db.collection('todos').limit(100).get(),
        openid ? statsApi.getFocusStats(!!force) : Promise.resolve(null)
      ]);
      const todos = todoRes.data || [];
      const done = todos.filter((t) => t.done).length;
      // 归属日期统一走 util.dayKeyFor(午夜模式),与番茄钟写入端、其它页面同口径
      const today = util.dayKeyFor(util.getSettings());
      let mins = 0;
      if (stats && stats.code === 0) {
        const row = (stats.byDay || {})[today];
        mins = row ? (Number(row.minutes) || 0) : 0;
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
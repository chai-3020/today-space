// pages/index/index.js — 概览 + 待办(云数据库)
const util = require('../../utils/util.js');
const themeUtil = require('../../utils/theme.js');
const statsApi = require('../../utils/focus-stats.js');
const app = getApp();

Page({
  data: {
    greeting: '你好',
    nickname: '',
    clock: '00:00:00',
    dateLine: '',
    statDone: 0,
    statFocus: 0,
    todos: [],
    visibleTodos: [],
    filter: 'all',
    doneCount: 0,
    todoCount: 0,
    todoInput: '',
    emptyText: '这里空空的,添加第一件事吧',
    focusLog: { byDay: {}, sessions: {} },
    showNameModal: false,
    nameInput: '',
    dayPct: 0,
    dayNew: true,
    noDoneLine: false,
    themeClass: '',
    colorClass: ''
  },

  onLoad() {
    this.settings = this.getSettings();
    this.setData({ noDoneLine: !!this.settings.noDoneLine });
    this.tick();
    this.startClock();
    this.init();
  },

  // 2026-09-21 补:onLoad 一直在调用 this.getSettings(),但本文件从未定义它,
  // onLoad 第 30 行抛 TypeError 后 tick/startClock/init 全都执行不到
  // (时钟不动、昵称不刷新、专注统计不加载)。统一走 util.getSettings()。
  getSettings() {
    return util.getSettings();
  },

  startClock() {
    if (this._clockTimer) { clearInterval(this._clockTimer); }
    this._clockTimer = setInterval(() => this.tick(), 1000);
  },

  onShow() {
    const app = getApp();
    if (!this._clockTimer) this.startClock();
    if (app.setNavBar) app.setNavBar();
    this.setData({ themeClass: app.theme === 'dark' ? 'theme-dark' : '',
      colorClass: themeUtil.colorClass(app.themeColor) });
    this.loadTodos();
    this.loadFocus();
    const nickname = app.globalData.nickname || '新朋友';
    this.setData({ nickname });
  },

  async init() {
    await app.ready();
    const nickname = app.globalData.nickname || '新朋友';
    this.setData({ nickname });
    this.loadTodos();
    this.loadFocus();
    // 首次使用引导
    try {
      const shown = wx.getStorageSync('ts-guide-shown');
      if (!shown) {
        wx.setStorageSync('ts-guide-shown', true);
        setTimeout(() => {
          wx.showToast({ title: '点顶部昵称可改名', icon: 'none', duration: 2500 });
        }, 800);
      }
    } catch (e) { /* ignore */ }
  },

  tick() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    // 2026-09-21 修 "今日进度" 三个问题:
    //  ① 原来 Math.round 会把一天开头几分钟压成 0%(24 分钟内 <0.5%),
    //     进度条 track 有、fill 却是 0 宽 —— 看起来就是"进度条坏了/没显示";
    //     现在起步即 1%,配合 "新的一天" 文案,一天开始是可见的。
    //  ② 分母不再写死 86400000:用 明天0点 - 今天0点,夏令时切换那天
    //     (23/25 小时) 也不会算偏。
    //  ③ 顺带给"进度不足 1%"(凌晨刚过零点)一个 dayNew 标记,页面显示"新的一天"。
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const span = end - start;
    const dayPct = Math.min(100, Math.max(1, Math.ceil(((now - start) / span) * 100)));
    this.setData({
      clock: util.fmtClock(now),
      dayPct,
      dayNew: dayPct <= 1,
      dateLine: now.getFullYear() + ' 年 ' + (now.getMonth() + 1) + ' 月 ' + now.getDate() + ' 日 星期' + util.weekdays[now.getDay()],
      greeting: util.greeting() + ',今天也从容一点'
    });
  },

  // ---- 待办 ----
  async loadTodos() {
    try {
      const db = wx.cloud.database();
      let res;
      if (this.settings && this.settings.fixedSort) {
        // 固定排序:仅按创建时间倒序,已完成不沉底
        res = await db.collection('todos').orderBy('createdAt', 'desc').limit(100).get();
      } else {
        // 默认:未完成在前,已完成沉底
        res = await db.collection('todos').orderBy('done', 'asc').orderBy('createdAt', 'desc').limit(100).get();
      }
      const todos = res.data;
      this.setData({ todos, todoCount: todos.length });
      this.applyFilter();
    } catch (err) {
      console.error('loadTodos failed', err);
      wx.showToast({ title: '加载待办失败', icon: 'none' });
    }
  },

  applyFilter() {
    const { todos, filter } = this.data;
    const visibleTodos = todos.filter((t) => {
      if (filter === 'active') return !t.done;
      if (filter === 'done') return t.done;
      return true;
    });
    const doneCount = todos.filter((t) => t.done).length;
    this.setData({
      visibleTodos,
      doneCount,
      emptyText: filter === 'done' ? '还没有完成的事项' : '这里空空的,添加第一件事吧'
    });
    this.setData({ statDone: doneCount });
  },

  onTodoInput(e) { this.setData({ todoInput: e.detail.value }); },

  async onAddTodo() {
    const text = (this.data.todoInput || '').trim();
    if (!text) return;
    try {
      const db = wx.cloud.database();
      await db.collection('todos').add({
        data: { text, done: false, createdAt: new Date().toISOString() }
      });
      this.setData({ todoInput: '' });
      this.loadTodos();
    } catch (err) {
      wx.showToast({ title: '添加失败', icon: 'none' });
    }
  },

  onFilter(e) {
    this.setData({ filter: e.currentTarget.dataset.filter });
    this.applyFilter();
  },

  async onToggleTodo(e) {
    const id = e.currentTarget.dataset.id;
    const todo = this.data.todos.find((t) => t._id === id);
    if (!todo) return;
    try {
      const db = wx.cloud.database();
      await db.collection('todos').doc(id).update({
        data: { done: !todo.done }
      });
      this.loadTodos();
    } catch (err) {
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  async onDeleteTodo(e) {
    const id = e.currentTarget.dataset.id;
    try {
      const db = wx.cloud.database();
      await db.collection('todos').doc(id).remove();
      this.loadTodos();
    } catch (err) {
      wx.showToast({ title: '删除失败', icon: 'none' });
    }
  },

  async onClearDone() {
    const doneList = this.data.todos.filter((t) => t.done);
    if (!doneList.length) return;
    try {
      // 2026-09-21 改造:原来在客户端 for-await 逐条 remove(),
      // N 条就是 N 次网络往返,中途失败还会留下"删了一半"。
      // 改为云函数批量删除(服务端按 openid + done 一次删掉)。
      const res = await wx.cloud.callFunction({ name: 'clearDoneTodos' });
      const r = res.result || {};
      if (r.code === 0) {
        wx.showToast({ title: `已清除 ${r.removed || doneList.length} 条`, icon: 'success' });
        this.loadTodos();
      } else {
        wx.showToast({ title: r.error || '清除失败', icon: 'none' });
      }
    } catch (err) {
      console.error('clearDoneTodos failed', err);
      wx.showToast({ title: '清除失败', icon: 'none' });
    }
  },

  // ---- 专注 ----
  async loadFocus(force) {
    try {
      // 2026-09-21:改走云函数服务端聚合(原来在这里拉 focus_log 全量再自己累加)
      // 2026-09-21d:再包一层 utils/focus-stats.js 的会话内缓存 —— 首页/番茄钟/
      // 统计/待办集四个页面 onShow 都读同一份数据,缓存后一次逛 app 只请求一次。
      const r = await statsApi.getFocusStats(!!force);
      if (r.code !== 0) {
        console.error('getFocusStats failed', r.error);
        return;
      }
      const byDay = {};
      const sessions = {};
      for (const [day, row] of Object.entries(r.byDay || {})) {
        if (!day || !row) continue;                        // 跳过脏数据,避免 NaN 污染整页
        byDay[day] = Number(row.minutes) || 0;
        sessions[day] = Number(row.sessions) || 0;
      }
      this.setData({ focusLog: { byDay, sessions } });
      // 归属日期走 util.dayKeyFor:与番茄钟的写入端、其它页面保持同一口径(午夜模式)
      const today = util.dayKeyFor(this.getSettings());
      this.setData({ statFocus: byDay[today] || 0 });
    } catch (err) {
      console.error('loadFocus failed', err);
    }
  },

  noop() {},

  // ---- 昵称设置 ----
  onEditName() {
    const app = getApp();
    this.setData({ showNameModal: true, nameInput: app.globalData.nickname || '' });
  },
  onNameInput(e) { this.setData({ nameInput: e.detail.value }); },
  onNameCancel() { this.setData({ showNameModal: false }); },
  async onNameConfirm() {
    const name = (this.data.nameInput || '').trim();
    if (!name) { wx.showToast({ title: '昵称不能为空', icon: 'none' }); return; }
    if (!/^[\u4e00-\u9fa5A-Za-z0-9_-]+$/.test(name)) {
      wx.showToast({ title: '只能含中文、字母、数字、_ 和 -', icon: 'none' }); return;
    }
    try {
      const res = await wx.cloud.callFunction({ name: 'updateProfile', data: { name } });
      const r = res.result || {};
      if (r.code === 0) {
        const app = getApp();
        app.globalData.nickname = name;
        this.setData({ nickname: name, showNameModal: false });
        wx.showToast({ title: '昵称已更新', icon: 'success' });
      } else {
        wx.showToast({ title: r.error || '设置失败', icon: 'none' });
      }
    } catch (err) {
      wx.showToast({ title: '设置失败,请检查网络', icon: 'none' });
    }
  },

  onPullDownRefresh() {    this.loadTodos();
    this.loadFocus();
    const app = getApp();
    this.setData({ nickname: app.globalData.nickname || '新朋友' });
    wx.stopPullDownRefresh();
  },

  // ---- 待办编辑(长按) ----
  onEditTodo(e) {
    const id = e.currentTarget.dataset.id;
    const oldText = e.currentTarget.dataset.text || '';
    wx.showModal({
      title: '编辑待办',
      editable: true,
      placeholderText: '输入新内容',
      content: oldText,
      success: async (res) => {
        if (!res.confirm) return;
        const text = (res.content || '').trim();
        if (!text) return;
        try {
          const db = wx.cloud.database();
          await db.collection('todos').doc(id).update({ data: { text } });
          this.loadTodos();
        } catch (err) {
          wx.showToast({ title: '保存失败', icon: 'none' });
        }
      }
    });
  },

  // ---- 主题切换 ----
  onToggleTheme() {
    const app = getApp();
    app.toggleTheme();
    this.setData({ themeClass: app.theme === 'dark' ? 'theme-dark' : '' });
  },
});
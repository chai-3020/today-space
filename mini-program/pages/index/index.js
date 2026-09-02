// pages/index/index.js — 概览 + 待办(云数据库)
const util = require('../../utils/util.js');
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
    dayPct: 0
  },

  onLoad() {
    this.tick();
    setInterval(() => this.tick(), 1000);
    this.init();
  },

  onShow() {
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
  },

  tick() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayPct = Math.min(100, Math.max(0, Math.round(((now - start) / 86400000) * 100)));
    this.setData({
      clock: util.fmtClock(now),
      dayPct,
      dateLine: now.getFullYear() + ' 年 ' + (now.getMonth() + 1) + ' 月 ' + now.getDate() + ' 日 星期' + util.weekdays[now.getDay()],
      greeting: util.greeting() + ',今天也从容一点'
    });
  },

  // ---- 待办 ----
  async loadTodos() {
    try {
      const db = wx.cloud.database();
      const res = await db.collection('todos').orderBy('createdAt', 'desc').limit(100).get();
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
    try {
      const db = wx.cloud.database();
      for (const t of doneList) {
        await db.collection('todos').doc(t._id).remove();
      }
      this.loadTodos();
    } catch (err) {
      wx.showToast({ title: '清除失败', icon: 'none' });
    }
  },

  // ---- 专注 ----
  async loadFocus() {
    try {
      const db = wx.cloud.database();
      const res = await db.collection('focus_log').limit(1000).get();
      const byDay = {};
      const sessions = {};
      for (const r of res.data) {
        byDay[r.day] = (byDay[r.day] || 0) + r.minutes;
        sessions[r.day] = (sessions[r.day] || 0) + r.sessions;
      }
      this.setData({ focusLog: { byDay, sessions } });
      const today = util.todayKey();
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
});
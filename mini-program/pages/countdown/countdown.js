// pages/countdown/countdown.js — 未来倒计时
const util = require('../../utils/util.js');

Page({
  data: {
    themeClass: '',
    colorClass: '',
    items: [],
    showModal: false,
    title: '',
    targetDate: ''
  },

  onShow() {
    const app = getApp();
    if (app.setNavBar) app.setNavBar();
    this.setData({ themeClass: app.theme === 'dark' ? 'theme-dark' : '',
      colorClass: app.themeColor ? ({"green":"","blue":"theme-blue","orange":"theme-orange","purple":"theme-purple","pink":"theme-pink"})[app.themeColor] || '' : '' });
    this.load();
  },

  async load() {
    try {
      const db = wx.cloud.database();
      // B6:这条查询**故意**不带 openid 条件 —— 隔离完全依赖集合权限
      // "仅创建者可读写"(客户端写入时平台自动注入 _openid)。
      // ⚠️ 一旦把这个集合的权限放宽成"所有用户可读",所有人会互相看到对方的倒计时。
      const res = await db.collection('countdowns')
        .orderBy('targetDate', 'asc')
        .limit(100)
        .get();
      const today = util.todayKey();
      const todayDate = new Date(today + 'T00:00:00');
      const items = (res.data || []).map((c) => {
        const target = new Date(String(c.targetDate || '') + 'T00:00:00');
        const diff = target - todayDate;
        const days = isNaN(diff) ? 0 : Math.max(0, Math.round(diff / 86400000));
        return {
          _id: c._id,
          title: c.title || '',
          targetDate: c.targetDate,
          days,
          urgent: days <= 7
        };
      });
      this.setData({ items });
    } catch (err) {
      console.error('countdown load failed', err);
      wx.showToast({ title: '加载失败,请重试', icon: 'none' });
    }
  },

  onAdd() {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    this.setData({ showModal: true, title: '', targetDate: util.dateKey(d) });
  },
  onCancel() { this.setData({ showModal: false }); },
  noop() {},
  onTitleInput(e) { this.setData({ title: e.detail.value }); },
  onDateChange(e) { this.setData({ targetDate: e.detail.value }); },

  async onSave() {
    const title = (this.data.title || '').trim();
    const targetDate = this.data.targetDate;
    if (!title) { wx.showToast({ title: '请输入目标', icon: 'none' }); return; }
    if (!targetDate) { wx.showToast({ title: '请选择截止日期', icon: 'none' }); return; }
    try {
      const db = wx.cloud.database();
      const col = db.collection('countdowns');
      const doc = { title, targetDate, createdAt: new Date().toISOString() };
      try {
        // 客户端写入会自动带 _openid;这里额外显式写一份 openid,
        // 是为了将来把读写挪到云函数时不用改数据形态(B6)。
        doc.openid = (await getApp().waitOpenid()) || '';
        await col.add({ data: doc });
      } catch (e) {
        // 万一运行时不接受客户端写 _openid/openid 之外的保留字段而报错,
        // 退回最小写入,保证"加不上"这种硬失败不会发生。
        console.warn('countdown add retry without openid', e);
        delete doc.openid;
        await col.add({ data: doc });
      }
      this.setData({ showModal: false });
      this.load();
      wx.showToast({ title: '已添加', icon: 'success' });
    } catch (err) {
      console.error('save failed', err);
      wx.showToast({ title: '保存失败,请重试', icon: 'none' });
    }
  },

  async onDelete(e) {
    const id = e.currentTarget.dataset.id;
    const target = this.data.items.find((i) => i._id === id);
    if (!target) return;
    // wx.showModal 是回调式 API,await 它拿不到结果 —— 必须 Promise 化后再读 confirm
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '删除目标',
        content: '确定删除「' + target.title + '」吗?',
        success: (r) => resolve(r || {}),
        fail: () => resolve({})
      });
    });
    if (!res.confirm) return;
    try {
      const db = wx.cloud.database();
      await db.collection('countdowns').doc(id).remove();
      this.load();
    } catch (err) {
      wx.showToast({ title: '删除失败', icon: 'none' });
    }
  },

  onPullDownRefresh() {
    this.load();
    wx.stopPullDownRefresh();
  }
});
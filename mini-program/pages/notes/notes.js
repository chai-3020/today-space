// pages/notes/notes.js — 便签(云数据库,防抖保存)
Page({
  data: {
    content: '',
    status: '已加载',
    count: 0
  },

  saveTimer: null,
  docId: null,

  onShow() { this.loadNotes(); },

  async loadNotes() {
    try {
      const db = wx.cloud.database();
      const res = await db.collection('notes').limit(1).get();
      if (res.data.length > 0) {
        this.docId = res.data[0]._id;
        this.setData({ content: res.data[0].content || '' });
      } else {
        this.setData({ content: '' });
      }
      this.updateCount();
      this.setData({ status: '已保存' });
    } catch (err) {
      console.error('loadNotes failed', err);
      this.setData({ status: '加载失败' });
    }
  },

  onInput(e) {
    const content = e.detail.value;
    this.setData({ content, status: '输入中...' });
    this.updateCount();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNotes(), 600);
  },

  onSave() { this.saveNotes(); },

  async saveNotes() {
    const content = this.data.content;
    try {
      const db = wx.cloud.database();
      if (this.docId) {
        await db.collection('notes').doc(this.docId).update({ data: { content, updatedAt: new Date().toISOString() } });
      } else {
        const res = await db.collection('notes').add({ data: { content, createdAt: new Date().toISOString() } });
        this.docId = res._id;
      }
      this.setData({ status: '已保存' });
    } catch (err) {
      console.error('saveNotes failed', err);
      this.setData({ status: '保存失败' });
    }
  },

  updateCount() {
    this.setData({ count: Array.from(this.data.content).length });
  },

  onPullDownRefresh() {    this.loadNotes();
    wx.stopPullDownRefresh();
  },
});
// pages/notes/notes.js — 便签(云数据库,防抖保存)
//
// 2026-09-21 修复:
//   ① 幽灵文档:docId 为空时走 add(),若首次保存"超时但服务端其实写成功",
//      下次保存会再 add 一条,集合里堆出多条便签(而读取只取第一条)。
//      现改为按用户固定 _id(note_<openid尾16位>)upsert —— 每个用户永远
//      只有一条,且并发重复保存不会产生副本。
//   ② 覆盖未保存内容:onShow 无条件 loadNotes() 会把正在输入的本地内容刷掉。
//      现在有未保存改动时不再覆盖。
//   ③ 退出丢字:600ms 防抖定时器在 onHide/onUnload 时没有兑现,
//      现在离开页面前会把待保存内容补存一次。
const util = require('../../utils/util.js');

Page({
  data: {
    themeClass: '',
    colorClass: '',
    content: '',
    status: '已加载',
    count: 0
  },

  saveTimer: null,
  docId: null,
  _openid: '',
  _dirty: false,      // 有未保存的输入
  _saving: false,     // 正在写
  _savedId: null,     // 已确认存在于云端的文档 id

  onShow() {
    const app = getApp();
    if (app.setNavBar) app.setNavBar();
    this.setData({ themeClass: app.theme === 'dark' ? 'theme-dark' : '',
      colorClass: app.themeColor ? ({"green":"","blue":"theme-blue","orange":"theme-orange","purple":"theme-purple","pink":"theme-pink"})[app.themeColor] || '' : '' });
    // 本地有未保存的输入时不要用云端内容覆盖它
    if (this._dirty) {
      this.setData({ status: '有未保存的修改' });
      return;
    }
    this.loadNotes();
  },

  async loadNotes() {
    try {
      const app = getApp();
      const openid = await app.waitOpenid();
      if (!openid) {
        console.warn('loadNotes skipped: openid 未就绪');
        this.setData({ status: '加载失败' });
        return;
      }
      this._openid = openid;
      this.docId = `note_${openid.slice(-16)}`;
      const db = wx.cloud.database();
      // 用确定性 id 直接取,取不到就是还没有便签 —— 不再"取集合第一条"
      let doc = null;
      try {
        const res = await db.collection('notes').doc(this.docId).get();
        doc = res.data;
      } catch (e) {
        doc = null; // 文档不存在
      }
      if (doc) {
        this._savedId = this.docId;
        this.setData({ content: doc.content || '' });
      } else {
        this._savedId = null;
        this.setData({ content: '' });
      }
      this._dirty = false;
      this.updateCount();
      this.setData({ status: '已保存' });
    } catch (err) {
      console.error('loadNotes failed', err);
      this.setData({ status: '加载失败' });
    }
  },

  onInput(e) {
    const content = e.detail.value;
    this._dirty = true;
    this.setData({ content, status: '输入中...' });
    this.updateCount();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNotes(), 600);
  },

  onSave() { this.saveNotes(); },

  async saveNotes() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this._openid) {
      const app = getApp();
      this._openid = (await app.waitOpenid()) || '';
      if (!this._openid) { this.setData({ status: '保存失败' }); return; }
      this.docId = `note_${this._openid.slice(-16)}`;
    }
    if (this._saving) return;              // 上一笔还没写完,等它
    this._saving = true;
    const content = this.data.content;
    const now = new Date().toISOString();
    try {
      const db = wx.cloud.database();
      const col = db.collection('notes');
      if (this._savedId) {
        await col.doc(this.docId).update({ data: { content, updatedAt: now } });
      } else {
        // 首次:用确定性 _id 新建,避免"超时重试"造出第二条
        // B6:文档 _id 由 openid 派生,隔离同时依赖两层 —— _id 唯一 + 集合权限
        // "仅创建者可读写"。⚠️ 这个集合的权限不能放宽成"所有用户可读"。
        try {
          await col.add({ data: { _id: this.docId, openid: this._openid, content, createdAt: now, updatedAt: now } });
        } catch (addErr) {
          // 运行时不接受额外的 openid 字段时退回最小写入(隔离仍由 _id + 权限保证)
          console.warn('notes add retry without openid', addErr);
          await col.add({ data: { _id: this.docId, content, createdAt: now, updatedAt: now } });
        }
        this._savedId = this.docId;
      }
      this._dirty = false;
      this.setData({ status: '已保存' });
    } catch (err) {
      // 可能已存在(并发/上一次其实写成功了):退化为更新
      try {
        const db = wx.cloud.database();
        await db.collection('notes').doc(this.docId).update({ data: { content, updatedAt: now } });
        this._savedId = this.docId;
        this._dirty = false;
        this.setData({ status: '已保存' });
      } catch (err2) {
        console.error('saveNotes failed', err, err2);
        this.setData({ status: '保存失败' });
      }
    } finally {
      this._saving = false;
    }
  },

  updateCount() {
    this.setData({ count: Array.from(this.data.content).length });
  },

  onHide() {
    // 离开页面前把待保存内容补存,避免防抖定时器没跑完就丢字
    if (this._dirty) this.saveNotes();
  },

  onUnload() {
    clearTimeout(this.saveTimer);
    if (this._dirty) this.saveNotes();
  },

  onPullDownRefresh() {
    this.loadNotes();
    wx.stopPullDownRefresh();
  },
});

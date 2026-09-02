// pages/profile/profile.js — 我的(昵称/主题/退出)
const app = getApp();

Page({
  data: {
    themeClass: '',
    nickname: '',
    themeLabel: '浅色',
    showNameModal: false,
    nameInput: ''
  },

  onShow() {
    if (app.setNavBar) app.setNavBar();
    const dark = app.theme === 'dark';
    this.setData({
      themeClass: dark ? 'theme-dark' : '',
      nickname: app.globalData.nickname || '新朋友',
      themeLabel: dark ? '深色' : '浅色'
    });
  },

  onToggleTheme() {
    app.toggleTheme();
    const dark = app.theme === 'dark';
    this.setData({ themeLabel: dark ? '深色' : '浅色' });
  },

  onEditName() {
    this.setData({ showNameModal: true, nameInput: app.globalData.nickname || '' });
  },
  onNameInput(e) { this.setData({ nameInput: e.detail.value }); },
  onNameCancel() { this.setData({ showNameModal: false }); },
  noop() {},
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

  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后本机将清除登录状态,云端数据保留。',
      confirmText: '退出',
      success: async (res) => {
        if (!res.confirm) return;
        try { await wx.cloud.callFunction({ name: 'logout' }); } catch (e) {}
        // 清本地会话(简单处理:清 storage 标记)
        try { wx.setStorageSync('ts-logged-out', true); } catch (e) {}
        app.globalData.userInfo = null;
        app.globalData.openid = null;
        wx.showToast({ title: '已退出', icon: 'success' });
        wx.switchTab({ url: '/pages/index/index' });
      }
    });
  }
});

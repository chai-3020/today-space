// pages/profile/profile.js — 我的(分组设置)
const app = getApp();

Page({
  data: {
    themeClass: '',
    nickname: '',
    themeLabel: '浅色',
    themeColor: 'green',
    motto: '',
    restMin: 5,
    soundOn: true,
    midnightOn: false,
    fixedSort: false,
    noDoneLine: false,
    showMotto: false,
    mottoInput: '',
    showNameModal: false,
    nameInput: ''
  },

  onShow() {
    if (app.setNavBar) app.setNavBar();
    const dark = app.theme === 'dark';
    const s = this.getSettings();
    this.setData({
      themeClass: dark ? 'theme-dark' : '',
      nickname: app.globalData.nickname || '新朋友',
      themeLabel: dark ? '深色' : '浅色',
      themeColor: s.themeColor || 'green',
      motto: s.motto || '',
      restMin: s.restMin || 5,
      soundOn: s.soundOn !== false,
      midnightOn: !!s.midnightOn,
      fixedSort: !!s.fixedSort,
      noDoneLine: !!s.noDoneLine
    });
  },

  getSettings() {
    try { return wx.getStorageSync('ts-settings') || {}; } catch (e) { return {}; }
  },
  saveSettings(obj) {
    const cur = this.getSettings();
    Object.assign(cur, obj);
    try { wx.setStorageSync('ts-settings', cur); } catch (e) {}
    return cur;
  },

  // ---- 外观 ----
  onToggleTheme() {
    app.toggleTheme();
    const dark = app.theme === 'dark';
    this.setData({ themeLabel: dark ? '深色' : '浅色' });
  },

  onColor(e) {
    const color = e.currentTarget.dataset.color;
    this.saveSettings({ themeColor: color });
    app.setThemeColor && app.setThemeColor(color);
    this.setData({ themeColor: color });
    wx.showToast({ title: '主题色已切换', icon: 'success' });
  },

  // ---- 专注计时设置 ----
  onEditMotto() {
    const s = this.getSettings();
    this.setData({ showMotto: true, mottoInput: s.motto || '' });
  },
  onMottoInput(e) { this.setData({ mottoInput: e.detail.value }); },
  closeMotto() { this.setData({ showMotto: false }); },
  noop() {},
  saveMotto() {
    const motto = (this.data.mottoInput || '').trim();
    this.saveSettings({ motto });
    this.setData({ showMotto: false, motto });
    wx.showToast({ title: '已保存', icon: 'success' });
  },

  goPomodoro() { wx.navigateTo({ url: '/pages/pomodoro/pomodoro' }); },
  goCountdown() { wx.navigateTo({ url: '/pages/countdown/countdown' }); },
  goStats() { wx.switchTab({ url: '/pages/stats/stats' }); },

  onToggleSound() {
    const v = !this.data.soundOn;
    this.saveSettings({ soundOn: v });
    this.setData({ soundOn: v });
  },
  onToggleMidnight() {
    const v = !this.data.midnightOn;
    this.saveSettings({ midnightOn: v });
    this.setData({ midnightOn: v });
  },
  onToggleFixedSort() {
    const v = !this.data.fixedSort;
    this.saveSettings({ fixedSort: v });
    this.setData({ fixedSort: v });
  },
  onToggleDoneLine() {
    const v = !this.data.noDoneLine;
    this.saveSettings({ noDoneLine: v });
    this.setData({ noDoneLine: v });
  },

  // ---- 昵称 ----
  onEditName() {
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
        app.globalData.userInfo = null;
        app.globalData.openid = null;
        wx.showToast({ title: '已退出', icon: 'success' });
        wx.switchTab({ url: '/pages/index/index' });
      }
    });
  }
});

// app.js — 今日空间小程序入口
App({
  globalData: {
    userInfo: null,
    openid: null,
    nickname: ''
  },

  onLaunch() {
    // 初始化云开发
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
      return;
    }
    wx.cloud.init({
      env: 'cloud1-d9gqbbkdz44c81883', // 云开发环境 ID(部署时替换)
      traceUser: true
    });
    this.login();
    this.initTheme();
  },

  // 静默登录:获取 openid + 用户信息
  async login() {
    try {
      const res = await wx.cloud.callFunction({ name: 'login' });
      const { openid, user } = res.result || {};
      this.globalData.openid = openid;
      this.globalData.userInfo = user || null;
      this.globalData.nickname = (user && user.name) || '';
      if (this.loginCallback) this.loginCallback(user);
    } catch (err) {
      console.error('login failed', err);
    }
  },

  // 等待登录完成的 Promise 包装
  ready() {
    return new Promise((resolve) => {
      if (this.globalData.openid) return resolve(this.globalData.userInfo);
      this.loginCallback = resolve;
    });
  },

  // ---- 主题(手动切换,记忆选择;默认跟随系统) ----
  theme: '',   // 'light' | 'dark'

  initTheme() {
    let t = '';
    try { t = wx.getStorageSync('ts-theme'); } catch (e) {}
    if (t !== 'light' && t !== 'dark') {
      try {
        const info = wx.getSystemInfoSync();
        t = (info.theme === 'dark') ? 'dark' : 'light';
      } catch (e) { t = 'light'; }
    }
    this.theme = t;
  },

  applyThemeToCurrentPage() {
    const pages = getCurrentPages();
    const page = pages[pages.length - 1];
    if (page && page.setData) {
      page.setData({ themeClass: this.theme === 'dark' ? 'theme-dark' : '' });
    }
    this.setNavBar();
  },

  setNavBar() {
    const dark = this.theme === 'dark';
    try {
      wx.setNavigationBarColor({
        frontColor: '#ffffff',
        backgroundColor: dark ? '#14181a' : '#0d9f6d'
      });
    } catch (e) {}
  },

  // 手动切换主题(点按钮调用)
  toggleTheme() {
    this.theme = (this.theme === 'dark') ? 'light' : 'dark';
    try { wx.setStorageSync('ts-theme', this.theme); } catch (e) {}
    this.applyThemeToCurrentPage();
  },

}
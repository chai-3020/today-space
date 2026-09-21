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
      env: 'cloud1-d9gqbbkdz44c81883', // 云开发环境 ID
      traceUser: true
    });
    this.initTheme();
    // 存住登录 Promise,供 waitOpenid() 等待
    this._loginPromise = this.login();
  },

  // 等待静默登录完成,返回 openid(供页面做数据归属过滤)
  waitOpenid() {
    const openid = this.globalData.openid;
    if (openid) return Promise.resolve(openid);
    // 登录尚未完成(或已退出登录):等 onLaunch 那次 login() 落地后再读一次
    if (!this._openidPromise) {
      const login = this._loginPromise || Promise.resolve();
      this._openidPromise = Promise.resolve(login)
        .catch(() => {})
        .then(() => this.globalData.openid || null)
        .then((id) => { this._openidPromise = null; return id; });
    }
    return this._openidPromise;
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
  themeColor: 'green',  // 主色调(绿/蓝/橙/紫/粉)

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
    // 主色调
    try {
      const s = wx.getStorageSync('ts-settings') || {};
      this.themeColor = s.themeColor || 'green';
    } catch (e) {}
  },

  // 切换主题色
  setThemeColor(color) {
    this.themeColor = color;
    this.applyThemeToCurrentPage();
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

  // 手动切换主题(首页按钮调用),选择存入本地,下次启动沿用
  toggleTheme() {
    this.theme = (this.theme === 'dark') ? 'light' : 'dark';
    try { wx.setStorageSync('ts-theme', this.theme); } catch (e) {}
    this.applyThemeToCurrentPage();
  }
});
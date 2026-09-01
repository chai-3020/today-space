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
      env: 'CHANGE_ME_CLOUD_ENV', // 云开发环境 ID(部署时替换)
      traceUser: true
    });
    this.login();
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
  }
});

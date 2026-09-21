// 云函数 login — 获取 openid,首次访问自动创建用户档案
//
// 2026-09-21 修复:原实现用 `_openid` 查询、但写入时没有该字段 ——
// 云函数写入的文档不会自动注入 `_openid`(那是客户端直写才有的),
// 导致每次打开小程序都会新建一个用户档案、昵称永远读不回来。
// 现统一改为显式字段 `openid`,并且查不到时用 upsert 语义补齐。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 1, error: '无法获取用户身份' };

  const users = db.collection('users');

  // 优先按新字段查;查不到再退一步查 _openid,兼容客户端直写产生的旧文档
  let found = await users.where({ openid: OPENID }).limit(1).get();
  if (found.data.length === 0) {
    try {
      found = await users.where({ _openid: OPENID }).limit(1).get();
    } catch (err) {
      console.warn('login: legacy _openid lookup failed', err);
    }
  }

  if (found.data.length > 0) {
    const u = found.data[0];
    return { code: 0, openid: OPENID, user: { name: u.name || '', createdAt: u.createdAt || '' } };
  }

  // 新用户:创建档案(昵称稍后设置,默认"新朋友")
  const now = new Date().toISOString();
  const doc = { openid: OPENID, name: '新朋友', createdAt: now };
  const res = await users.add({ data: doc });
  return { code: 0, openid: OPENID, user: { name: '新朋友', createdAt: now }, isNew: true, id: res._id };
};

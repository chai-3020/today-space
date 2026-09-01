// 云函数 login — 获取 openid,首次访问自动创建用户档案
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 1, error: '无法获取用户身份' };

  const users = db.collection('users');
  const found = await users.where({ _openid: OPENID }).limit(1).get();
  if (found.data.length > 0) {
    const u = found.data[0];
    return { code: 0, openid: OPENID, user: { name: u.name || '', createdAt: u.createdAt || '' } };
  }

  // 新用户:创建档案(昵称稍后设置,默认"新朋友")
  const now = new Date().toISOString();
  const doc = { name: '新朋友', createdAt: now };
  await users.add({ data: doc });
  return { code: 0, openid: OPENID, user: { name: '新朋友', createdAt: now }, isNew: true };
};

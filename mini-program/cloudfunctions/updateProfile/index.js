// 云函数 updateProfile — 设置昵称
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const name = String(event.name || '').trim();
  if (!name) return { code: 1, error: '昵称不能为空' };
  if (name.length > 24) return { code: 1, error: '昵称最多 24 个字符' };
  if (!/^[\u4e00-\u9fa5A-Za-z0-9_-]+$/.test(name)) return { code: 1, error: '昵称只能含中文、字母、数字、_ 和 -' };

  await db.collection('users').where({ _openid: OPENID }).update({
    data: { name }
  });
  return { code: 0, name };
};

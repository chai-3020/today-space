// 云函数 addFocus — 记录真实番茄钟(服务端校验 25 的倍数,防造假)
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const day = String(event.day || '');
  const minutes = Number(event.minutes) || 0;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { code: 1, error: '日期格式不对' };
  if (minutes <= 0 || minutes % 25 !== 0 || minutes > 500) {
    return { code: 1, error: '分钟数必须为正的 25 的倍数' }; // 与网页版一致的防造假校验
  }

  const logs = db.collection('focus_log');
  const found = await logs.where({ _openid: OPENID, day }).limit(1).get();
  if (found.data.length > 0) {
    const cur = found.data[0];
    await logs.doc(cur._id).update({
      data: { minutes: cur.minutes + minutes, sessions: (cur.sessions || 0) + 1 }
    });
    return { code: 0, minutes: cur.minutes + minutes, sessions: (cur.sessions || 0) + 1 };
  }

  const doc = await logs.add({ data: { day, minutes, sessions: 1, createdAt: new Date().toISOString() } });
  return { code: 0, minutes, sessions: 1, id: doc._id };
};

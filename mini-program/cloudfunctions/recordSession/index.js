// 云函数 recordSession — 记录一次完整的番茄会话(专注/短休/长休)
// 写入 pomo_sessions 明细;专注会话同时累加到 focus_log(保持统计一致)
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 1, error: '无法获取用户身份' };

  const type = String(event.type || 'focus'); // focus | short | long
  const minutes = Number(event.minutes) || 0;
  const startedAt = Number(event.startedAt) || 0; // 开始时间戳(ms)
  const endedAt = Number(event.endedAt) || 0;     // 结束时间戳(ms)

  // ---- 校验 ----
  const types = ['focus', 'short', 'long'];
  if (!types.includes(type)) return { code: 1, error: '无效的会话类型' };
  if (minutes <= 0 || minutes > 180) return { code: 1, error: '时长无效(1-180 分钟)' };
  if (!startedAt || !endedAt || endedAt <= startedAt) return { code: 1, error: '时间戳无效' };
  // 时长与时间戳偏差容差(防止前端乱传):±3 分钟
  const durMin = (endedAt - startedAt) / 60000;
  if (Math.abs(durMin - minutes) > 3) return { code: 1, error: '时长与时间不一致' };

  // ---- 计算本地日期(用东八区近似:前端传 day 更准)----
  // 前端直接传 day(YYYY-MM-DD,按用户本地时区),避免服务器时区偏差
  const day = String(event.day || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { code: 1, error: '日期格式不对' };

  // ---- 写入会话明细 ----
  const doc = {
    type,
    minutes,
    day,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    createdAt: new Date().toISOString()
  };
  const res = await db.collection('pomo_sessions').add({ data: doc });

  // ---- 专注会话:同步累加到 focus_log(防重复:同一时间戳只加一次)----
  if (type === 'focus') {
    const dup = await db.collection('pomo_sessions')
      .where({ _openid: OPENID, endedAt: new Date(endedAt).toISOString(), type: 'focus' })
      .count();
    if (dup.total > 1) {
      // 本次是重复提交,只保留明细第一条,不累加统计
      return { code: 0, id: res._id, duplicated: true };
    }
    const logs = db.collection('focus_log');
    const found = await logs.where({ _openid: OPENID, day }).limit(1).get();
    if (found.data.length > 0) {
      const cur = found.data[0];
      await logs.doc(cur._id).update({
        data: { minutes: cur.minutes + minutes, sessions: (cur.sessions || 0) + 1 }
      });
    } else {
      await logs.add({ data: { day, minutes, sessions: 1, createdAt: new Date().toISOString() } });
    }
  }

  return { code: 0, id: res._id };
};

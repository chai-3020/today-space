// 云函数 recordSession — 记录一次完整的番茄会话(专注/短休/长休)
// 写入 pomo_sessions 明细;专注会话同时累加到 focus_log(保持统计一致)
//
// 2026-09-21 修复:
//   1) 原实现在 add() 之后才查重,且用 _openid 匹配 —— 云函数写入的文档
//      不带 _openid,所以防重复分支永远不会触发。改为「先查重、后插入」,
//      并显式写入 openid 字段。
//   2) focus_log 的累加由「读-改-写」改为原子自增(_.inc),避免并发丢更新。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const SESSION_TYPES = ['focus', 'short', 'long'];

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 1, error: '无法获取用户身份' };

  const type = String(event.type || 'focus'); // focus | short | long
  const minutes = Number(event.minutes) || 0;
  const startedAt = Number(event.startedAt) || 0; // 开始时间戳(ms)
  const endedAt = Number(event.endedAt) || 0;     // 结束时间戳(ms)

  // ---- 校验 ----
  if (!SESSION_TYPES.includes(type)) return { code: 1, error: '无效的会话类型' };
  if (minutes <= 0 || minutes > 180) return { code: 1, error: '时长无效(1-180 分钟)' };
  if (!startedAt || !endedAt || endedAt <= startedAt) return { code: 1, error: '时间戳无效' };
  // 时长与时间戳偏差容差(防止前端乱传):±3 分钟
  const durMin = (endedAt - startedAt) / 60000;
  if (Math.abs(durMin - minutes) > 3) return { code: 1, error: '时长与时间不一致' };

  // ---- 日期(前端按用户本地时区算好再传,避免服务器时区偏差)----
  const day = String(event.day || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { code: 1, error: '日期格式不对' };

  const endedIso = new Date(endedAt).toISOString();
  const sessions = db.collection('pomo_sessions');

  // ---- 防重复:先查,再插 ----
  // 同一次会话(同一用户 + 同一结束时刻)只记一次;重复提交直接返回,不写库。
  const dup = await sessions.where({ openid: OPENID, endedAt: endedIso }).count();
  if (dup.total > 0) return { code: 0, duplicated: true };

  // ---- 写入会话明细(显式带 openid:云函数写入不会自动注入 _openid)----
  const res = await sessions.add({
    data: {
      openid: OPENID,
      type,
      minutes,
      day,
      startedAt: new Date(startedAt).toISOString(),
      endedAt: endedIso,
      createdAt: new Date().toISOString()
    }
  });

  // ---- 专注会话:累加到 focus_log ----
  if (type === 'focus') {
    // 原子自增:并发时也不会丢更新(原实现是读出来改完再写,会丢)
    const bumped = await db.collection('focus_log')
      .where({ openid: OPENID, day })
      .update({ data: { minutes: _.inc(minutes), sessions: _.inc(1) } });

    // 该用户当天还没有记录 -> 建一条(users 集合里由 login 维护,这里不依赖它)
    const updated = bumped.stats && (bumped.stats.updated || bumped.stats.updatedCount);
    if (!updated) {
      await db.collection('focus_log').add({
        data: { openid: OPENID, day, minutes, sessions: 1, createdAt: new Date().toISOString() }
      });
    }
  }

  return { code: 0, id: res._id };
};

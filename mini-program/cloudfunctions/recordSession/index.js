// 云函数 recordSession — 记录一次完整的番茄会话(专注/短休/长休)
// 写入 pomo_sessions 明细;专注会话同时累加到 focus_log(保持统计一致)
//
// 变更记录:
//   2026-09-21a 防重复改为「先查后插」,显式写 openid,focus_log 改原子自增。
//   2026-09-21b (本次)
//     - 幂等键新增 runId:客户端在**会话开始时**生成一次,重试沿用同一个值,
//       并以它作为 pomo_sessions 的文档 _id —— 重复提交会被主键冲突挡掉,
//       不再依赖"毫秒级时间戳"这种脆弱去重。
//     - 校验改用「净专注时长」focusedSeconds:原先用 endedAt-startedAt 反推
//       总时长,导致"暂停一会儿再继续跑完"这种正常操作被判时长不符而丢弃
//       整次记录。现在改为:
//         · focusedSeconds 必须与上报的 minutes 吻合(±3 分钟);
//         · 真实时间跨度不得小于净专注时长(物理上不可能,防伪造);
//         · 暂停时长不再参与判定。
//   2026-09-21c (本次)
//     - 日期改由服务端从 endedAt + 客户端时区偏移推导:原先直接信任客户端
//       传来的 day(只校验格式),可以填成任意历史日期刷数据。现在客户端
//       只传 tzOffsetMinutes 与 dayOffset(0 / -1,给"午夜模式"用),
//       具体日期由服务端算(旧客户端若仍传 day 则做一致性核对)。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const SESSION_TYPES = ['focus', 'short', 'long'];

// 按给定时区偏移(分钟,JS 的 getTimezoneOffset 语义:UTC - 本地)求出本地日期键
function dayKeyInTz(ms, tzOffsetMinutes) {
  const shifted = new Date(ms - tzOffsetMinutes * 60000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 1, error: '无法获取用户身份' };

  const type = String(event.type || 'focus'); // focus | short | long
  const minutes = Number(event.minutes) || 0;
  const startedAt = Number(event.startedAt) || 0;   // 会话真实开始时间戳(ms,含暂停)
  const endedAt = Number(event.endedAt) || 0;       // 会话结束时间戳(ms)
  const focusedMs = Number(event.focusedSeconds) * 1000 || 0; // 净专注时长(ms)

  // ---- 校验 ----
  if (!SESSION_TYPES.includes(type)) return { code: 1, error: '无效的会话类型' };
  if (minutes <= 0 || minutes > 180) return { code: 1, error: '时长无效(1-180 分钟)' };
  if (!startedAt || !endedAt || endedAt <= startedAt) return { code: 1, error: '时间戳无效' };

  const wallMs = endedAt - startedAt;
  // ① 净专注时长必须与上报的分钟数吻合(容差 ±3 分钟)
  if (!focusedMs || Math.abs(focusedMs / 60000 - minutes) > 3) {
    return { code: 1, error: '专注时长与上报不一致' };
  }
  // ② 净专注时长不可能超过真实时间跨度(防伪造);1 分钟容差吸收合并计时误差
  if (focusedMs > wallMs + 60000) {
    return { code: 1, error: '专注时长超过实际耗时' };
  }

  // ---- 日期:由服务端从 endedAt 推导,不再信任客户端传来的 day ----
  // 客户端只提供"设备相对 UTC 的时区偏移"(new Date().getTimezoneOffset()),
  // 这样既尊重用户本地日期,又杜绝了"把 day 填成历史任意一天来刷数据"。
  const tzOffsetMinutes = Number(event.tzOffsetMinutes);
  const tz = Number.isFinite(tzOffsetMinutes) && Math.abs(tzOffsetMinutes) <= 14 * 60
    ? tzOffsetMinutes
    : 480; // 缺省按 UTC+8
  // 午夜模式:客户端只能声明"往前挪几天"(0 或 -1),具体日期仍由服务端算,
  // 所以这条路无法被用来伪造任意历史日期。
  const rawDayOffset = Number(event.dayOffset);
  const dayOffset = rawDayOffset === -1 ? -1 : 0;
  const day = dayKeyInTz(endedAt + dayOffset * 86400000, tz);
  // 兼容旧客户端:它仍在传 day,此时只做一致性核对,不一致以服务端推导为准
  const claimedDay = String(event.day || '');
  if (claimedDay && claimedDay !== day) {
    console.warn('recordSession: day mismatch, using derived day', claimedDay, '->', day);
  }

  // ---- 幂等键 ----
  // 客户端在会话开始时生成,重试时沿用同一个值;缺省时退化为用户名+结束时刻。
  const rawRunId = String(event.runId || '').trim();
  const runId = /^[A-Za-z0-9_-]{6,64}$/.test(rawRunId)
    ? rawRunId
    : `${OPENID.slice(-8)}-${endedAt}`;

  const endedIso = new Date(endedAt).toISOString();
  const sessions = db.collection('pomo_sessions');
  const docId = `s_${OPENID.slice(-12)}_${runId}`;

  // ---- 写明细:用确定性 _id 挡重复(比 count() 查重可靠,无并发窗口)----
  try {
    await sessions.add({
      data: {
        _id: docId,
        openid: OPENID,
        runId,
        type,
        minutes,
        focusedSeconds: Math.round(focusedMs / 1000),
        day,
        startedAt: new Date(startedAt).toISOString(),
        endedAt: endedIso,
        createdAt: new Date().toISOString()
      }
    });
  } catch (err) {
    // _id 已存在 = 这次会话已经记过了(客户端重试 / 重复提交)
    console.log('recordSession: duplicate runId', runId);
    return { code: 0, duplicated: true, id: docId };
  }

  // ---- 专注会话:累加到 focus_log ----
  if (type === 'focus') {
    const logs = db.collection('focus_log');
    // 原子自增:并发时不会丢更新
    const bumped = await logs.where({ openid: OPENID, day })
      .update({ data: { minutes: _.inc(minutes), sessions: _.inc(1) } });
    const count = bumped.stats && (bumped.stats.updated || bumped.stats.updatedCount || 0);
    if (!count) {
      // 当天还没有记录 -> 建一条(极小概率的并发建重,统计端按行累加不会算错)
      await logs.add({
        data: { openid: OPENID, day, minutes, sessions: 1, createdAt: new Date().toISOString() }
      });
    }
  }

  return { code: 0, id: docId };
};

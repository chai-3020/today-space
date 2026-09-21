// 云函数 recordSession — 记录一次番茄会话(专注/短休/长休/放弃)
// 写入 pomo_sessions 明细;专注会话同时累加到 focus_log(保持统计一致)
//
// 变更记录:
//   2026-09-21a 防重复改为「先查后插」,显式写 openid,focus_log 改原子自增。
//   2026-09-21b 幂等键新增 runId:客户端在**会话开始时**生成一次,重试沿用同一个值,
//       并以它作为 pomo_sessions 的文档 _id —— 重复提交会被主键冲突挡掉。
//       校验改用「净专注时长」focusedSeconds。
//   2026-09-21c 日期改由服务端从 endedAt + 客户端时区偏移推导。
//   2026-09-21d (本次,对应 OPTIMIZATION-PLAN 的 A2/A6/B7)
//     - A2 校验不再"整条拒收":净专注时长与上报分钟不一致时,以**服务端算出的
//       净时长为准降级入库**并标 adjusted,只有物理上不可能(净时长超过墙钟跨度)
//       或超出 180 分钟上限才拒收。此前一次正常专注一旦被判定不符就永久丢失。
//     - A6 新增 type='abandoned':切模式/重置/离开页面时把已专注的时长记成放弃,
//       统计端据此给出真实的"放弃次数"(此前 client 里写死 0)。
//     - B7 文档显式写入 _openid(云函数写入不会自动注入),这样集合权限可以收紧为
//       "仅创建者可读写",不再依赖"所有用户可读"这种过宽配置。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const SESSION_TYPES = ['focus', 'short', 'long', 'abandoned'];
const MAX_MINUTES = 180;
const MIN_FOCUS_SECONDS = 30;      // 不足 30 秒不记为一次专注/放弃
const ADJUST_TOLERANCE_SECONDS = 180; // 与上报分钟差 3 分钟以内视为正常误差

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

  const type = String(event.type || 'focus'); // focus | short | long | abandoned
  const startedAt = Number(event.startedAt) || 0;   // 会话真实开始时间戳(ms,含暂停)
  const endedAt = Number(event.endedAt) || 0;       // 会话结束时间戳(ms)
  const clientWallSeconds = Number(event.wallSeconds) || 0;
  const focusedMs = Number(event.focusedSeconds) * 1000 || 0; // 净专注时长(ms)

  if (!SESSION_TYPES.includes(type)) return { code: 1, error: '无效的会话类型' };
  if (!startedAt || !endedAt || endedAt <= startedAt) return { code: 1, error: '时间戳无效' };

  // 墙钟跨度:优先用客户端上报的(它按"计划结束时刻"算,切后台也准),
  // 缺失时退回 time stamp 差值。上限 24 小时,防止离谱数据。
  const wallSeconds = (clientWallSeconds > 0 && clientWallSeconds <= 86400)
    ? clientWallSeconds
    : Math.round((endedAt - startedAt) / 1000);
  const wallMs = wallSeconds * 1000;

  // ---- 校验(A2:能救则救,只在物理不可能时拒收)----
  if (focusedMs < MIN_FOCUS_SECONDS * 1000) {
    return { code: 1, error: '专注时长太短,未记录' };
  }
  if (focusedMs > wallMs + 60000) {
    // 净专注不可能比真实耗时还长 —— 这种才是真伪造/真错乱
    return { code: 1, error: '专注时长超过实际耗时' };
  }

  let minutes = Math.max(1, Number(event.minutes) || Math.round(focusedMs / 60000));
  const focusedMinutes = Math.max(1, Math.round(focusedMs / 60000));
  let adjusted = false;
  if (Math.abs(minutes - focusedMinutes) * 60 > ADJUST_TOLERANCE_SECONDS) {
    // 不一致时以服务端算出的净时长为准,不再丢弃整条记录
    console.warn('recordSession: minutes adjusted', { claimed: minutes, focused: focusedMinutes });
    minutes = focusedMinutes;
    adjusted = true;
  }
  if (minutes > MAX_MINUTES) {
    return { code: 1, error: `时长无效(1-${MAX_MINUTES} 分钟)` };
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
        _openid: OPENID,          // B7:云函数写入不会自动注入,显式补上
        openid: OPENID,
        runId,
        type,
        minutes,
        focusedSeconds: Math.round(focusedMs / 1000),
        wallSeconds,
        adjusted,                 // A2:是否被服务端修正过,便于排查
        abandonReason: type === 'abandoned' ? String(event.abandonReason || '').slice(0, 40) : '',
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
        data: {
          _openid: OPENID,        // B7
          openid: OPENID,
          day,
          minutes,
          sessions: 1,
          createdAt: new Date().toISOString()
        }
      });
    }
  }

  return { code: 0, id: docId, minutes, adjusted };
};

// 云函数 getFocusStats — 服务端聚合专注记录
//
// 数据来源:
//   ① focus_log       —— 每(用户,天)一条的累计行,专注分钟数与次数(主口径)
//   ② pomo_sessions   —— 每笔会话的明细,用来给出"放弃次数"与专注/休息拆分
//
// 2026-09-21 新增。原实现是四个页面各自 `focus_log.limit(1000).get()` 把
// 全量数据拉到客户端再在内存里按天累加:一是每次进页面都全量重拉,
// 二是超过 1000 条会静默截断、统计偏低且用户无感知。
// 现在改为服务端聚合后只回传"按天的小记录"(每天一条),数据量小得多。
//
// 2026-09-21d(本轮,对应 A6/B3/B7):
//   - A6 新增 abandons/byDayAbandon:统计页那个恒为 0 的"放弃次数"现在有真数据;
//     totals 里额外给出 focusSessions / restSessions,次数含义不再含糊。
//   - B3 两个集合都改游标分页(去掉了深分页的 skip),行数上限明确,
//     并由页面侧的 utils/focus-stats.js 缓存层保证不会被高频重复调用。
//   - B7 只按显式 openid 字段查询(索引 (openid,day) 生效),
//     新写入的文档同时带 _openid,集合权限可以收紧为"仅创建者可读写"。
//
// 返回:
//   { code:0,
//     byDay:    { 'YYYY-MM-DD': { minutes, sessions } },   // 专注
//     abandons: { 'YYYY-MM-DD': n },                       // 放弃次数
//     totals:   { minutes, sessions, days, focusSessions, restSessions, abandoned },
//     scanned, abandonedScanned, truncated }
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 微信云数据库单次 get 上限 100(云函数侧为 1000),这里按 100 分页,
// 最多 30 页 —— 即最多 3000 条日记录(约 8 年),足够覆盖个人使用。
const PAGE_SIZE = 100;
const MAX_PAGES = 30;
// 会话明细只需要计数(专注/休息/放弃),用一次大 limit 拉回来,避免深分页
const SESSION_SCAN_LIMIT = 1000;

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 1, error: '无法获取用户身份' };

  const byDay = {};
  const abandons = {};
  let minutes = 0;
  let sessions = 0;
  let scanned = 0;
  let truncated = false;

  // ---- ① focus_log:专注分钟/次数的权威口径(游标分页,不用 skip) ----
  try {
    const col = db.collection('focus_log');
    let lastDay = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      let query = col.where(
        lastDay === null
          ? { openid: OPENID }
          : { openid: OPENID, day: db.command.gt(lastDay) }
      );
      const res = await query.orderBy('day', 'asc').limit(PAGE_SIZE).get();
      const rows = res.data || [];
      for (const r of rows) {
        const day = r && r.day;
        if (!day) continue;                       // 跳过脏数据,避免污染整页数字
        const m = Number(r.minutes) || 0;
        const s = Number(r.sessions) || 0;
        if (!byDay[day]) byDay[day] = { minutes: 0, sessions: 0 };
        byDay[day].minutes += m;
        byDay[day].sessions += s;
        minutes += m;
        sessions += s;
      }
      scanned += rows.length;
      if (rows.length < PAGE_SIZE) break;
      lastDay = rows.length ? rows[rows.length - 1].day : null;
      if (page === MAX_PAGES - 1) truncated = true;
    }
  } catch (err) {
    console.error('getFocusStats: focus_log failed', err);
    return { code: 1, error: '统计加载失败,请重试' };
  }

  // ---- ② pomo_sessions:放弃次数 + 专注/休息拆分 ----
  // 这一段失败(例如集合还没建)不应让整个统计挂掉,所以单独 try/catch。
  let abandoned = 0;
  let focusSessions = sessions;
  let restSessions = 0;
  let abandonedScanned = 0;
  try {
    const res = await db.collection('pomo_sessions')
      .where({ openid: OPENID, type: db.command.in(['focus', 'short', 'long', 'abandoned']) })
      .field({ type: true, day: true })
      .limit(SESSION_SCAN_LIMIT)
      .get();
    const rows = res.data || [];
    abandonedScanned = rows.length;
    let focusCount = 0;
    for (const r of rows) {
      if (!r || !r.day) continue;
      if (r.type === 'abandoned') {
        abandoned += 1;
        abandons[r.day] = (abandons[r.day] || 0) + 1;
      } else if (r.type === 'focus') {
        focusCount += 1;
      } else {
        restSessions += 1;
      }
    }
    // 明细比 focus_log 更细,优先用明细里的专注次数(旧数据缺明细时退回 focus_log)
    if (focusCount > 0) focusSessions = focusCount;
    if (abandonedScanned >= SESSION_SCAN_LIMIT) truncated = true;
  } catch (err) {
    console.warn('getFocusStats: session breakdown skipped', err && err.message);
  }

  return {
    code: 0,
    byDay,
    abandons,
    totals: {
      minutes,
      sessions,
      days: Object.keys(byDay).length,
      focusSessions,
      restSessions,
      abandoned
    },
    scanned,
    abandonedScanned,
    truncated
  };
};

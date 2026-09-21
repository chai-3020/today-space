// 云函数 getFocusStats — 服务端聚合专注记录(focus_log)
//
// 2026-09-21 新增。原实现是四个页面各自 `focus_log.limit(1000).get()` 把
// 全量数据拉到客户端再在内存里按天累加:一是每次进页面都全量重拉,
// 二是超过 1000 条会静默截断、统计偏低且用户无感知。
// 现在改为服务端聚合后只回传"按天的小记录"(每天一条),数据量小得多。
//
// 返回:{ code:0, byDay:{ 'YYYY-MM-DD': { minutes, sessions } }, totals:{ minutes, sessions, days }, truncated }
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 微信云数据库单次 get 上限 100(云函数侧为 1000),这里按 100 分页,
// 最多 30 页 —— 即最多 3000 条日记录(约 8 年),足够覆盖个人使用。
const PAGE_SIZE = 100;
const MAX_PAGES = 30;

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 1, error: '无法获取用户身份' };

  const col = db.collection('focus_log');
  const byDay = {};
  let minutes = 0;
  let sessions = 0;
  let scanned = 0;
  let truncated = false;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await col
        .where({ openid: OPENID })
        .orderBy('day', 'asc')
        .skip(page * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .get();
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
      if (page === MAX_PAGES - 1) truncated = true;
    }
  } catch (err) {
    console.error('getFocusStats failed', err);
    return { code: 1, error: '统计加载失败,请重试' };
  }

  return {
    code: 0,
    byDay,
    totals: { minutes, sessions, days: Object.keys(byDay).length },
    scanned,
    truncated
  };
};

// 云函数 addFocus — 记录真实番茄钟(服务端校验 25 的倍数,防造假)
//
// ⚠️ 状态说明(2026-09-21):
//   客户端 pages/pomodoro/pomodoro.js 现在调用的是 `recordSession`(同时写
//   pomo_sessions 明细 + 累加 focus_log)。这个函数是**早期版本**的入口,
//   目前没有页面在调用,保留原因:早期写入的 focus_log 数据由它产生。
//   如果你确认不再需要,可以在云开发控制台删除它以简化维护。
//
// 2026-09-21 修复:原实现 `where({ _openid: OPENID, day })` 查不到自己写的文档
// (云函数写入不带 `_openid`),导致每次都走 add 分支 —— 同一天会堆出多条记录。
// 现统一用显式 `openid` 字段,并把"读-改-写"改成原子自增。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 1, error: '无法获取用户身份' };

  const day = String(event.day || '');
  const minutes = Number(event.minutes) || 0;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { code: 1, error: '日期格式不对' };
  if (minutes <= 0 || minutes % 25 !== 0 || minutes > 500) {
    return { code: 1, error: '分钟数必须为正的 25 的倍数' }; // 与网页版一致的防造假校验
  }

  const logs = db.collection('focus_log');

  // 原子自增:并发时不会丢更新
  const bumped = await logs.where({ openid: OPENID, day })
    .update({ data: { minutes: _.inc(minutes), sessions: _.inc(1) } });
  const count = bumped.stats && (bumped.stats.updated || bumped.stats.updatedCount || 0);
  if (count) return { code: 0, added: minutes, day };

  // 当天还没有记录 -> 建一条
  const doc = await logs.add({
    data: { openid: OPENID, day, minutes, sessions: 1, createdAt: new Date().toISOString() }
  });
  return { code: 0, added: minutes, day, id: doc._id };
};

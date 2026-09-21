// utils/focus-stats.js — 专注统计的统一取数与缓存
//
// 2026-09-21 新增，解决的问题（方案里的 B3）：
//   首页 / 番茄钟 / 统计 / 待办集 四个页面 onShow 时各调用一次 getFocusStats，
//   而该云函数在服务端是"分页扫全表"级别的操作。按官方资源点计费
//   （数据库调用 200 点/万次），一次逛 app 就是十几次数据库读。
//   这里加一层会话内缓存：同一份数据在 TTL 内只真正请求一次，
//   写完数据（recordSession）后由调用方 invalidate() 主动失效，保证不会看到旧值。
const TTL_MS = 120 * 1000;

let cache = { at: 0, data: null };
let inflight = null;

// 取统计结果。返回云函数的 result 对象（{ code, byDay, totals, abandons, ... }）；
// 失败时返回 { code: 1, error }，调用方按原来的分支逻辑处理即可。
function getFocusStats(force) {
  const now = Date.now();
  if (!force && cache.data && now - cache.at < TTL_MS) {
    return Promise.resolve(cache.data);
  }
  if (inflight) return inflight; // 并发调用合并成一次

  inflight = wx.cloud.callFunction({ name: 'getFocusStats' })
    .then((res) => {
      const r = (res && res.result) || { code: 1, error: '统计返回为空' };
      if (r.code === 0) cache = { at: Date.now(), data: r };
      return r;
    })
    .catch((err) => {
      console.error('getFocusStats failed', err);
      return { code: 1, error: '统计加载失败' };
    })
    .then((r) => { inflight = null; return r; });

  return inflight;
}

// 写入专注记录后调用：让下一次读取重新拉取
function invalidateFocusStats() {
  cache = { at: 0, data: null };
}

module.exports = { getFocusStats, invalidateFocusStats };

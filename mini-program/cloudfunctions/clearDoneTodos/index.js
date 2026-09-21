// 云函数 clearDoneTodos — 一次删除当前用户所有已完成的待办
//
// 2026-09-21 新增。原实现在客户端 for-await 逐个 remove():
// 条数多时等于 N 次网络往返、慢且中途失败会留下"删了一半"。
// 云函数侧用 where().remove() 批量删除(注意:权限在云函数里失效,
// 所以必须显式带上 openid 条件,否则会误删别人的数据)。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 1, error: '无法获取用户身份' };

  try {
    const res = await db.collection('todos').where({ openid: OPENID, done: true }).remove();
    const removed = (res.stats && (res.stats.removed || res.stats.removedCount)) || 0;
    return { code: 0, removed };
  } catch (err) {
    console.error('clearDoneTodos failed', err);
    return { code: 1, error: '清除失败,请重试' };
  }
};

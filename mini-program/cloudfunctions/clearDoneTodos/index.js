// 云函数 clearDoneTodos — 一次删除当前用户所有已完成的待办
//
// 2026-09-21 新增。原实现在客户端 for-await 逐个 remove():
// 条数多时等于 N 次网络往返、慢且中途失败会留下"删了一半"。
// 云函数侧用 where().remove() 批量删除(注意:权限在云函数里失效,
// 所以必须显式带上用户条件,否则会误删别人的数据)。
//
// 2026-09-21d 修复(B6 连带发现):待办是**客户端直写**的集合,文档里只有
// 平台自动注入的 `_openid`,没有 `openid` 字段 —— 原来只按 `openid` 查,
// 结果是一条也匹配不到,表现为点了"清除已完成"提示 0 条、待办还在原地。
// 现在两条路径都试,兼容两类写入方式。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 1, error: '无法获取用户身份' };

  try {
    let removed = 0;
    // ① 客户端写入的文档:平台注入的 _openid
    const byOpenid = await db.collection('todos').where({ _openid: OPENID, done: true }).remove();
    removed += (byOpenid.stats && (byOpenid.stats.removed || byOpenid.stats.removedCount)) || 0;
    // ② 兼容历史上用显式 openid 字段写入、没有 _openid 的文档
    const byOpenidField = await db.collection('todos')
      .where({ openid: OPENID, done: true, _openid: _.exists(false) })
      .remove();
    removed += (byOpenidField.stats && (byOpenidField.stats.removed || byOpenidField.stats.removedCount)) || 0;
    return { code: 0, removed };
  } catch (err) {
    console.error('clearDoneTodos failed', err);
    return { code: 1, error: '清除失败,请重试' };
  }
};

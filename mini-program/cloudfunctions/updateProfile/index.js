// 云函数 updateProfile — 设置昵称
//
// 2026-09-21 修复:原实现用 `where({ _openid: OPENID })` 更新,但文档里
// 没有 `_openid`(云函数写入不自动注入),所以昵称**从来没有真正写进库**。
// 改为按显式 `openid` 字段定位;若该用户还没有档案,则补建一条。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 1, error: '无法获取用户身份' };

  const name = String(event.name || '').trim();
  if (!name) return { code: 1, error: '昵称不能为空' };
  if (name.length > 24) return { code: 1, error: '昵称最多 24 个字符' };
  if (!/^[\u4e00-\u9fa5A-Za-z0-9_-]+$/.test(name)) return { code: 1, error: '昵称只能含中文、字母、数字、_ 和 -' };

  const users = db.collection('users');
  const updated = await users.where({ openid: OPENID }).update({ data: { name } });
  const count = updated.stats && (updated.stats.updated || updated.stats.updatedCount || 0);

  // 档案不存在就补建(旧数据是客户端/其它路径写入时可能没有 openid 字段)
  if (!count) {
    await users.add({
      data: {
        _openid: OPENID,   // B7:云函数写入不会自动注入,显式补上,便于把权限收紧
        openid: OPENID,
        name,
        createdAt: new Date().toISOString()
      }
    });
  }

  return { code: 0, name };
};

// utils/util.js — 通用工具
const weekdays = ['日', '一', '二', '三', '四', '五', '六'];

function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function todayKey() {
  return dateKey(new Date());
}

// 读取本地设置。此前每个页面各写一份 getSettings(),这里收拢成一份。
function getSettings() {
  try { return wx.getStorageSync('ts-settings') || {}; } catch (e) { return {}; }
}

// 归属日期:午夜模式开启时,0:00-4:00 计入前一天
// 所有"今日专注"的读与写都必须走这个函数(写入端见 pomodoro.onSessionComplete),
// 否则凌晨完成的专注会在番茄钟页算今天、在首页/统计/待办集算昨天,四页数字打架。
function dayKeyFor(hint) {
  if (hint && hint.midnightOn) {
    const now = new Date();
    const h = now.getHours();
    if (h >= 0 && h < 4) {
      const d = new Date(now);
      d.setDate(d.getDate() - 1);
      return dateKey(d);
    }
  }
  return todayKey();
}

// 相对 7 天标签
function weekLabels() {
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    out.push(i === 0 ? '今天' : '周' + weekdays[d.getDay()]);
  }
  return out;
}

function fmtClock(now) {
  const p = (n) => String(n).padStart(2, '0');
  return p(now.getHours()) + ':' + p(now.getMinutes()) + ':' + p(now.getSeconds());
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? '夜深了' : h < 12 ? '早上好' : h < 18 ? '下午好' : '晚上好';
}

module.exports = { dateKey, todayKey, getSettings, dayKeyFor, weekLabels, fmtClock, greeting, weekdays };

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

module.exports = { dateKey, todayKey, weekLabels, fmtClock, greeting, weekdays };

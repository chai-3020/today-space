// utils/theme.js — 主题色 / 图表配色（canvas 不继承 WXSS 变量，只能在这里给值）
//
// 2026-09-21 新增：此前 stats.js 的 canvas 颜色、pomodoro 的模式色全是硬编码，
// 切深色模式或换主题色时图表永远是一套固定色（深色下发灰、看不清）。
// 这里把"页面当前的配色"集中成一份，画布和渐变都从这里取。

// 五种主题色（与 profile 页的色板一致）
const ACCENTS = {
  green: '#0d9f6d',
  blue: '#3b6fd4',
  orange: '#e05f3a',
  purple: '#7c5cd6',
  pink: '#d6538c'
};

// 番茄钟三种模式在**着色模式**下的颜色（跟随主题色时用 accent）
const MODE_COLORS = { focus: '#0d9f6d', short: '#3b6fd4', long: '#c9871c' };

// 页面里反复出现的那段"色板 → class"映射，收拢到一处
const COLOR_CLASS = {
  green: '',
  blue: 'theme-blue',
  orange: 'theme-orange',
  purple: 'theme-purple',
  pink: 'theme-pink'
};

function colorClass(color) {
  return COLOR_CLASS[color] || '';
}

// 取当前页面的配色：app 里存着 theme('light'|'dark') 和 themeColor
function palette(app) {
  const theme = (app && app.theme) || 'light';
  const color = (app && app.themeColor) || 'green';
  const accent = ACCENTS[color] || ACCENTS.green;
  const dark = theme === 'dark';
  return {
    theme,
    color,
    dark,
    accent,
    accentSoft: dark ? 'rgba(255,255,255,0.10)' : 'rgba(13,159,109,0.12)',
    // 圆环轨道 / 图表空柱：深色下必须换成深色，否则整条看不见
    ringTrack: dark ? '#2b3438' : '#e8edf0',
    chartEmpty: dark ? '#2b3438' : '#dfe5e8',
    chartLabel: dark ? '#9aa9a4' : '#5c6b74'
  };
}

// 三种模式色：跟随主题色（focus 用 accent），休息色保持区分度
function modeColors(app) {
  const p = palette(app);
  return {
    focus: p.accent,
    short: p.dark ? '#7fa6f0' : '#3b6fd4',
    long: p.dark ? '#f0b64e' : '#c9871c'
  };
}

module.exports = { ACCENTS, MODE_COLORS, palette, modeColors, colorClass };

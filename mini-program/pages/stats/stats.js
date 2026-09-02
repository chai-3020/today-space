// pages/stats/stats.js — 专注统计中心(累计/今日/日周月分布/年度)
const util = require('../../utils/util.js');

Page({
  data: {
    themeClass: '',
    // 累计卡
    totalCount: 0,
    totalHours: 0,
    totalMins: 0,
    avgMins: 0,
    // 今日卡
    todayCount: 0,
    todayMins: 0,
    todayAbandon: 0,
    // 分布
    rangeMode: 'day',        // day | week | month | custom
    rangeTitle: '',
    canPrev: true,
    canNext: false,
    distLabels: [],
    distValues: [],
    distTotal: 0,
    // 自定义
    customStart: '',
    customEnd: '',
    // 年度
    year: 0,
    monthLabels: ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'],
    monthValues: []
  },

  // 非 data:偏移量(日±n/day、周±n/week、月±n/month)
  distOffset: 0,
  distAnchor: null,
  yearRef: 0,

  onLoad() {
    const now = new Date();
    this.yearRef = now.getFullYear();
    this.setData({ year: this.yearRef });
  },

  onShow() {
    const app = getApp();
    if (app.setNavBar) app.setNavBar();
    this.setData({ themeClass: app.theme === 'dark' ? 'theme-dark' : '' });
    this.loadAll();
  },

  async loadAll() {
    try {
      const db = wx.cloud.database();
      const res = await db.collection('focus_log').limit(1000).get();
      const rows = res.data || [];
      // 归一化:day -> {minutes, sessions}
      const byDay = {};
      let totalSessions = 0;
      let totalMinutes = 0;
      let activeDays = 0;
      const today = util.todayKey();

      for (const r of rows) {
        const day = r.day;
        if (!byDay[day]) byDay[day] = { minutes: 0, sessions: 0 };
        byDay[day].minutes += r.minutes || 0;
        byDay[day].sessions += r.sessions || 0;
      }
      for (const d of Object.keys(byDay)) {
        totalMinutes += byDay[d].minutes;
        totalSessions += byDay[d].sessions;
        activeDays++;
      }

      // 累计:日均 = 总分钟 / 活跃天数(或历史总天数,取活跃更直观)
      const avgMins = activeDays > 0 ? Math.round(totalMinutes / activeDays) : 0;
      this.setData({
        totalCount: totalSessions,
        totalHours: Math.floor(totalMinutes / 60),
        totalMins: totalMinutes % 60,
        avgMins,
        todayCount: byDay[today] ? byDay[today].sessions : 0,
        todayMins: byDay[today] ? byDay[today].minutes : 0,
        todayAbandon: 0 // 放弃次数:尚未记录,显示 0(后续加放弃记录)
      });

      // 历次数据缓存,供分布/年度用
      this._byDay = byDay;
      this.refreshRange();
      this.loadYear();
    } catch (err) {
      console.error('stats load failed', err);
      wx.showToast({ title: '数据加载失败', icon: 'none' });
    }
  },

  // ---- 分布切换 ----
  onMode(e) {
    const mode = e.currentTarget.dataset.mode;
    if (mode === 'custom') {
      // 自定义:默认最近30天
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - 30);
      this.setData({
        rangeMode: 'custom',
        customStart: util.dateKey(start),
        customEnd: util.dateKey(end)
      });
      this.distOffset = 0;
      this.refreshRange();
      return;
    }
    this.setData({ rangeMode: mode });
    this.distOffset = 0;
    this.refreshRange();
  },

  onPrev() {
    if (this.data.rangeMode === 'day') this.distOffset -= 1;
    else if (this.data.rangeMode === 'week') this.distOffset -= 1;
    else if (this.data.rangeMode === 'month') this.distOffset -= 1;
    else if (this.data.rangeMode === 'custom') this.distOffset -= 7;
    this.refreshRange();
  },

  onNext() {
    if (this.data.rangeMode === 'day') this.distOffset += 1;
    else if (this.data.rangeMode === 'week') this.distOffset += 1;
    else if (this.data.rangeMode === 'month') this.distOffset += 1;
    else if (this.data.rangeMode === 'custom') this.distOffset += 7;
    this.refreshRange();
  },

  onCustomStart(e) {
    this.setData({ customStart: e.detail.value });
    this.distOffset = 0;
    this.refreshRange();
  },

  onCustomEnd(e) {
    this.setData({ customEnd: e.detail.value });
    this.distOffset = 0;
    this.refreshRange();
  },

  // ---- 计算当前范围的分布 ----
  refreshRange() {
    const mode = this.data.rangeMode;
    const byDay = this._byDay || {};
    const res = this.computeRange(mode, this.distOffset);
    this.setData({
      rangeTitle: res.title,
      canPrev: res.canPrev,
      canNext: res.canNext,
      distLabels: res.labels,
      distValues: res.values,
      distTotal: res.total
    });
    // 页面加载布局后画图
    wx.nextTick(() => this.drawDistribution());
  },

  computeRange(mode, offset) {
    const byDay = this._byDay || {};
    const labels = [];
    const values = [];
    let total = 0;
    let title = '';
    let canPrev = true;
    let canNext = true;

    if (mode === 'day') {
      // 7 天窗口,以锚点日为中心,offset 平移
      const anchor = new Date();
      anchor.setDate(anchor.getDate() + offset * 7);
      const start = new Date(anchor); start.setDate(start.getDate() - 6);
      for (let i = 0; i < 7; i++) {
        const d = new Date(start); d.setDate(d.getDate() + i);
        const k = util.dateKey(d);
        const v = byDay[k] ? byDay[k].minutes : 0;
        total += v;
        labels.push(i === 6 ? '今天' : '周' + util.weekdays[d.getDay()]);
        values.push(v);
      }
      title = '专注时长分布 ' + util.dateKey(start) + ' ~ ' + util.dateKey(anchor);
      canNext = offset < 0;
    } else if (mode === 'week') {
      // 含锚点周的最近 8 周(不足向前补零)
      const anchor = new Date();
      anchor.setDate(anchor.getDate() + offset * 7);
      // 锚点所在周的周一
      const monday = new Date(anchor);
      const dow = (monday.getDay() + 6) % 7;
      monday.setDate(monday.getDate() - dow);
      const start = new Date(monday); start.setDate(start.getDate() - 7 * 7);
      for (let w = 0; w < 8; w++) {
        const ws = new Date(start); ws.setDate(ws.getDate() + 7 * w);
        const we = new Date(ws); we.setDate(we.getDate() + 6);
        let sum = 0;
        for (let d = 0; d < 7; d++) {
          const dd = new Date(ws); dd.setDate(dd.getDate() + d);
          const k = util.dateKey(dd);
          sum += byDay[k] ? byDay[k].minutes : 0;
        }
        total += sum;
        const wk = w === 7 ? '本周' : util.dateKey(ws).slice(5) + '周';
        labels.push(wk);
        values.push(sum);
      }
      title = '专注时长分布 ' + util.dateKey(start).slice(0, 7) + ' ~ ' + util.dateKey(monday).slice(0, 7);
      canNext = offset < 0;
    } else if (mode === 'month') {
      // 最近 12 个月
      const anchor = new Date();
      anchor.setMonth(anchor.getMonth() + offset);
      const start = new Date(anchor);
      start.setMonth(start.getMonth() - 11);
      for (let m = 0; m < 12; m++) {
        const d = new Date(start);
        d.setDate(1);
        d.setMonth(start.getMonth() + m);
        const y = d.getFullYear();
        const mo = d.getMonth() + 1;
        const daysInM = new Date(y, mo, 0).getDate();
        let sum = 0;
        for (let day = 1; day <= daysInM; day++) {
          const k = y + '-' + String(mo).padStart(2, '0') + '-' + String(day).padStart(2, '0');
          sum += byDay[k] ? byDay[k].minutes : 0;
        }
        total += sum;
        labels.push(m === 11 ? '本月' : mo + '月');
        values.push(sum);
      }
      title = '专注时长分布 ' + start.getFullYear() + '-' + String(start.getMonth() + 1).padStart(2, '0') + ' ~ ' + anchor.getFullYear() + '-' + String(anchor.getMonth() + 1).padStart(2, '0');
      canNext = offset < 0;
    } else if (mode === 'custom') {
      const s = this.data.customStart || util.dateKey(new Date(Date.now() - 30 * 86400000));
      const e2 = this.data.customEnd || util.dateKey(new Date());
      const start = new Date(s + 'T00:00:00');
      const end = new Date(e2 + 'T00:00:00');
      const days = Math.max(1, Math.round((end - start) / 86400000) + 1);
      const windowDays = Math.min(days, 31);
      // 从末尾取 windowDays 天(前进按 offset*7 平移)
      const effEnd = new Date(end);
      effEnd.setDate(effEnd.getDate() + offset * 7);
      const effStart = new Date(effEnd);
      effStart.setDate(effStart.getDate() - (windowDays - 1));
      for (let i = 0; i < windowDays; i++) {
        const d = new Date(effStart); d.setDate(d.getDate() + i);
        const k = util.dateKey(d);
        const v = byDay[k] ? byDay[k].minutes : 0;
        total += v;
        labels.push(String(d.getDate()));
        values.push(v);
      }
      title = '专注时长分布 ' + util.dateKey(effStart) + ' ~ ' + util.dateKey(effEnd);
      canNext = offset < 0;
    }
    return { title, labels, values, total, canPrev, canNext };
  },

  // ---- 年度 ----
  loadYear() {
    const byDay = this._byDay || {};
    const y = this.yearRef;
    const vals = [];
    for (let m = 1; m <= 12; m++) {
      const daysInM = new Date(y, m, 0).getDate();
      let sum = 0;
      for (let day = 1; day <= daysInM; day++) {
        const k = y + '-' + String(m).padStart(2, '0') + '-' + String(day).padStart(2, '0');
        sum += byDay[k] ? byDay[k].minutes : 0;
      }
      vals.push(sum);
    }
    this.setData({ monthValues: vals });
    wx.nextTick(() => this.drawYear());
  },

  // ---- 绘制:分布图(柱状) ----
  drawDistribution() {
    const query = wx.createSelectorQuery();
    query.select('#dist-chart').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) return;
      const canvas = res[0].node;
      const ctx = canvas.getContext('2d');
      const dpr = wx.getSystemInfoSync().pixelRatio || 2;
      canvas.width = res[0].width * dpr;
      canvas.height = res[0].height * dpr;
      ctx.scale(dpr, dpr);
      const w = res[0].width;
      const h = res[0].height;
      ctx.clearRect(0, 0, w, h);

      const values = this.data.distValues;
      const labels = this.data.distLabels;
      const max = Math.max(30, ...values);
      const pad = 14;
      const chartH = h - 30;
      const n = values.length;
      const gap = Math.max(2, Math.min(8, w / n / 5));
      const bw = Math.max(4, (w - pad * 2 - gap * (n - 1)) / n);

      values.forEach((v, i) => {
        const x = pad + i * (bw + gap);
        const bh = v === 0 ? 3 : Math.max(5, (v / max) * (chartH - 20));
        const y = chartH - bh;
        ctx.fillStyle = v > 0 ? '#0d9f6d' : '#dfe5e8';
        ctx.beginPath();
        const r = Math.min(3, bw / 2, bh / 2);
        ctx.roundRect ? ctx.roundRect(x, y, bw, bh, r) : ctx.rect(x, y, bw, bh);
        ctx.fill();
        // 数值
        if (v > 0) {
          ctx.fillStyle = '#5c6b74';
          ctx.font = '9px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(String(v), x + bw / 2, y - 3);
        }
        // 标签(间隔显示,避免挤)
        if (n <= 12 || i % Math.ceil(n / 12) === 0) {
          ctx.fillStyle = '#5c6b74';
          ctx.font = '9px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(String(labels[i]), x + bw / 2, h - 7);
        }
      });
    });
  },

  // ---- 绘制:年度(折线/柱状) ----
  drawYear() {
    const query = wx.createSelectorQuery();
    query.select('#year-chart').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) return;
      const canvas = res[0].node;
      const ctx = canvas.getContext('2d');
      const dpr = wx.getSystemInfoSync().pixelRatio || 2;
      canvas.width = res[0].width * dpr;
      canvas.height = res[0].height * dpr;
      ctx.scale(dpr, dpr);
      const w = res[0].width;
      const h = res[0].height;
      ctx.clearRect(0, 0, w, h);

      const vals = this.data.monthValues;
      const max = Math.max(30, ...vals);
      const pad = 14;
      const chartH = h - 26;
      const n = 12;
      const gap = 6;
      const bw = Math.max(6, (w - pad * 2 - gap * (n - 1)) / n);

      vals.forEach((v, i) => {
        const x = pad + i * (bw + gap);
        const bh = v === 0 ? 3 : Math.max(5, (v / max) * (chartH - 18));
        const y = chartH - bh;
        ctx.fillStyle = v > 0 ? '#0d9f6d' : '#dfe5e8';
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(x, y, bw, bh, 3) : ctx.rect(x, y, bw, bh);
        ctx.fill();
        ctx.fillStyle = '#5c6b74';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText((i + 1) + '月', x + bw / 2, h - 6);
      });
    });
  },

  // 空态:引导去番茄钟
  goPomodoro() {
    wx.switchTab({ url: '/pages/pomodoro/pomodoro' });
  },

  onPullDownRefresh() {
    this.loadAll();
    wx.stopPullDownRefresh();
  }
});

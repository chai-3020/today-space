// pages/stats/stats.js — 专注统计中心(累计/今日/日周月分布/年度)
const util = require('../../utils/util.js');
const themeUtil = require('../../utils/theme.js');
const statsApi = require('../../utils/focus-stats.js');
const DAY_MS = 86400000;

Page({
  data: {
    themeClass: '',
    colorClass: '',
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
    this.setData({ themeClass: app.theme === 'dark' ? 'theme-dark' : '',
      colorClass: themeUtil.colorClass(app.themeColor) });
    this.loadAll();
  },

  async loadAll(force) {
    try {
      const app = getApp();
      const openid = await app.waitOpenid();
      if (!openid) {
        console.warn('stats loadAll skipped: openid 未就绪');
        return;
      }
      // 2026-09-21 改造:原来在客户端 .limit(1000).get() 拉全量再自己按天累加,
      // 数据超 1000 条会静默截断、统计偏低。现在交给云函数在服务端分页聚合,
      // 只回传"每天一条"的小结果。
      // 2026-09-21d:再包一层缓存,四个页面共用一次请求(见 utils/focus-stats.js)。
      const r = await statsApi.getFocusStats(!!force);
      if (r.code !== 0) {
        console.error('getFocusStats failed', r.error);
        wx.showToast({ title: r.error || '统计加载失败', icon: 'none' });
        return;
      }
      const byDay = r.byDay || {};
      const abandons = r.abandons || {};
      const totals = r.totals || { minutes: 0, sessions: 0, days: 0 };
      if (r.truncated) {
        console.warn('getFocusStats: 数据量超过分页上限,统计为部分结果');
      }
      // 归属日期统一走 util.dayKeyFor(午夜模式),与番茄钟写入端、其它页面同口径
      const today = util.dayKeyFor(util.getSettings());
      const activeDays = totals.days || 0;
      const totalMinutes = Number(totals.minutes) || 0;
      const totalSessions = Number(totals.focusSessions || totals.sessions) || 0;

      // 累计:日均 = 总分钟 / 活跃天数(或历史总天数,取活跃更直观)
      const avgMins = activeDays > 0 ? Math.round(totalMinutes / activeDays) : 0;
      this.setData({
        totalCount: totalSessions,
        totalHours: Math.floor(totalMinutes / 60),
        totalMins: totalMinutes % 60,
        avgMins,
        todayCount: byDay[today] ? byDay[today].sessions : 0,
        todayMins: byDay[today] ? byDay[today].minutes : 0,
        // A6:放弃次数改为真实数据(切模式/重置/离开页面时上报的 abandoned 记录)
        todayAbandon: Number(abandons[today]) || 0
      });

      // 历次数据缓存,供分布/年度用
      this._byDay = byDay;
      this._abandons = abandons;
      // C2:算一个"最早有数据的那天",给"上一页"设下界
      const days = Object.keys(byDay).sort();
      this._earliestDay = days.length ? days[0] : util.todayKey();
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
    // C2:不能无限往前翻 —— 翻到"最早有数据的那天"所在窗口之前就没有意义了
    if (!this.canPrevFurther()) return;
    if (this.data.rangeMode === 'day') this.distOffset -= 1;
    else if (this.data.rangeMode === 'week') this.distOffset -= 1;
    else if (this.data.rangeMode === 'month') this.distOffset -= 1;
    else if (this.data.rangeMode === 'custom') this.distOffset -= 7;
    this.refreshRange();
  },

  // 最早有数据的那天(没有数据时就是今天)
  earliestDate() {
    const key = this._earliestDay || util.todayKey();
    const d = new Date(key + 'T00:00:00');
    return isNaN(d.getTime()) ? new Date() : d;
  },

  // offset 的可见下界:窗口起点不能早于最早数据日
  minOffset() {
    const mode = this.data.rangeMode;
    const earliest = this.earliestDate();
    const now = new Date();
    const days = Math.max(0, Math.round((now - earliest) / DAY_MS));
    if (mode === 'day') return -Math.floor(days / 7);
    if (mode === 'week') return -Math.max(0, Math.floor(days / 7));
    if (mode === 'month') return -Math.max(0, Math.min(11, Math.round(days / 30)));
    return -Math.max(0, Math.ceil(days / 7)); // custom:窗口宽度固定 31 天以内,按 7 天平移
  },

  canPrevFurther() {
    return this.distOffset > this.minOffset();
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
    const res = this.computeRange(mode, this.distOffset);
    this.setData({
      rangeTitle: res.title,
      // canPrev 不再只看"能不能往未来翻",还要求没翻到最早数据之前(C2)
      canPrev: res.canPrev && this.canPrevFurther(),
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

  // ---- 绘制:统一入口(A5:颜色必须跟随主题,canvas 不继承 WXSS 变量)----
  drawDistribution() {
    this.paintBars('#dist-chart', {
      values: this.data.distValues,
      labels: this.data.distLabels,
      labelEvery: true
    });
  },

  drawYear() {
    this.paintBars('#year-chart', {
      values: this.data.monthValues,
      labels: this.data.monthLabels.map((_, i) => (i + 1) + '月'),
      labelEvery: true,
      chartPad: 26
    });
  },

  paintBars(selector, opts) {
    const values = opts.values || [];
    const labels = opts.labels || [];
    const chartPad = opts.chartPad || 30;
    const query = wx.createSelectorQuery();
    query.select(selector).fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) return;
      const canvas = res[0].node;
      const ctx = canvas.getContext('2d');
      const dpr = (wx.getSystemInfoSync().pixelRatio) || 2;
      canvas.width = res[0].width * dpr;
      canvas.height = res[0].height * dpr;
      ctx.scale(dpr, dpr);
      const w = res[0].width;
      const h = res[0].height;
      ctx.clearRect(0, 0, w, h);

      // A5/C8:取当前主题调色板 —— 之前这里是写死的 #0d9f6d / #dfe5e8 / #5c6b74,
      // 深色模式下柱子发灰、切主题色图表永远是绿的。
      const p = themeUtil.palette(getApp());

      const max = Math.max(30, ...values, 1);
      const pad = 14;
      const chartH = h - chartPad;
      const n = values.length || 1;
      const gap = n > 12 ? 6 : Math.max(2, Math.min(8, w / n / 5));
      const bw = Math.max(4, (w - pad * 2 - gap * (n - 1)) / n);
      const labelStep = Math.max(1, Math.ceil(n / 12));

      values.forEach((v, i) => {
        const x = pad + i * (bw + gap);
        const bh = v === 0 ? 3 : Math.max(5, (v / max) * (chartH - 20));
        const y = chartH - bh;
        ctx.fillStyle = v > 0 ? p.accent : p.chartEmpty;
        ctx.beginPath();
        const r = Math.min(3, bw / 2, bh / 2);
        ctx.roundRect ? ctx.roundRect(x, y, bw, bh, r) : ctx.rect(x, y, bw, bh);
        ctx.fill();

        ctx.font = '9px sans-serif';
        ctx.textAlign = 'center';
        // 数值(仅非零,避免 31 根柱子上全是 0)
        if (v > 0) {
          ctx.fillStyle = p.chartLabel;
          ctx.fillText(String(v), x + bw / 2, y - 3);
        }
        // 标签:柱数多时按 step 抽稀,避免挤成一团(C4)
        if (i % labelStep === 0 || i === n - 1) {
          ctx.fillStyle = p.chartLabel;
          ctx.fillText(String(labels[i] === undefined ? '' : labels[i]), x + bw / 2, h - 7);
        }
      });
    });
  },

  // 空态:引导去番茄钟
  goPomodoro() {
    wx.navigateTo({ url: '/pages/pomodoro/pomodoro' });
  },

  onPullDownRefresh() {
    this.loadAll();
    wx.stopPullDownRefresh();
  }
});
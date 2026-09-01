// pages/stats/stats.js — 本周专注统计(柱状图)
const util = require('../../utils/util.js');

Page({
  data: {
    days: [],
    totalMinutes: 0
  },

  onShow() { this.loadAndDraw(); },

  onReady() { this.drawCanvas(this.data.days || []); },

  async loadAndDraw() {
    try {
      const db = wx.cloud.database();
      const res = await db.collection('focus_log').limit(1000).get();
      const byDay = {};
      for (const r of res.data) {
        byDay[r.day] = (byDay[r.day] || 0) + r.minutes;
      }

      const labels = util.weekLabels();
      const days = [];
      let total = 0;
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const k = util.dateKey(d);
        const value = byDay[k] || 0;
        total += value;
        days.push({ label: labels[i], value, pct: 0, key: k });
      }
      const max = Math.max(30, ...days.map((x) => x.value));
      for (const day of days) {
        day.pct = day.value === 0 ? 2 : Math.max(5, Math.round((day.value / max) * 100));
      }
      this.setData({ days, totalMinutes: total });
      this.drawCanvas(days);
    } catch (err) {
      console.error('stats load failed', err);
    }
  },

  drawCanvas(days) {
    const query = wx.createSelectorQuery();
    query.select('#weekly-chart').fields({ node: true, size: true }).exec((res) => {
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

      const max = Math.max(30, ...days.map((d) => d.value));
      const pad = 16;
      const chartH = h - 30;
      const gap = 10;
      const bw = Math.max(8, (w - pad * 2 - gap * 6) / 7);

      days.forEach((d, i) => {
        const x = pad + i * (bw + gap);
        const bh = d.value === 0 ? 4 : Math.max(6, (d.value / max) * (chartH - 24));
        const y = chartH - bh;
        ctx.fillStyle = i === 6 ? '#0d9f6d' : '#dfe5e8';
        ctx.beginPath();
        const r = Math.min(4, bw / 2, bh / 2);
        ctx.roundRect ? ctx.roundRect(x, y, bw, bh, r) : ctx.rect(x, y, bw, bh);
        ctx.fill();
        if (d.value > 0) {
          ctx.fillStyle = '#5c6b74';
          ctx.font = '10px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(String(d.value), x + bw / 2, y - 4);
        }
        ctx.fillStyle = '#5c6b74';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(d.label, x + bw / 2, h - 6);
      });
    });
  }
});
// stats.js 纯逻辑测试 — node:test + node:assert
// 运行: node --test tests/stats.test.mjs
// 注：只测纯逻辑（日期 / 时间序列 / 速度 / 汇总），不碰 loadStats/saveStats。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STATS_VERSION, STATS_KEEP_DAYS, SPEED_WINDOW_DAYS, CHART_DAYS,
  dayKey, dayLabel, dayGap, emptyStore, normalizeStore, trimDays, recordDay,
  historyOf, dailyRates, countBySource, summarize, etaText,
} from '../src/stats.js';

/* ---------------- 日期 ---------------- */

test('dayKey: 本地日期键，补零', () => {
  assert.equal(dayKey(new Date(2026, 8, 10, 5, 3).getTime()), '2026-09-10');
  assert.equal(dayKey(new Date(2026, 0, 1).getTime()), '2026-01-01');
  assert.equal(dayKey(NaN) !== '', true);
});

test('dayLabel: MM-DD；非法原样返回', () => {
  assert.equal(dayLabel('2026-09-10'), '09-10');
  assert.equal(dayLabel('乱码'), '乱码');
  assert.equal(dayLabel(null), '');
});

test('dayGap: 日历天差；非法返回 0', () => {
  assert.equal(dayGap('2026-09-10', '2026-09-10'), 0);
  assert.equal(dayGap('2026-09-10', '2026-09-13'), 3);
  assert.equal(dayGap('2026-09-10', '2026-09-09'), -1);
  assert.equal(dayGap('x', '2026-09-09'), 0);
  // 跨月/跨年
  assert.equal(dayGap('2026-08-31', '2026-09-01'), 1);
  assert.equal(dayGap('2025-12-31', '2026-01-01'), 1);
});

/* ---------------- 存储 ---------------- */

test('recordDay: 同一天覆盖写（不是累加），保留最近值', () => {
  let s = emptyStore();
  s = recordDay(s, 'doc1', { name: 'a.ks', at: new Date(2026, 8, 10, 9).getTime(), done: 10, total: 100 });
  s = recordDay(s, 'doc1', { name: 'a.ks', at: new Date(2026, 8, 10, 21).getTime(), done: 42, total: 100 });
  const h = historyOf(s, 'doc1');
  assert.equal(h.length, 1);
  assert.equal(h[0].done, 42);
  assert.equal(s.docs.doc1.total, 100);
});

test('recordDay: 不同文档互不影响；docKey 为空则忽略', () => {
  let s = emptyStore();
  s = recordDay(s, 'a', { at: Date.now(), done: 1, total: 2 });
  s = recordDay(s, 'b', { at: Date.now(), done: 5, total: 9 });
  assert.equal(historyOf(s, 'a')[0].done, 1);
  assert.equal(historyOf(s, 'b')[0].done, 5);
  const same = recordDay(s, '', { at: Date.now(), done: 9 });
  assert.equal(Object.keys(same.docs).length, 2);
});

test('recordDay: 记录来源归因；负值/非法归零', () => {
  const s = recordDay(emptyStore(), 'd', { at: Date.now(), done: 7, total: 10, byMt: 3, byTm: -2, byHuman: 'x' });
  const d = s.docs.d.days[dayKey(Date.now())];
  assert.equal(d.byMt, 3);
  assert.equal(d.byTm, 0);
  assert.equal(d.byHuman, 0);
});

test('trimDays / normalizeStore: 只留最近 N 天，丢坏数据', () => {
  const days = {};
  for (let i = 0; i < 10; i++) days['2026-09-' + String(i + 1).padStart(2, '0')] = { done: i };
  const kept = trimDays(days, 3);
  assert.deepEqual(Object.keys(kept).sort(), ['2026-09-08', '2026-09-09', '2026-09-10']);

  const s = normalizeStore({
    docs: {
      ok: { name: 'x', total: 10, days: { '2026-09-10': { done: 5 }, '坏日期': { done: 1 }, '2026-09-11': null } },
      bad: '不是对象',
      deeper: { name: 1, total: -5, days: {} },
    },
  });
  assert.deepEqual(Object.keys(s.docs).sort(), ['deeper', 'ok']);
  assert.deepEqual(Object.keys(s.docs.ok.days), ['2026-09-10']);
  assert.equal(s.docs.deeper.total, 0);
  assert.equal(s.version, STATS_VERSION);
  assert.equal(normalizeStore(null).docs && Object.keys(normalizeStore(null).docs).length, 0);
  assert.equal(STATS_KEEP_DAYS, 120);
});

test('historyOf: 按日期升序', () => {
  let s = emptyStore();
  s = recordDay(s, 'd', { at: new Date(2026, 8, 12).getTime(), done: 30 });
  s = recordDay(s, 'd', { at: new Date(2026, 8, 10).getTime(), done: 10 });
  s = recordDay(s, 'd', { at: new Date(2026, 8, 11).getTime(), done: 20 });
  assert.deepEqual(historyOf(s, 'd').map(h => h.date), ['2026-09-10', '2026-09-11', '2026-09-12']);
  assert.deepEqual(historyOf(s, '不存在'), []);
  assert.deepEqual(historyOf(null, 'd'), []);
});

/* ---------------- 速度 ---------------- */

test('dailyRates: 相邻差按日历天摊平', () => {
  const rates = dailyRates([
    { date: '2026-09-10', done: 0 },
    { date: '2026-09-11', done: 30 },   // 隔 1 天，涨 30 → 30/天
    { date: '2026-09-14', done: 120 },  // 隔 3 天，涨 90 → 30/天
  ]);
  assert.deepEqual(rates, [
    { date: '2026-09-11', rate: 30 },
    { date: '2026-09-14', rate: 30 },
  ]);
});

test('dailyRates: 负增长按 0 计（清空翻译不该把历史速度拉负）', () => {
  const rates = dailyRates([
    { date: '2026-09-10', done: 100 },
    { date: '2026-09-11', done: 40 },
  ]);
  assert.equal(rates[0].rate, 0);
});

test('dailyRates: 单条/空输入返回空', () => {
  assert.deepEqual(dailyRates([{ date: '2026-09-10', done: 1 }]), []);
  assert.deepEqual(dailyRates([]), []);
  assert.deepEqual(dailyRates(null), []);
});

/* ---------------- 归因 ---------------- */

test('countBySource: 以 p.done 为准（与 filestats.countStates 同口径）', () => {
  const paras = [
    { done: true, src: 'mt', isName: false },
    { done: true, src: 'tm', isName: false },
    { done: true, isName: false },                 // 无标记 = 人工
    { done: false, isName: false },
    { done: true, src: 'mt', isName: true },       // NAME 行也按 done 计
    null,
  ];
  const c = countBySource(paras);
  assert.equal(c.mt, 2);
  assert.equal(c.tm, 1);
  assert.equal(c.human, 1);
  assert.equal(c.done, 4);      // = mt + tm + human，不会和 countStates.done 对不上
  assert.equal(c.total, 6);
});

test('countBySource: 空输入安全', () => {
  assert.deepEqual(countBySource(null), { mt: 0, tm: 0, human: 0, done: 0, total: 0 });
  assert.deepEqual(countBySource([]), { mt: 0, tm: 0, human: 0, done: 0, total: 0 });
});

/* ---------------- 汇总 ---------------- */

const NOW = new Date(2026, 8, 10, 15, 0).getTime();   // 2026-09-10 15:00 本地

function hist(dates, dones){
  return dates.map((date, i) => ({ date, done: dones[i] }));
}

test('summarize: 基本量与百分比', () => {
  const s = summarize({ history: [], total: 1000, done: 400, bySrc: { mt: 300, tm: 50, human: 50 }, now: NOW });
  assert.equal(s.total, 1000);
  assert.equal(s.done, 400);
  assert.equal(s.remaining, 600);
  assert.equal(s.percent, 40);
  assert.equal(s.mtRatio, 75);
});

test('summarize: 速度与 ETA —— 排除今天、只看窗口内', () => {
  // 9/7 涨 30、9/8 涨 30、9/9 涨 30；今天(9/10)涨 5 —— 今天应被排除
  const h = hist(
    ['2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10'],
    [0, 30, 60, 90, 95],
  );
  const s = summarize({ history: h, total: 200, done: 95, bySrc: {}, now: NOW });
  assert.equal(s.speedPerDay, 30);
  assert.equal(s.sampleDays, 3);
  assert.equal(s.remaining, 105);
  assert.equal(s.etaDays, 4);                 // ceil(105/30) = 4
  assert.equal(s.etaDate, '2026-09-14');
  assert.equal(s.hasSpeed, true);
  assert.equal(s.etaUnknown, false);
});

test('summarize: 只有今天一条记录时推不出速度', () => {
  const s = summarize({ history: hist(['2026-09-10'], [50]), total: 200, done: 50, bySrc: {}, now: NOW });
  assert.equal(s.speedPerDay, 0);
  assert.equal(s.hasSpeed, false);
  assert.equal(s.etaUnknown, true);
  assert.equal(s.etaDays, null);
  assert.ok(etaText(s).includes('推不出速度'));
});

test('summarize: 窗口外的历史不参与速度估算，也不会污染窗口内首条', () => {
  // 7 月初暴涨 900 行，然后 69 天没记录，9/9 只有 10 行。
  // 若先算差值再裁窗口，9/9 会被摊成 10/69 ≈ 0.1/天 —— 必须先裁窗口。
  const h = hist(
    ['2026-07-01', '2026-07-02', '2026-09-09', '2026-09-10'],
    [0, 900, 910, 915],
  );
  const s = summarize({ history: h, total: 1000, done: 915, bySrc: {}, now: NOW });
  // 窗口内(8/28 起)只有 9/9 与今天；9/9 没有窗口内的前一条 → 无速率可算
  assert.equal(s.sampleDays, 0);
  assert.equal(s.speedPerDay, 0);
  assert.equal(s.etaUnknown, true);
});

test('summarize: 已完成时不报 ETA，直接「已完成」', () => {
  const s = summarize({ history: [], total: 100, done: 100, bySrc: {}, now: NOW });
  assert.equal(s.remaining, 0);
  assert.equal(s.etaDays, 0);
  assert.equal(etaText(s), '已完成');
});

test('summarize: 空文档不抛错，百分比为 0', () => {
  const s = summarize({ total: 0, done: 0, bySrc: {}, now: NOW });
  assert.equal(s.percent, 0);
  assert.equal(s.remaining, 0);
  assert.deepEqual(s.chart, []);
});

test('summarize: chart 取最近 CHART_DAYS 天并算日增量', () => {
  const dates = [], dones = [];
  for (let i = 1; i <= 20; i++){
    dates.push('2026-09-' + String(i).padStart(2, '0'));
    dones.push(i * 10);
  }
  const s = summarize({ history: hist(dates, dones), total: 500, done: 200, bySrc: {}, now: NOW });
  assert.equal(s.chart.length, CHART_DAYS);
  assert.equal(s.chart[0].date, '2026-09-07');            // 20 - 14 + 1
  assert.equal(s.chart[0].label, '09-07');
  assert.equal(s.chart[1].delta, 10);                     // 相邻差
});

test('summarize: window 可调；bySrc 缺字段安全', () => {
  const h = hist(
    ['2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09'],
    [0, 10, 20, 30, 40],
  );
  // 窗口 5 天 = 含今天的最近 5 个日历日(9/6..9/10) → 窗口内记录 9/6..9/9，
  // 首条无前一条，故产生 3 条速率，各 10/天
  const s = summarize({ history: h, total: 100, done: 40, bySrc: {}, now: NOW, window: 5 });
  assert.equal(s.sampleDays, 3);
  assert.equal(s.speedPerDay, 10);

  // 窗口 2 天（9/9 起）→ 窗口内只有 9/9，没有前一条 → 推不出速度
  const tight = summarize({ history: h, total: 100, done: 40, bySrc: {}, now: NOW, window: 2 });
  assert.equal(tight.sampleDays, 0);
  assert.equal(SPEED_WINDOW_DAYS, 14);

  const s2 = summarize({ history: [], total: 1, done: 1, now: NOW });
  assert.deepEqual(s2.bySrc, { mt: 0, tm: 0, human: 0 });
  assert.equal(s2.mtRatio, 0);
});

test('etaText: 三种文案', () => {
  assert.equal(etaText(null), '—');
  assert.equal(etaText({ remaining: 0 }), '已完成');
  assert.equal(etaText({ remaining: 10, etaUnknown: true }), '按现有数据推不出速度（至少需要两天的记录）');
  assert.equal(etaText({ remaining: 10, etaDays: 3, etaDate: '2026-09-13' }), '约 3 天（2026-09-13）');
});

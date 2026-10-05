const express = require('express');
const { q, one } = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();

const PROVS = ['Luanda', 'Huambo', 'Malanje', 'Bié', 'Cuanza Sul', 'Benguela'];

// Índice semanal (últimas 8 semanas) combinando pedidos + pesquisas por categoria.
async function weeklySeries(category) {
  const rows = await q(
    `WITH weeks AS (
       SELECT generate_series(date_trunc('week', now()) - interval '7 weeks', date_trunc('week', now()), interval '1 week') AS wk
     ),
     ord AS (
       SELECT date_trunc('week', o.created_at) AS wk, COUNT(*)::int AS n
       FROM orders o JOIN products p ON p.id = o.product_id
       WHERE p.category = $1 AND o.created_at > now() - interval '8 weeks'
       GROUP BY 1
     ),
     sea AS (
       SELECT date_trunc('week', created_at) AS wk, COUNT(*)::int AS n
       FROM search_events WHERE category = $1 AND created_at > now() - interval '8 weeks'
       GROUP BY 1
     )
     SELECT weeks.wk, COALESCE(ord.n,0) AS orders, COALESCE(sea.n,0) AS searches
     FROM weeks LEFT JOIN ord ON ord.wk = weeks.wk LEFT JOIN sea ON sea.wk = weeks.wk
     ORDER BY weeks.wk ASC`,
    [category]
  );
  // índice 0-100: pedidos valem mais que pesquisas isoladas
  return rows.map((r) => Math.min(100, r.orders * 12 + r.searches * 4 + 8));
}

async function provinceRanking(category) {
  const rows = await q(
    `SELECT o.dest_province AS province, COUNT(*)::int AS n
     FROM orders o JOIN products p ON p.id = o.product_id
     WHERE p.category = $1 AND o.created_at > now() - interval '90 days'
     GROUP BY 1`,
    [category]
  );
  const map = Object.fromEntries(PROVS.map((p) => [p, 1])); // baseline para nunca ficar a zero
  rows.forEach((r) => { if (map[r.province] != null) map[r.province] += r.n * 15; });
  const max = Math.max(...Object.values(map));
  Object.keys(map).forEach((k) => (map[k] = Math.min(100, Math.round((map[k] / max) * 100))));
  return map;
}

router.get('/demand/:category', auth, async (req, res) => {
  const category = req.params.category;
  const series = await weeklySeries(category);
  const ranking = await provinceRanking(category);
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const pctChange = Math.round((avg(series.slice(-4)) / Math.max(1, avg(series.slice(0, 4))) - 1) * 100);
  res.json({ category, series, ranking, pctChange });
});

router.get('/top-category', auth, async (req, res) => {
  const rows = await q(
    `SELECT category, SUM(n)::int AS score FROM (
       SELECT p.category, COUNT(*) * 12 AS n FROM orders o JOIN products p ON p.id=o.product_id
       WHERE o.created_at > now() - interval '7 days' GROUP BY 1
       UNION ALL
       SELECT category, COUNT(*) * 4 AS n FROM search_events WHERE created_at > now() - interval '7 days' GROUP BY 1
     ) x GROUP BY category ORDER BY score DESC LIMIT 1`
  );
  res.json(rows[0] || null);
});

module.exports = router;

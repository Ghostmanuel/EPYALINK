const express = require('express');
const { q, one } = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/mine', auth, requireRole('BUYER'), async (req, res) => {
  const rows = await q('SELECT * FROM favorites WHERE user_id=$1 ORDER BY created_at DESC', [req.user.id]);
  res.json(rows.map((r) => ({ type: r.type, targetId: r.target_id })));
});

router.post('/', auth, requireRole('BUYER'), async (req, res) => {
  const { type, targetId } = req.body;
  if (!['PRODUCT', 'FARM'].includes(type) || !targetId) return res.status(400).json({ error: 'Dados inválidos.' });
  const existing = await one('SELECT id FROM favorites WHERE user_id=$1 AND type=$2 AND target_id=$3', [req.user.id, type, targetId]);
  if (existing) {
    await q('DELETE FROM favorites WHERE id=$1', [existing.id]);
    return res.json({ favorited: false });
  }
  await q('INSERT INTO favorites (user_id, type, target_id) VALUES ($1,$2,$3)', [req.user.id, type, targetId]);
  res.json({ favorited: true });
});

module.exports = router;

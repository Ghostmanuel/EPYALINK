const express = require('express');
const { q } = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

router.get('/mine', auth, async (req, res) => {
  const rows = await q('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [req.user.id]);
  res.json(rows);
});

router.post('/:id/read', auth, async (req, res) => {
  await q('UPDATE notifications SET read=TRUE WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

router.post('/read-all', auth, async (req, res) => {
  await q('UPDATE notifications SET read=TRUE WHERE user_id=$1', [req.user.id]);
  res.json({ ok: true });
});

module.exports = router;

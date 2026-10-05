const express = require('express');
const { q, one } = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();

function shapeFarm(f) {
  if (!f) return null;
  return {
    id: f.id,
    ownerId: f.owner_id,
    name: f.name,
    type: f.type,
    province: f.province,
    municipality: f.municipality,
    about: f.about,
    verified: f.verified,
    avatarUrl: f.avatar_url,
    rating: f.rating_count ? f.rating_sum / f.rating_count : 0,
    ratingCount: f.rating_count,
    salesCount: f.sales_count,
    completedRate: f.completed_rate,
    crops: f.crops || [],
    ownerName: f.owner_name
  };
}

router.get('/', async (req, res) => {
  const rows = await q(
    `SELECT f.*, u.name AS owner_name FROM farms f JOIN users u ON u.id=f.owner_id ORDER BY f.rating_count DESC`
  );
  res.json(rows.map(shapeFarm));
});

router.get('/:id', async (req, res) => {
  const f = await one(`SELECT f.*, u.name AS owner_name FROM farms f JOIN users u ON u.id=f.owner_id WHERE f.id=$1`, [req.params.id]);
  if (!f) return res.status(404).json({ error: 'Fazenda não encontrada.' });
  const photos = await q('SELECT id, url FROM farm_photos WHERE farm_id=$1', [f.id]);
  const products = await q('SELECT * FROM products WHERE farm_id=$1 ORDER BY created_at DESC', [f.id]);
  const reviews = await q(
    `SELECT * FROM reviews WHERE target_type='FARM' AND target_id=$1 ORDER BY created_at DESC LIMIT 50`,
    [f.id]
  );
  res.json({
    ...shapeFarm(f),
    photos: photos.map((p) => ({ id: p.id, url: p.url })),
    products,
    reviews
  });
});

router.get('/me/mine', auth, requireRole('SELLER'), async (req, res) => {
  const f = await one('SELECT f.*, u.name AS owner_name FROM farms f JOIN users u ON u.id=f.owner_id WHERE owner_id=$1', [req.user.id]);
  res.json(shapeFarm(f));
});

router.put('/me/mine', auth, requireRole('SELLER'), async (req, res) => {
  const { about, avatarUrl, name } = req.body;
  const f = await one('SELECT id FROM farms WHERE owner_id=$1', [req.user.id]);
  if (!f) return res.status(404).json({ error: 'Fazenda não encontrada.' });
  await q(
    `UPDATE farms SET about=COALESCE($1,about), avatar_url=COALESCE($2,avatar_url), name=COALESCE($3,name) WHERE id=$4`,
    [about, avatarUrl, name, f.id]
  );
  const updated = await one('SELECT f.*, u.name AS owner_name FROM farms f JOIN users u ON u.id=f.owner_id WHERE f.id=$1', [f.id]);
  res.json(shapeFarm(updated));
});

router.post('/me/photos', auth, requireRole('SELLER'), async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Falta a imagem.' });
  const f = await one('SELECT id FROM farms WHERE owner_id=$1', [req.user.id]);
  if (!f) return res.status(404).json({ error: 'Fazenda não encontrada.' });
  const row = await one('INSERT INTO farm_photos (farm_id, url) VALUES ($1,$2) RETURNING id, url', [f.id, url]);
  res.json(row);
});

module.exports = router;

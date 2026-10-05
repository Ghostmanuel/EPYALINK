const express = require('express');
const { q, one } = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();

async function myCarrier(userId) {
  return one('SELECT * FROM carrier_profiles WHERE user_id=$1', [userId]);
}

router.get('/me', auth, requireRole('CARRIER'), async (req, res) => {
  const c = await myCarrier(req.user.id);
  if (!c) return res.status(404).json({ error: 'Perfil de transportadora não encontrado.' });
  const vehicles = await q('SELECT * FROM vehicles WHERE carrier_id=$1', [c.id]);
  const drivers = await q('SELECT * FROM drivers WHERE carrier_id=$1', [c.id]);
  const docs = await q('SELECT * FROM carrier_documents WHERE carrier_id=$1 ORDER BY expires_at ASC', [c.id]);
  res.json({
    id: c.id,
    companyName: c.company_name,
    kind: c.kind,
    province: c.province,
    verified: c.verified,
    rating: c.rating_count ? c.rating_sum / c.rating_count : 0,
    ratingCount: c.rating_count,
    tripsCount: c.trips_count,
    vehicles,
    drivers,
    documents: docs
  });
});

router.post('/vehicles', auth, requireRole('CARRIER'), async (req, res) => {
  const c = await myCarrier(req.user.id);
  const { plate, type, capacityTons } = req.body;
  if (!plate || !type || !(capacityTons > 0)) return res.status(400).json({ error: 'Indica matrícula, tipo e capacidade.' });
  const row = await one('INSERT INTO vehicles (carrier_id, plate, type, capacity_tons) VALUES ($1,$2,$3,$4) RETURNING *', [c.id, plate, type, capacityTons]);
  res.json(row);
});

router.put('/vehicles/:id', auth, requireRole('CARRIER'), async (req, res) => {
  const c = await myCarrier(req.user.id);
  const v = await one('SELECT * FROM vehicles WHERE id=$1 AND carrier_id=$2', [req.params.id, c.id]);
  if (!v) return res.status(404).json({ error: 'Veículo não encontrado.' });
  if (v.status === 'viagem') return res.status(409).json({ error: 'Não é possível alterar um veículo em viagem.' });
  if (!['disponivel', 'manutencao'].includes(req.body.status)) return res.status(400).json({ error: 'Estado inválido.' });
  await q('UPDATE vehicles SET status=$1 WHERE id=$2', [req.body.status, v.id]);
  res.json({ ok: true });
});

router.post('/drivers', auth, requireRole('CARRIER'), async (req, res) => {
  const c = await myCarrier(req.user.id);
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Indica o nome do motorista.' });
  const row = await one('INSERT INTO drivers (carrier_id, name) VALUES ($1,$2) RETURNING *', [c.id, name]);
  res.json(row);
});

router.put('/drivers/:id', auth, requireRole('CARRIER'), async (req, res) => {
  const c = await myCarrier(req.user.id);
  const d = await one('SELECT * FROM drivers WHERE id=$1 AND carrier_id=$2', [req.params.id, c.id]);
  if (!d) return res.status(404).json({ error: 'Motorista não encontrado.' });
  if (d.status === 'viagem') return res.status(409).json({ error: 'Não é possível alterar um motorista em viagem.' });
  if (!['disponivel', 'folga'].includes(req.body.status)) return res.status(400).json({ error: 'Estado inválido.' });
  await q('UPDATE drivers SET status=$1 WHERE id=$2', [req.body.status, d.id]);
  res.json({ ok: true });
});

router.post('/documents', auth, requireRole('CARRIER'), async (req, res) => {
  const c = await myCarrier(req.user.id);
  const { name, expiresAt } = req.body;
  if (!name || !expiresAt) return res.status(400).json({ error: 'Indica o nome e a validade do documento.' });
  const row = await one('INSERT INTO carrier_documents (carrier_id, name, expires_at) VALUES ($1,$2,$3) RETURNING *', [c.id, name, expiresAt]);
  res.json(row);
});

// transportes ainda sem transportador atribuído
router.get('/jobs/open', auth, requireRole('CARRIER'), async (req, res) => {
  const c = await myCarrier(req.user.id);
  const mode = c && c.kind === 'ESTAFETA' ? 'ESTAFETA' : 'AGROLINK';
  const rows = await q(
    `SELECT o.id FROM orders o WHERE o.mode=$1 AND o.status='ACCEPTED' AND o.carrier_id IS NULL ORDER BY o.created_at ASC`,
    [mode]
  );
  res.json(rows.map((r) => r.id));
});

module.exports = router;

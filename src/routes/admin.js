const express = require('express');
const { q, one } = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();

// ---------- pedidos de verificação ----------
router.post('/verifications', auth, requireRole('SELLER', 'CARRIER', 'AGENT'), async (req, res) => {
  const { docs } = req.body;
  if (!Array.isArray(docs) || !docs.length) return res.status(400).json({ error: 'Indica pelo menos um documento.' });
  if (req.user.role === 'SELLER') {
    const farm = await one('SELECT * FROM farms WHERE owner_id=$1', [req.user.id]);
    if (!farm) return res.status(404).json({ error: 'Fazenda não encontrada.' });
    const row = await one(`INSERT INTO verification_requests (kind, name, farm_id, docs) VALUES ($1,$2,$3,$4) RETURNING *`, [farm.type, farm.name, farm.id, docs]);
    return res.json(row);
  }
  if (req.user.role === 'CARRIER') {
    const carrier = await one('SELECT * FROM carrier_profiles WHERE user_id=$1', [req.user.id]);
    if (!carrier) return res.status(404).json({ error: 'Transportadora não encontrada.' });
    const row = await one(
      `INSERT INTO verification_requests (kind, name, carrier_id, docs) VALUES ($1,$2,$3,$4) RETURNING *`,
      [carrier.kind === 'ESTAFETA' ? 'Estafeta' : 'Transportadora', carrier.company_name, carrier.id, docs]
    );
    return res.json(row);
  }
  const agent = await one('SELECT * FROM agent_profiles WHERE user_id=$1', [req.user.id]);
  if (!agent) return res.status(404).json({ error: 'Ponto EPYALINK não encontrado.' });
  const row = await one(`INSERT INTO verification_requests (kind, name, agent_id, docs) VALUES ($1,$2,$3,$4) RETURNING *`, ['Ponto EPYALINK', agent.point_name, agent.id, docs]);
  res.json(row);
});

router.get('/verifications', auth, requireRole('ADMIN'), async (req, res) => {
  const rows = await q('SELECT * FROM verification_requests ORDER BY created_at DESC');
  res.json(rows);
});

router.post('/verifications/:id/decide', auth, requireRole('ADMIN'), async (req, res) => {
  const v = await one('SELECT * FROM verification_requests WHERE id=$1', [req.params.id]);
  if (!v) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (v.state !== 'PENDENTE') return res.status(409).json({ error: 'Este pedido já foi decidido.' });
  const approve = !!req.body.approve;
  await q(`UPDATE verification_requests SET state=$1 WHERE id=$2`, [approve ? 'APROVADO' : 'RECUSADO', v.id]);
  if (approve) {
    if (v.farm_id) await q('UPDATE farms SET verified=TRUE WHERE id=$1', [v.farm_id]);
    if (v.carrier_id) await q('UPDATE carrier_profiles SET verified=TRUE WHERE id=$1', [v.carrier_id]);
    if (v.agent_id) await q('UPDATE agent_profiles SET verified=TRUE WHERE id=$1', [v.agent_id]);
  }
  res.json({ ok: true });
});

// ---------- Rede logística: Pontos EPYALINK e Hubs ----------
router.get('/agents', auth, requireRole('ADMIN', 'SELLER'), async (req, res) => {
  const where = req.query.province ? 'WHERE province=$1' : '';
  const rows = await q(`SELECT * FROM agent_profiles ${where} ORDER BY point_name`, req.query.province ? [req.query.province] : []);
  res.json(rows.map((a) => ({ id: a.id, pointName: a.point_name, province: a.province, municipality: a.municipality, verified: a.verified, validationsCount: a.validations_count })));
});

router.get('/hubs', auth, async (req, res) => {
  const rows = await q('SELECT * FROM hubs WHERE active ORDER BY kind, province');
  res.json(rows.map((h) => ({ id: h.id, name: h.name, kind: h.kind, province: h.province, lat: h.lat, lng: h.lng })));
});

router.post('/hubs', auth, requireRole('ADMIN'), async (req, res) => {
  const { name, kind, province, lat, lng } = req.body;
  if (!name || !['REGIONAL', 'MICRO_URBANO'].includes(kind) || !province || typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'Indica nome, tipo, província e coordenadas válidas.' });
  }
  const row = await one('INSERT INTO hubs (name, kind, province, lat, lng) VALUES ($1,$2,$3,$4,$5) RETURNING *', [name, kind, province, lat, lng]);
  res.json(row);
});

router.put('/hubs/:id', auth, requireRole('ADMIN'), async (req, res) => {
  const active = req.body.active != null ? !!req.body.active : true;
  const row = await one('UPDATE hubs SET active=$1 WHERE id=$2 RETURNING *', [active, req.params.id]);
  if (!row) return res.status(404).json({ error: 'Hub não encontrado.' });
  res.json({ ok: true });
});

// ---------- visão geral ----------
router.get('/overview', auth, requireRole('ADMIN'), async (req, res) => {
  const total = await one('SELECT COUNT(*)::int AS n FROM orders');
  const byStatus = await q('SELECT status, COUNT(*)::int AS n FROM orders GROUP BY status');
  const bySegment = await q('SELECT segment, COUNT(*)::int AS n FROM orders GROUP BY segment');
  const held = await one(
    `SELECT COALESCE(SUM(goods_total + fee_total),0)::bigint AS s FROM orders WHERE status IN ('PAID','ACCEPTED','CARRIER_OK','IN_TRANSIT','DELIVERED','DISPUTED')`
  );
  const revenue = await q(`SELECT kind, COALESCE(SUM(amount),0)::bigint AS s FROM ledger_entries WHERE party='PLATFORM' GROUP BY kind`);
  const revenueByKind = revenue.reduce((acc, r) => ((acc[r.kind] = Number(r.s)), acc), {});
  const commission = Object.values(revenueByKind).reduce((a, b) => a + b, 0);
  const disputesOpen = await one(`SELECT COUNT(*)::int AS n FROM disputes WHERE state IN ('ABERTA','EVIDENCIAS_PEDIDAS')`);
  const verifPending = await one(`SELECT COUNT(*)::int AS n FROM verification_requests WHERE state='PENDENTE'`);
  const agents = await one(`SELECT COUNT(*)::int AS n FROM agent_profiles`);
  const points = await one(`SELECT COUNT(*)::int AS n FROM hubs WHERE active`);
  res.json({
    totalOrders: total.n,
    byStatus: byStatus.reduce((acc, r) => ((acc[r.status] = r.n), acc), {}),
    bySegment: bySegment.reduce((acc, r) => ((acc[r.segment] = r.n), acc), {}),
    heldAmount: Number(held.s),
    commissionEarned: commission,
    revenueByKind,
    disputesOpen: disputesOpen.n,
    verificationsPending: verifPending.n,
    agentsCount: agents.n,
    hubsCount: points.n
  });
});

module.exports = router;

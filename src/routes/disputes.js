const express = require('express');
const { q, one } = require('../db');
const { auth, requireRole } = require('../middleware/auth');
const { notify, addLog, short, releaseFunds } = require('../lib/finance');

const router = express.Router();

router.get('/mine', auth, async (req, res) => {
  let rows;
  if (req.user.role === 'ADMIN') {
    rows = await q('SELECT d.*, o.buyer_id FROM disputes d JOIN orders o ON o.id=d.order_id ORDER BY d.created_at DESC');
  } else if (req.user.role === 'BUYER') {
    rows = await q('SELECT d.* FROM disputes d JOIN orders o ON o.id=d.order_id WHERE o.buyer_id=$1 ORDER BY d.created_at DESC', [req.user.id]);
  } else if (req.user.role === 'SELLER') {
    rows = await q(
      `SELECT d.* FROM disputes d JOIN orders o ON o.id=d.order_id JOIN products p ON p.id=o.product_id JOIN farms f ON f.id=p.farm_id
       WHERE f.owner_id=$1 ORDER BY d.created_at DESC`,
      [req.user.id]
    );
  } else {
    return res.json([]);
  }
  res.json(rows);
});

router.post('/:id/resolve', auth, requireRole('ADMIN'), async (req, res) => {
  const dispute = await one('SELECT * FROM disputes WHERE id=$1', [req.params.id]);
  if (!dispute) return res.status(404).json({ error: 'Disputa não encontrada.' });
  if (dispute.state !== 'ABERTA' && dispute.state !== 'EVIDENCIAS_PEDIDAS') {
    return res.status(409).json({ error: 'Esta disputa já foi resolvida.' });
  }
  const order = await one('SELECT * FROM orders WHERE id=$1', [dispute.order_id]);
  const product = await one('SELECT f.owner_id FROM products p JOIN farms f ON f.id=p.farm_id WHERE p.id=$1', [order.product_id]);
  const how = req.body.how; // 'refund' | 'release' | 'more'

  if (how === 'refund') {
    if (order.released_at) return res.status(409).json({ error: 'O valor já foi libertado ao vendedor; não é possível reembolsar automaticamente.' });
    await q(`UPDATE disputes SET state='REEMBOLSADO' WHERE id=$1`, [dispute.id]);
    await q(`UPDATE orders SET status='REFUNDED' WHERE id=$1`, [order.id]);
    await q('UPDATE products SET qty = ROUND((qty + $1)::numeric, 6)::double precision WHERE id=$2', [order.qty, order.product_id]);
    await addLog(order.id, 'Disputa resolvida: reembolso ao comprador · estoque devolvido');
    await notify(order.buyer_id, `Reembolso decidido no pedido ${short(order.id)}.`, 'pay', 'orders');
    await notify(product.owner_id, `Disputa do pedido ${short(order.id)} resolvida a favor do comprador.`, 'warn', 'sales');
  } else if (how === 'release') {
    await q(`UPDATE disputes SET state='PAGAMENTO_LIBERTADO' WHERE id=$1`, [dispute.id]);
    await q(`UPDATE orders SET status='CONFIRMED', confirmed_at=COALESCE(confirmed_at, now()) WHERE id=$1`, [order.id]);
    await addLog(order.id, 'Disputa resolvida: pagamento libertado ao vendedor');
    await releaseFunds(order.id);
    await notify(product.owner_id, `Disputa do pedido ${short(order.id)} resolvida a teu favor. Pagamento libertado.`, 'pay', 'sales');
  } else {
    await q(`UPDATE disputes SET state='EVIDENCIAS_PEDIDAS' WHERE id=$1`, [dispute.id]);
    await addLog(order.id, 'Administrador pediu mais evidências');
    await notify(order.buyer_id, `O administrador pediu mais evidências no pedido ${short(order.id)}.`, 'warn', 'orders');
  }
  res.json({ ok: true });
});

module.exports = router;

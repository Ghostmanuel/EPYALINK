const express = require('express');
const { q, one } = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

async function myRoleInThread(t, user) {
  if (user.role === 'BUYER') return t.buyer_id === user.id ? 'buyer' : null;
  if (user.role === 'SELLER') {
    const farm = await one('SELECT id FROM farms WHERE owner_id=$1', [user.id]);
    const prod = await one('SELECT farm_id FROM products WHERE id=$1', [t.product_id]);
    return farm && prod && farm.id === prod.farm_id ? 'seller' : null;
  }
  return null;
}

router.get('/mine', auth, async (req, res) => {
  let threads;
  if (req.user.role === 'BUYER') {
    threads = await q('SELECT * FROM message_threads WHERE buyer_id=$1 ORDER BY created_at DESC', [req.user.id]);
  } else if (req.user.role === 'SELLER') {
    const farm = await one('SELECT id FROM farms WHERE owner_id=$1', [req.user.id]);
    threads = farm
      ? await q('SELECT t.* FROM message_threads t JOIN products p ON p.id=t.product_id WHERE p.farm_id=$1 ORDER BY t.created_at DESC', [farm.id])
      : [];
  } else {
    return res.json([]);
  }
  const out = [];
  for (const t of threads) {
    const product = await one('SELECT id, name, category, unit, price, farm_id FROM products WHERE id=$1', [t.product_id]);
    const lastMsg = await one('SELECT text, sender_role, created_at FROM messages WHERE thread_id=$1 ORDER BY created_at DESC LIMIT 1', [t.id]);
    const unreadCol = req.user.role === 'BUYER' ? 'read_by_buyer' : 'read_by_seller';
    const unreadRow = await one(`SELECT COUNT(*)::int AS n FROM messages WHERE thread_id=$1 AND ${unreadCol}=FALSE AND sender_role != $2`, [t.id, req.user.role.toLowerCase()]);
    const buyer = await one('SELECT name FROM users WHERE id=$1', [t.buyer_id]);
    out.push({
      id: t.id,
      productId: t.product_id,
      orderId: t.order_id,
      buyerId: t.buyer_id,
      buyerName: buyer?.name,
      product,
      lastMessage: lastMsg,
      unread: unreadRow.n > 0
    });
  }
  res.json(out);
});

router.get('/:id', auth, async (req, res) => {
  const t = await one('SELECT * FROM message_threads WHERE id=$1', [req.params.id]);
  if (!t) return res.status(404).json({ error: 'Conversa não encontrada.' });
  const role = await myRoleInThread(t, req.user);
  if (!role) return res.status(403).json({ error: 'Sem acesso a esta conversa.' });
  const msgs = await q('SELECT * FROM messages WHERE thread_id=$1 ORDER BY created_at ASC', [t.id]);
  const col = role === 'buyer' ? 'read_by_buyer' : 'read_by_seller';
  await q(`UPDATE messages SET ${col}=TRUE WHERE thread_id=$1`, [t.id]);
  const product = await one('SELECT id, name, category, unit, price, farm_id FROM products WHERE id=$1', [t.product_id]);
  res.json({
    id: t.id,
    productId: t.product_id,
    orderId: t.order_id,
    buyerId: t.buyer_id,
    product,
    myRole: role,
    messages: msgs.map((m) => ({ id: m.id, senderRole: m.sender_role, text: m.text, createdAt: m.created_at }))
  });
});

// abrir (ou obter) conversa sobre um produto/pedido — só o comprador pode iniciar
router.post('/', auth, async (req, res) => {
  const { productId, orderId } = req.body;
  if (req.user.role !== 'BUYER') return res.status(403).json({ error: 'Só o comprador pode iniciar a conversa.' });
  const product = await one('SELECT id FROM products WHERE id=$1', [productId]);
  if (!product) return res.status(404).json({ error: 'Produto não encontrado.' });

  let t = orderId
    ? await one('SELECT * FROM message_threads WHERE order_id=$1', [orderId])
    : await one('SELECT * FROM message_threads WHERE product_id=$1 AND buyer_id=$2 AND order_id IS NULL', [productId, req.user.id]);
  if (!t) {
    t = await one('INSERT INTO message_threads (product_id, order_id, buyer_id) VALUES ($1,$2,$3) RETURNING *', [productId, orderId || null, req.user.id]);
  }
  res.json({ id: t.id });
});

router.post('/:id/messages', auth, async (req, res) => {
  const t = await one('SELECT * FROM message_threads WHERE id=$1', [req.params.id]);
  if (!t) return res.status(404).json({ error: 'Conversa não encontrada.' });
  const role = await myRoleInThread(t, req.user);
  if (!role) return res.status(403).json({ error: 'Sem acesso a esta conversa.' });
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Escreve uma mensagem.' });
  const readByBuyer = role === 'buyer';
  const readBySeller = role === 'seller';
  await q(
    `INSERT INTO messages (thread_id, sender_id, sender_role, text, read_by_buyer, read_by_seller) VALUES ($1,$2,$3,$4,$5,$6)`,
    [t.id, req.user.id, role, text, readByBuyer, readBySeller]
  );
  const product = await one('SELECT name, farm_id FROM products WHERE id=$1', [t.product_id]);
  if (role === 'buyer') {
    const farm = await one('SELECT owner_id FROM farms WHERE id=$1', [product.farm_id]);
    await q('INSERT INTO notifications (user_id, text, kind, view) VALUES ($1,$2,$3,$4)', [farm.owner_id, `Nova mensagem de ${req.user.name} sobre ${product.name}.`, 'msg', 'chat']);
  } else {
    const buyer = await one('SELECT name FROM users WHERE id=$1', [t.buyer_id]);
    await q('INSERT INTO notifications (user_id, text, kind, view) VALUES ($1,$2,$3,$4)', [t.buyer_id, `Nova mensagem sobre ${product.name}.`, 'msg', 'chat']);
  }
  res.json({ ok: true });
});

module.exports = router;

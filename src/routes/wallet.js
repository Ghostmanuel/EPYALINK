const express = require('express');
const bcrypt = require('bcryptjs');
const { q, one } = require('../db');
const { auth, requireRole } = require('../middleware/auth');
const sms = require('../lib/sms');
const { walletBalance } = require('../lib/finance');
const { MIN_WITHDRAW, WITHDRAW_FEE_RATE } = require('../lib/business');

const router = express.Router();

router.get('/me', auth, requireRole('SELLER', 'CARRIER', 'AGENT'), async (req, res) => {
  const { balance, available } = await walletBalance(req.user.id);
  const entries = await q('SELECT * FROM ledger_entries WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [req.user.id]);
  const withdrawals = await q('SELECT id, amount, fee, status, created_at FROM withdrawals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30', [req.user.id]);
  res.json({
    balance,
    available,
    minWithdraw: MIN_WITHDRAW,
    withdrawFeeRate: WITHDRAW_FEE_RATE,
    entries: entries.map((e) => ({ id: e.id, orderId: e.order_id, kind: e.kind, amount: e.amount, note: e.note, createdAt: e.created_at })),
    withdrawals
  });
});

// ---------- levantamento: pedido de código por SMS (Cash-Out) ----------
router.post('/withdraw', auth, requireRole('SELLER', 'CARRIER', 'AGENT'), async (req, res) => {
  const amount = Math.round(Number(req.body.amount));
  if (!(amount >= MIN_WITHDRAW)) return res.status(400).json({ error: `O levantamento mínimo é de ${MIN_WITHDRAW} Kz.` });
  const { available } = await walletBalance(req.user.id);
  if (amount > available) return res.status(400).json({ error: 'Saldo disponível insuficiente.' });
  const fee = Math.round(amount * WITHDRAW_FEE_RATE);

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const codeHash = await bcrypt.hash(code, 8);
  const w = await one(
    `INSERT INTO withdrawals (user_id, amount, fee, code_hash, expires_at) VALUES ($1,$2,$3,$4, now() + interval '15 minutes') RETURNING id`,
    [req.user.id, amount, fee, codeHash]
  );
  const user = await one('SELECT phone FROM users WHERE id=$1', [req.user.id]);
  const r = await sms.sendTransactional(user.phone, `EPYALINK: codigo para confirmar levantamento de ${amount} Kz: ${code}. Valido por 15 min.`);
  res.json({
    withdrawalId: w.id,
    fee,
    net: amount - fee,
    sentVia: r.via === 'kambasms' ? 'SMS' : 'APP',
    // sem KambaSMS configurada (modo de desenvolvimento), devolve o código para não bloquear o teste
    devCode: r.via === 'local' ? code : undefined
  });
});

router.post('/withdraw/:id/confirm', auth, requireRole('SELLER', 'CARRIER', 'AGENT'), async (req, res) => {
  const w = await one('SELECT * FROM withdrawals WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  if (!w) return res.status(404).json({ error: 'Levantamento não encontrado.' });
  if (w.status !== 'PENDENTE_CODIGO') return res.status(409).json({ error: 'Este levantamento já foi processado.' });
  if (new Date(w.expires_at) < new Date()) {
    await q(`UPDATE withdrawals SET status='CANCELADO' WHERE id=$1`, [w.id]);
    return res.status(410).json({ error: 'O código expirou. Pede um novo levantamento.' });
  }
  if (w.attempts >= 5) return res.status(429).json({ error: 'Demasiadas tentativas. Pede um novo levantamento.' });
  const ok = await bcrypt.compare(String(req.body.code || ''), w.code_hash);
  if (!ok) {
    await q('UPDATE withdrawals SET attempts = attempts + 1 WHERE id=$1', [w.id]);
    return res.status(400).json({ error: 'Código incorreto.' });
  }
  const { available } = await walletBalance(req.user.id);
  if (w.amount > available) {
    await q(`UPDATE withdrawals SET status='CANCELADO' WHERE id=$1`, [w.id]);
    return res.status(409).json({ error: 'Saldo insuficiente para concluir este levantamento.' });
  }
  await q(
    `INSERT INTO ledger_entries (user_id, party, kind, amount, note) VALUES
     ($1,$2,'LEVANTAMENTO',$3,'Levantamento via carteira móvel'),
     ($1,'PLATFORM','TAXA_LEVANTAMENTO',$4,'Taxa de intermediação (carteira móvel)')`,
    [req.user.id, req.user.role === 'CARRIER' ? 'CARRIER' : req.user.role === 'AGENT' ? 'AGENT' : 'SELLER', -w.amount, w.fee]
  );
  await q(`UPDATE withdrawals SET status='PAGO' WHERE id=$1`, [w.id]);
  res.json({ ok: true, net: w.amount - w.fee });
});

module.exports = router;

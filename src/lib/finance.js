// Custódia (escrow), livro-razão e envio do PIN de entrega.
const { q, one } = require('../db');
const sms = require('./sms');
const { CUSTODY_RATE, AGENT_RATE, COMM_CARRIER, COMM_ESTAFETA, FRAC_RATE } = require('./business');

async function notify(userId, text, kind, view) {
  if (!userId) return;
  await q('INSERT INTO notifications (user_id, text, kind, view) VALUES ($1,$2,$3,$4)', [userId, text, kind || 'ok', view || null]);
}
async function addLog(orderId, message) {
  await q('INSERT INTO order_logs (order_id, message) VALUES ($1,$2)', [orderId, message]);
}
const short = (id) => String(id).slice(0, 8);

/**
 * Envia o PIN de 6 dígitos por SMS ao telemóvel do COMPRADOR (nunca ao transportador).
 * Sem KambaSMS configurada, o PIN só existe no servidor (modo local) e a app mostra-o
 * ao comprador como alternativa — ver shapeOrder em routes/orders.js.
 */
async function sendPinSms(order) {
  const buyer = await one('SELECT phone FROM users WHERE id=$1', [order.buyer_id]);
  if (!buyer) return { via: 'failed' };
  const r = await sms.sendTransactional(
    buyer.phone,
    `EPYALINK: o teu PIN de entrega e ${order.code} (pedido ${short(order.id)}). Diz-o apenas a quem te entregar a mercadoria.`
  );
  if (r.via !== 'failed') await q('UPDATE orders SET pin_sent_at=now() WHERE id=$1', [order.id]);
  return r;
}

/**
 * Liberta o valor em custódia: credita produtor, transportador e Ponto EPYALINK, e regista
 * as receitas da plataforma. Atómico e idempotente (released_at só é escrito uma vez).
 */
async function releaseFunds(orderId) {
  const o = await one('UPDATE orders SET released_at=now() WHERE id=$1 AND released_at IS NULL RETURNING *', [orderId]);
  if (!o) return null;
  const farm = await one(
    'SELECT f.id AS farm_id, f.owner_id FROM products p JOIN farms f ON f.id=p.farm_id WHERE p.id=$1',
    [o.product_id]
  );
  const goods = Number(o.goods_total);
  const custody = Math.round(goods * CUSTODY_RATE);
  const frac = o.segment === 'RETALHO' ? Math.round(goods * FRAC_RATE) : 0;
  const sellerNet = goods - custody - frac;
  const short8 = short(o.id);
  const put = (party, userId, kind, amount, note) =>
    amount === 0
      ? null
      : q('INSERT INTO ledger_entries (order_id, user_id, party, kind, amount, note) VALUES ($1,$2,$3,$4,$5,$6)', [o.id, userId, party, kind, amount, note || '']);

  await put('SELLER', farm.owner_id, 'VENDA', sellerNet, `Pedido ${short8}`);
  await put('PLATFORM', null, 'CUSTODIA_PIN', custody, `Taxa de custódia & PIN SMS · pedido ${short8}`);
  await put('PLATFORM', null, 'MARGEM_FRACIONAMENTO', frac, `Margem de fracionamento · pedido ${short8}`);
  await put('PLATFORM', null, 'TAKE_RATE', Number(o.platform_fee), `Take rate B2B · pedido ${short8}`);

  if (o.carrier_id && Number(o.fee_total) > 0) {
    const rate = o.mode === 'ESTAFETA' ? COMM_ESTAFETA : COMM_CARRIER;
    const comm = Math.round(Number(o.fee_total) * rate);
    const cp = await one('SELECT user_id FROM carrier_profiles WHERE id=$1', [o.carrier_id]);
    await put('CARRIER', cp && cp.user_id, 'TRANSPORTE', Number(o.fee_total) - comm, `Transporte · pedido ${short8}`);
    await put('PLATFORM', null, 'COMISSAO_TRANSPORTE', comm, `Comissão de transporte · pedido ${short8}`);
    await q('UPDATE carrier_profiles SET trips_count = trips_count + 1 WHERE id=$1', [o.carrier_id]);
    if (cp) await notify(cp.user_id, `Pagamento do transporte libertado (pedido ${short8}).`, 'pay', 'wallet');
  }

  if (o.point_id && o.pickup_validated_at) {
    const agent = await one('SELECT user_id FROM agent_profiles WHERE id=$1', [o.point_id]);
    const comm = Math.round(goods * AGENT_RATE);
    if (agent) {
      await put('AGENT', agent.user_id, 'COMISSAO_PONTO', comm, `Recolha validada · pedido ${short8}`);
      await put('PLATFORM', null, 'COMISSAO_PONTO_PAGA', -comm, `Comissão paga ao Ponto · pedido ${short8}`);
      await q('UPDATE agent_profiles SET validations_count = validations_count + 1 WHERE id=$1', [o.point_id]);
      await notify(agent.user_id, `Comissão de ${comm} Kz creditada (pedido ${short8}).`, 'pay', 'wallet');
    }
  }

  await q('UPDATE farms SET sales_count = sales_count + 1 WHERE id=$1', [farm.farm_id]);
  await notify(farm.owner_id, `Pagamento libertado: ${sellerNet} Kz (pedido ${short8}). Já podes avaliar o comprador.`, 'pay', 'wallet');
  return o;
}

async function walletBalance(userId) {
  const r = await one('SELECT COALESCE(SUM(amount),0)::bigint AS s FROM ledger_entries WHERE user_id=$1', [userId]);
  const h = await one(
    `SELECT COALESCE(SUM(amount),0)::bigint AS s FROM withdrawals WHERE user_id=$1 AND status IN ('PENDENTE_CODIGO')`,
    [userId]
  );
  const balance = Number(r.s);
  return { balance, available: balance - Number(h.s) };
}

module.exports = { notify, addLog, short, sendPinSms, releaseFunds, walletBalance };

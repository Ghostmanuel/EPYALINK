const express = require('express');
const { q, one } = require('../db');
const { auth, requireRole } = require('../middleware/auth');
const sms = require('../lib/sms');
const {
  PROV, KG, RETAIL_MAX_KG, TAKE_RATE, PIN_MAX_ATTEMPTS,
  haversineKm, km, feeFor, zoneCoords, retailFee, genPin
} = require('../lib/business');
const { notify, addLog, short, sendPinSms, releaseFunds } = require('../lib/finance');

const router = express.Router();

// ---------- leitura de pedidos ----------
async function fullOrder(id, viewer) {
  const o = await one(
    `SELECT o.*, p.name AS product_name, p.category, p.unit, p.farm_id,
            f.name AS farm_name, f.owner_id AS farm_owner_id, f.province AS farm_province, f.municipality AS farm_municipality, f.verified AS farm_verified,
            bu.name AS buyer_name, bu.company_name AS buyer_company, bu.buyer_rating_sum, bu.buyer_rating_cnt,
            cp.company_name AS carrier_name, cp.kind AS carrier_kind, cp.user_id AS carrier_user_id,
            ap.point_name, ap.user_id AS agent_user_id
     FROM orders o
     JOIN products p ON p.id = o.product_id
     JOIN farms f ON f.id = p.farm_id
     JOIN users bu ON bu.id = o.buyer_id
     LEFT JOIN carrier_profiles cp ON cp.id = o.carrier_id
     LEFT JOIN agent_profiles ap ON ap.id = o.point_id
     WHERE o.id = $1`,
    [id]
  );
  if (!o) return null;
  const logs = await q('SELECT message, created_at FROM order_logs WHERE order_id=$1 ORDER BY created_at ASC', [id]);
  const disputes = await q('SELECT * FROM disputes WHERE order_id=$1 ORDER BY created_at DESC', [id]);
  return { raw: o, shaped: shapeOrder(o, logs, disputes, viewer) };
}

function shapeOrder(o, logs = [], disputes = [], viewer = null) {
  const isBuyer = viewer && viewer.role === 'BUYER' && viewer.id === o.buyer_id;
  const showPin = isBuyer && !sms.hasKamba() && ['ACCEPTED', 'CARRIER_OK', 'IN_TRANSIT'].includes(o.status);
  return {
    id: o.id,
    // O PIN só é devolvido ao COMPRADOR e apenas quando não há SMS configurada (alternativa
    // em modo de desenvolvimento). Com KambaSMS ativa, o PIN chega exclusivamente por SMS.
    pin: showPin ? o.code : undefined,
    pinSent: !!o.pin_sent_at,
    pinChannel: sms.hasKamba() ? 'SMS' : 'APP',
    pinLocked: o.pin_attempts >= PIN_MAX_ATTEMPTS,
    status: o.status,
    mode: o.mode,
    segment: o.segment,
    qty: Number(o.qty),
    retailKg: o.retail_kg != null ? Number(o.retail_kg) : null,
    unitPrice: o.unit_price,
    goodsTotal: o.goods_total,
    feeTotal: o.fee_total,
    platformFee: o.platform_fee,
    destProvince: o.dest_province,
    destZone: o.dest_zone,
    distanceKm: o.distance_km,
    payMethod: o.pay_method,
    near: o.near,
    driverName: o.driver_name,
    vehiclePlate: o.vehicle_plate,
    carrierName: o.carrier_name,
    carrierKind: o.carrier_kind,
    carrierId: o.carrier_id,
    pointId: o.point_id,
    pointName: o.point_name,
    pickupValidatedAt: o.pickup_validated_at,
    releasedAt: o.released_at,
    evidence: o.evidence_at
      ? { at: o.evidence_at, photo: o.evidence_photo, place: o.evidence_place, who: o.evidence_who }
      : null,
    confirmedAt: o.confirmed_at,
    ratedBuyer: o.rated_buyer,
    createdAt: o.created_at,
    buyerId: o.buyer_id,
    buyerName: o.buyer_name,
    buyerCompany: o.buyer_company,
    buyerRating: o.buyer_rating_cnt ? o.buyer_rating_sum / o.buyer_rating_cnt : 0,
    buyerRatingCount: o.buyer_rating_cnt,
    product: { id: o.product_id, name: o.product_name, category: o.category, unit: o.unit },
    farm: {
      id: o.farm_id,
      name: o.farm_name,
      ownerId: o.farm_owner_id,
      province: o.farm_province,
      municipality: o.farm_municipality,
      verified: o.farm_verified
    },
    logs: logs.map((l) => ({ message: l.message, at: l.created_at })),
    disputes
  };
}

async function loadOrder(id, viewer) {
  const r = await fullOrder(id, viewer);
  return r ? r.shaped : null;
}

/** Quem pode ver/atuar no pedido? Devolve o papel do utilizador nesse pedido, ou null. */
async function roleOnOrder(user, raw) {
  if (user.role === 'ADMIN') return 'admin';
  if (user.role === 'BUYER') return raw.buyer_id === user.id ? 'buyer' : null;
  if (user.role === 'SELLER') return raw.farm_owner_id === user.id ? 'seller' : null;
  if (user.role === 'CARRIER') return raw.carrier_user_id === user.id ? 'carrier' : null;
  if (user.role === 'AGENT') return raw.agent_user_id === user.id ? 'agent' : null;
  return null;
}

// ---------- criar pedido (comprador) ----------
router.post('/', auth, requireRole('BUYER'), async (req, res) => {
  const { productId, destProvince, destZone } = req.body;
  const segment = req.body.segment === 'RETALHO' ? 'RETALHO' : 'B2B';
  if (!productId) return res.status(400).json({ error: 'Dados do pedido incompletos.' });

  const product = await one(
    'SELECT p.*, f.province, f.owner_id FROM products p JOIN farms f ON f.id=p.farm_id WHERE p.id=$1',
    [productId]
  );
  if (!product) return res.status(404).json({ error: 'Produto não encontrado.' });

  let mode, qty, retailKg = null, dest, originC, destC, zone = null, distanceKm, unitPrice, goodsTotal, fee = 0, platformFee = 0;

  if (segment === 'RETALHO') {
    // Retalho urbano: fracionamento em kg e entrega porta a porta por estafeta local.
    if (!product.retail_enabled || !(product.retail_price_kg > 0)) {
      return res.status(400).json({ error: 'Este produto não está disponível a retalho.' });
    }
    retailKg = Number(req.body.retailKg);
    if (!Number.isInteger(retailKg) || retailKg < 1 || retailKg > RETAIL_MAX_KG) {
      return res.status(400).json({ error: `No retalho, escolhe entre 1 e ${RETAIL_MAX_KG} kg.` });
    }
    if (!PROV[destProvince]) return res.status(400).json({ error: 'Escolhe a cidade de entrega.' });
    destC = zoneCoords(destProvince, destZone);
    if (!destC) return res.status(400).json({ error: 'Escolhe a zona de entrega.' });
    const hub = await one(
      `SELECT * FROM hubs WHERE kind='MICRO_URBANO' AND province=$1 AND active ORDER BY created_at LIMIT 1`,
      [destProvince]
    );
    if (!hub) return res.status(409).json({ error: 'Ainda não há Micro-Hub urbano nesta cidade.' });
    mode = 'ESTAFETA';
    dest = destProvince;
    zone = destZone;
    originC = [hub.lat, hub.lng];
    distanceKm = Math.max(1, Math.round(haversineKm(hub.lat, hub.lng, destC[0], destC[1]) * 1.3));
    qty = retailKg / (KG[product.unit] || 1); // quantidade descontada do estoque, na unidade do produto
    unitPrice = product.retail_price_kg;
    goodsTotal = Math.round(retailKg * unitPrice);
    fee = retailFee(distanceKm);
  } else {
    // B2B interprovincial (core business)
    mode = req.body.mode;
    qty = Number(req.body.qty);
    if (!['RECOLHA', 'VENDEDOR', 'AGROLINK'].includes(mode) || !(qty > 0)) {
      return res.status(400).json({ error: 'Dados do pedido incompletos.' });
    }
    if (Number(product.min_order) > 0 && qty < Number(product.min_order)) {
      return res.status(400).json({ error: `Pedido mínimo B2B deste produto: ${product.min_order} ${product.unit}.` });
    }
    dest = mode === 'RECOLHA' ? product.province : destProvince || 'Luanda';
    if (!PROV[dest]) return res.status(400).json({ error: 'Província de destino inválida.' });
    originC = PROV[product.province] || null;
    destC = PROV[dest];
    distanceKm = km(product.province, dest);
    unitPrice = product.price;
    goodsTotal = Math.round(qty * unitPrice);
    fee = mode === 'AGROLINK' ? feeFor(product.unit, qty, product.province, dest) : 0;
    platformFee = Math.round(goodsTotal * TAKE_RATE);
  }

  // Débito atómico do estoque: só desconta se ainda houver quantidade suficiente.
  const debited = await one(
    'UPDATE products SET qty = ROUND((qty - $1)::numeric, 6)::double precision WHERE id=$2 AND qty >= $1 RETURNING id',
    [qty, productId]
  );
  if (!debited) return res.status(409).json({ error: 'Quantidade indisponível.' });

  const order = await one(
    `INSERT INTO orders (code, buyer_id, product_id, qty, unit_price, goods_total, mode, dest_province, distance_km, fee_total,
                         status, segment, retail_kg, platform_fee, dest_zone, origin_lat, origin_lng, dest_lat, dest_lng)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING_PAYMENT',$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
    [genPin(), req.user.id, productId, qty, unitPrice, goodsTotal, mode, dest, distanceKm, fee,
     segment, retailKg, platformFee, zone, originC && originC[0], originC && originC[1], destC && destC[0], destC && destC[1]]
  );
  await addLog(order.id, segment === 'RETALHO' ? 'Pedido de retalho criado — a aguardar pagamento' : 'Pedido B2B criado — a aguardar pagamento');
  await notify(req.user.id, `Pagamento pendente no pedido ${short(order.id)} (${product.name}).`, 'pay', 'orders');
  await notify(product.owner_id, `Nova encomenda de ${req.user.name}: ${product.name} (a aguardar pagamento).`, 'order', 'sales');
  res.json(await loadOrder(order.id, req.user));
});

// ---------- listar os meus pedidos ----------
router.get('/mine', auth, async (req, res) => {
  let rows;
  if (req.user.role === 'BUYER') {
    rows = await q('SELECT id FROM orders WHERE buyer_id=$1 ORDER BY created_at DESC', [req.user.id]);
  } else if (req.user.role === 'SELLER') {
    const farm = await one('SELECT id FROM farms WHERE owner_id=$1', [req.user.id]);
    rows = farm ? await q('SELECT o.id FROM orders o JOIN products p ON p.id=o.product_id WHERE p.farm_id=$1 ORDER BY o.created_at DESC', [farm.id]) : [];
  } else if (req.user.role === 'CARRIER') {
    const carrier = await one('SELECT id, kind FROM carrier_profiles WHERE user_id=$1', [req.user.id]);
    const openMode = carrier && carrier.kind === 'ESTAFETA' ? 'ESTAFETA' : 'AGROLINK';
    rows = carrier
      ? await q(
          `SELECT id FROM orders WHERE carrier_id=$1 OR (mode=$2 AND carrier_id IS NULL AND status='ACCEPTED') ORDER BY created_at DESC`,
          [carrier.id, openMode]
        )
      : [];
  } else if (req.user.role === 'AGENT') {
    const agent = await one('SELECT id FROM agent_profiles WHERE user_id=$1', [req.user.id]);
    rows = agent ? await q('SELECT id FROM orders WHERE point_id=$1 ORDER BY created_at DESC', [agent.id]) : [];
  } else {
    rows = await q('SELECT id FROM orders ORDER BY created_at DESC LIMIT 200');
  }
  const full = await Promise.all(rows.map((r) => loadOrder(r.id, req.user)));
  res.json(full);
});

router.get('/:id', auth, async (req, res) => {
  const r = await fullOrder(req.params.id, req.user);
  if (!r) return res.status(404).json({ error: 'Pedido não encontrado.' });
  const role = await roleOnOrder(req.user, r.raw);
  // Transportadores/estafetas podem ver um transporte ainda por atribuir (para o aceitarem).
  const openJob = req.user.role === 'CARRIER' && !r.raw.carrier_id && r.raw.status === 'ACCEPTED';
  if (!role && !openJob) return res.status(403).json({ error: 'Sem acesso a este pedido.' });
  res.json(r.shaped);
});

// ---------- pagar (simulado — Multicaixa Express/IBAN exigem contrato com banco angolano) ----------
router.post('/:id/pay', auth, requireRole('BUYER'), async (req, res) => {
  const order = await one('SELECT * FROM orders WHERE id=$1 AND buyer_id=$2', [req.params.id, req.user.id]);
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (order.status !== 'PENDING_PAYMENT') return res.status(409).json({ error: 'Este pedido já não está à espera de pagamento.' });
  const payMethod = req.body.payMethod || 'Multicaixa Express';
  await q(`UPDATE orders SET status='PAID', pay_method=$1 WHERE id=$2`, [payMethod, order.id]);
  await addLog(order.id, `Pagamento confirmado · valor em custódia (escrow) EPYALINK (${payMethod})`);
  const product = await one('SELECT p.name, f.owner_id FROM products p JOIN farms f ON f.id=p.farm_id WHERE p.id=$1', [order.product_id]);
  await notify(req.user.id, `Pagamento confirmado no pedido ${short(order.id)}. Valor em custódia.`, 'pay', 'orders');
  await notify(product.owner_id, `Pagamento confirmado no pedido ${short(order.id)}. Aceita para avançar.`, 'pay', 'sales');
  res.json(await loadOrder(order.id, req.user));
});

router.post('/:id/cancel', auth, requireRole('BUYER'), async (req, res) => {
  const order = await one('SELECT * FROM orders WHERE id=$1 AND buyer_id=$2', [req.params.id, req.user.id]);
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (order.status !== 'PENDING_PAYMENT') return res.status(409).json({ error: 'Só é possível cancelar antes do pagamento.' });
  await q(`UPDATE orders SET status='CANCELLED' WHERE id=$1`, [order.id]);
  await q('UPDATE products SET qty = ROUND((qty + $1)::numeric, 6)::double precision WHERE id=$2', [order.qty, order.product_id]);
  await addLog(order.id, 'Pedido cancelado pelo comprador');
  res.json(await loadOrder(order.id, req.user));
});

// ---------- vendedor aceita (opcionalmente indicando o Ponto EPYALINK de recolha) ----------
router.post('/:id/accept', auth, requireRole('SELLER'), async (req, res) => {
  const farm = await one('SELECT id, province FROM farms WHERE owner_id=$1', [req.user.id]);
  const order = await one('SELECT o.* FROM orders o JOIN products p ON p.id=o.product_id WHERE o.id=$1 AND p.farm_id=$2', [req.params.id, farm?.id]);
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (order.status !== 'PAID') return res.status(409).json({ error: 'O pedido ainda não está pago.' });

  let point = null;
  if (req.body.pointId) {
    if (order.segment !== 'B2B') return res.status(400).json({ error: 'O Ponto EPYALINK aplica-se apenas a pedidos B2B.' });
    point = await one('SELECT * FROM agent_profiles WHERE id=$1 AND province=$2', [req.body.pointId, farm.province]);
    if (!point) return res.status(400).json({ error: 'Escolhe um Ponto EPYALINK da tua província.' });
  }
  await q(`UPDATE orders SET status='ACCEPTED', point_id=$1 WHERE id=$2`, [point ? point.id : null, order.id]);
  await addLog(order.id, 'Pedido aceite pelo vendedor' + (point ? ` · recolha no Ponto EPYALINK ${point.point_name}` : ''));
  await notify(order.buyer_id, `O vendedor aceitou o pedido ${short(order.id)}.`, 'ok', 'orders');
  if (point) await notify(point.user_id, `Nova recolha para validar no teu Ponto (pedido ${short(order.id)}).`, 'order', 'agentdash');

  const pdt = await one('SELECT name, unit FROM products WHERE id=$1', [order.product_id]);
  if (order.mode === 'AGROLINK' || order.mode === 'ESTAFETA') {
    const kind = order.mode === 'ESTAFETA' ? 'ESTAFETA' : 'INTERPROVINCIAL';
    const carriers = await q('SELECT user_id FROM carrier_profiles WHERE kind=$1', [kind]);
    for (const c of carriers) {
      await notify(c.user_id, `Novo transporte disponível: ${pdt.name} (${order.segment === 'RETALHO' ? order.retail_kg + ' kg' : order.qty + ' ' + pdt.unit}).`, 'truck', 'jobs');
    }
  }
  if (order.mode === 'RECOLHA') {
    // Recolha no local: o PIN segue já para o comprador, que o dará presencialmente.
    await sendPinSms(order);
  }
  res.json(await loadOrder(order.id, req.user));
});

// ---------- transportador/estafeta aceita ----------
router.post('/:id/carrier-accept', auth, requireRole('CARRIER'), async (req, res) => {
  const carrier = await one('SELECT * FROM carrier_profiles WHERE user_id=$1', [req.user.id]);
  if (!carrier) return res.status(404).json({ error: 'Perfil de transportadora não encontrado.' });
  const order = await one(`SELECT o.*, p.unit FROM orders o JOIN products p ON p.id=o.product_id WHERE o.id=$1 AND o.mode IN ('AGROLINK','ESTAFETA') AND o.status='ACCEPTED' AND o.carrier_id IS NULL`, [req.params.id]);
  if (!order) return res.status(409).json({ error: 'Este transporte já não está disponível.' });
  const needKind = order.mode === 'ESTAFETA' ? 'ESTAFETA' : 'INTERPROVINCIAL';
  if (carrier.kind !== needKind) {
    return res.status(403).json({ error: order.mode === 'ESTAFETA' ? 'Este é um transporte urbano: só estafetas o podem aceitar.' : 'Este é um transporte interprovincial: só transportadoras interprovinciais o podem aceitar.' });
  }
  const weightKg = order.segment === 'RETALHO' ? Number(order.retail_kg) : Number(order.qty) * (KG[order.unit] || 1);
  const { driverId, vehicleId } = req.body;
  const driver = await one(`UPDATE drivers SET status='viagem' WHERE id=$1 AND carrier_id=$2 AND status='disponivel' RETURNING *`, [driverId, carrier.id]);
  const vehicle = await one(`UPDATE vehicles SET status='viagem' WHERE id=$1 AND carrier_id=$2 AND status='disponivel' AND capacity_tons*1000 >= $3 RETURNING *`, [vehicleId, carrier.id, weightKg]);
  if (!driver || !vehicle) {
    if (driver) await q(`UPDATE drivers SET status='disponivel' WHERE id=$1`, [driver.id]);
    if (vehicle) await q(`UPDATE vehicles SET status='disponivel' WHERE id=$1`, [vehicle.id]);
    return res.status(400).json({ error: 'Escolhe um motorista e um veículo disponíveis, com capacidade para a carga.' });
  }
  const claimed = await one(
    `UPDATE orders SET status='CARRIER_OK', carrier_id=$1, driver_name=$2, vehicle_plate=$3
     WHERE id=$4 AND mode IN ('AGROLINK','ESTAFETA') AND status='ACCEPTED' AND carrier_id IS NULL RETURNING id`,
    [carrier.id, driver.name, vehicle.plate, order.id]
  );
  if (!claimed) {
    await q(`UPDATE drivers SET status='disponivel' WHERE id=$1`, [driver.id]);
    await q(`UPDATE vehicles SET status='disponivel' WHERE id=$1`, [vehicle.id]);
    return res.status(409).json({ error: 'Este transporte já foi aceite por outro transportador.' });
  }
  await addLog(order.id, `Transportador atribuído: ${driver.name} · ${vehicle.plate}`);
  await notify(order.buyer_id, `Um transportador aceitou o pedido ${short(order.id)}: ${driver.name}.`, 'truck', 'orders');
  const product = await one('SELECT p.name, f.owner_id FROM products p JOIN farms f ON f.id=p.farm_id WHERE p.id=$1', [order.product_id]);
  await notify(product.owner_id, `Transportador atribuído ao pedido ${short(order.id)}.`, 'truck', 'sales');
  res.json(await loadOrder(order.id, req.user));
});

/** Carrega o pedido e confirma que o utilizador é quem executa a entrega (vendedor no modo VENDEDOR/RECOLHA, ou o transportador atribuído). */
async function loadForCourier(req, res) {
  const r = await fullOrder(req.params.id, req.user);
  if (!r) { res.status(404).json({ error: 'Pedido não encontrado.' }); return null; }
  const o = r.raw;
  const isCarrierJob = o.mode === 'AGROLINK' || o.mode === 'ESTAFETA';
  const allowed = isCarrierJob
    ? req.user.role === 'CARRIER' && o.carrier_user_id === req.user.id
    : req.user.role === 'SELLER' && o.farm_owner_id === req.user.id;
  if (!allowed) { res.status(403).json({ error: 'Só quem faz a entrega pode executar esta ação.' }); return null; }
  return o;
}

// ---------- iniciar transporte/entrega ----------
router.post('/:id/start', auth, requireRole('SELLER', 'CARRIER'), async (req, res) => {
  const order = await loadForCourier(req, res);
  if (!order) return;
  const need = order.mode === 'VENDEDOR' ? 'ACCEPTED' : 'CARRIER_OK';
  if (order.status !== need) return res.status(409).json({ error: 'Este pedido não pode ser iniciado agora.' });
  await q(`UPDATE orders SET status='IN_TRANSIT' WHERE id=$1`, [order.id]);
  await addLog(order.id, 'Transporte iniciado · rastreamento GPS disponível');
  await notify(order.buyer_id, `Transporte iniciado no pedido ${short(order.id)}. Já podes acompanhar no mapa.`, 'truck', 'orders');
  res.json(await loadOrder(order.id, req.user));
});

/** Fase final do percurso: marca "perto do destino" e envia o PIN por SMS ao comprador. */
async function markNear(order, viaGps) {
  const done = await one(`UPDATE orders SET near=TRUE WHERE id=$1 AND near=FALSE AND status='IN_TRANSIT' RETURNING *`, [order.id]);
  if (!done) return false;
  await addLog(order.id, viaGps ? 'Chegada à fase final do percurso (detetada por GPS) · PIN enviado ao comprador' : 'Transporte próximo do destino · PIN enviado ao comprador');
  await notify(order.buyer_id, `Transporte próximo do destino no pedido ${short(order.id)}. Enviámos-te o PIN de entrega${sms.hasKamba() ? ' por SMS' : ''}.`, 'pin', 'orders');
  await sendPinSms(done);
  return true;
}

router.post('/:id/near', auth, requireRole('SELLER', 'CARRIER'), async (req, res) => {
  const order = await loadForCourier(req, res);
  if (!order) return;
  if (order.status !== 'IN_TRANSIT') return res.status(409).json({ error: 'O pedido não está em trânsito.' });
  await markNear(order, false);
  res.json(await loadOrder(order.id, req.user));
});

// ---------- entrega validada por PIN (SMS) — liberta a custódia ----------
router.post('/:id/deliver', auth, requireRole('SELLER', 'CARRIER'), async (req, res) => {
  const order = await loadForCourier(req, res);
  if (!order) return;
  if (!['ACCEPTED', 'IN_TRANSIT'].includes(order.status) || (order.mode !== 'RECOLHA' && order.status !== 'IN_TRANSIT')) {
    return res.status(409).json({ error: 'Este pedido não pode ser entregue agora.' });
  }
  if (order.pin_attempts >= PIN_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'PIN bloqueado por demasiadas tentativas. O comprador tem de pedir um novo PIN por SMS.' });
  }
  const pin = String(req.body.pin || req.body.code || '').replace(/\D/g, '');
  if (pin !== order.code) {
    const upd = await one('UPDATE orders SET pin_attempts = pin_attempts + 1 WHERE id=$1 RETURNING pin_attempts', [order.id]);
    const left = Math.max(0, PIN_MAX_ATTEMPTS - upd.pin_attempts);
    return res.status(400).json({ error: left > 0 ? `PIN incorreto. Pede ao comprador o PIN recebido por SMS. Restam ${left} tentativa(s).` : 'PIN bloqueado por demasiadas tentativas. O comprador tem de pedir um novo PIN por SMS.' });
  }
  const who = order.mode === 'VENDEDOR' || order.mode === 'RECOLHA' ? 'Vendedor' : `${order.driver_name} · ${order.vehicle_plate}`;
  const dest = order.dest_zone ? `${order.dest_zone}, ${order.dest_province}` : order.dest_province;
  await q(
    `UPDATE orders SET status='CONFIRMED', confirmed_at=now(), evidence_photo=$1, evidence_place=$2, evidence_who=$3, evidence_at=now() WHERE id=$4`,
    [req.body.photoUrl || null, `${dest} (localização aproximada)`, who, order.id]
  );
  if (order.carrier_id) {
    await q(`UPDATE drivers SET status='disponivel' WHERE carrier_id=$1 AND name=$2`, [order.carrier_id, order.driver_name]);
    await q(`UPDATE vehicles SET status='disponivel' WHERE carrier_id=$1 AND plate=$2`, [order.carrier_id, order.vehicle_plate]);
  }
  await q(`INSERT INTO order_checkpoints (order_id, kind, name, lat, lng, by_user_id) VALUES ($1,'ARRIVAL',$2,$3,$4,$5)`,
    [order.id, `Entrega no destino (${dest})`, order.dest_lat, order.dest_lng, req.user.id]);
  await addLog(order.id, 'Entrega validada com o PIN do comprador · custódia libertada');
  await releaseFunds(order.id);
  await notify(order.buyer_id, `Entrega concluída no pedido ${short(order.id)}. Avalia a operação.`, 'star', 'orders');
  res.json(await loadOrder(order.id, req.user));
});

// ---------- o comprador pede novo envio do PIN por SMS ----------
router.post('/:id/resend-pin', auth, requireRole('BUYER'), async (req, res) => {
  const order = await one(`SELECT * FROM orders WHERE id=$1 AND buyer_id=$2`, [req.params.id, req.user.id]);
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (!['ACCEPTED', 'CARRIER_OK', 'IN_TRANSIT'].includes(order.status)) return res.status(409).json({ error: 'O PIN só pode ser reenviado enquanto a entrega está pendente.' });
  if (order.pin_sent_at && Date.now() - new Date(order.pin_sent_at).getTime() < 60000) {
    return res.status(429).json({ error: 'Aguarda um minuto antes de pedir novo PIN.' });
  }
  let cur = order;
  if (order.pin_attempts >= PIN_MAX_ATTEMPTS) {
    cur = await one('UPDATE orders SET code=$1, pin_attempts=0 WHERE id=$2 RETURNING *', [genPin(), order.id]);
    await addLog(order.id, 'PIN renovado a pedido do comprador (o anterior foi bloqueado)');
  }
  const r = await sendPinSms(cur);
  res.json({ sent: r.via !== 'failed', via: r.via === 'kambasms' ? 'SMS' : 'APP' });
});

// ---------- Ponto EPYALINK valida a recolha ----------
router.post('/:id/validate-pickup', auth, requireRole('AGENT'), async (req, res) => {
  const agent = await one('SELECT * FROM agent_profiles WHERE user_id=$1', [req.user.id]);
  const order = agent && await one(`SELECT * FROM orders WHERE id=$1 AND point_id=$2`, [req.params.id, agent.id]);
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado neste Ponto.' });
  if (!['ACCEPTED', 'CARRIER_OK', 'IN_TRANSIT'].includes(order.status)) return res.status(409).json({ error: 'Este pedido não está em fase de recolha.' });
  if (order.pickup_validated_at) return res.status(409).json({ error: 'A recolha já foi validada.' });
  await q('UPDATE orders SET pickup_validated_at=now() WHERE id=$1', [order.id]);
  await q(`INSERT INTO order_checkpoints (order_id, kind, name, by_user_id) VALUES ($1,'PICKUP',$2,$3)`, [order.id, `Recolha validada no Ponto ${agent.point_name}`, req.user.id]);
  await addLog(order.id, `Recolha validada no Ponto EPYALINK ${agent.point_name}`);
  const product = await one('SELECT f.owner_id FROM products p JOIN farms f ON f.id=p.farm_id WHERE p.id=$1', [order.product_id]);
  await notify(order.buyer_id, `A tua carga foi recolhida no Ponto ${agent.point_name} (pedido ${short(order.id)}).`, 'ok', 'orders');
  await notify(product.owner_id, `Recolha validada no Ponto ${agent.point_name} (pedido ${short(order.id)}).`, 'ok', 'sales');
  res.json({ ok: true });
});

// ---------- pontos de passagem: Hubs intermédios ----------
router.post('/:id/checkpoint', auth, requireRole('SELLER', 'CARRIER'), async (req, res) => {
  const order = await loadForCourier(req, res);
  if (!order) return;
  if (!['CARRIER_OK', 'IN_TRANSIT'].includes(order.status) && !(order.mode === 'VENDEDOR' && order.status === 'ACCEPTED')) {
    return res.status(409).json({ error: 'O pedido não está em fase de transporte.' });
  }
  const hub = await one('SELECT * FROM hubs WHERE id=$1 AND active', [req.body.hubId]);
  if (!hub) return res.status(400).json({ error: 'Escolhe um Hub.' });
  const name = hub.kind === 'REGIONAL' ? `Passagem no ${hub.name}` : `Passagem no ${hub.name}`;
  await q(`INSERT INTO order_checkpoints (order_id, kind, hub_id, name, lat, lng, by_user_id) VALUES ($1,'HUB',$2,$3,$4,$5,$6)`,
    [order.id, hub.id, name, hub.lat, hub.lng, req.user.id]);
  await addLog(order.id, name);
  await notify(order.buyer_id, `A tua carga passou no ${hub.name} (pedido ${short(order.id)}).`, 'truck', 'orders');
  res.json({ ok: true });
});

// ---------- rastreamento GPS ----------
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

router.post('/:id/location', auth, requireRole('SELLER', 'CARRIER'), async (req, res) => {
  const order = await loadForCourier(req, res);
  if (!order) return;
  if (!['CARRIER_OK', 'IN_TRANSIT'].includes(order.status) && !(order.mode === 'VENDEDOR' && order.status === 'ACCEPTED')) {
    return res.status(409).json({ error: 'O rastreio só está ativo durante o transporte.' });
  }
  const pts = Array.isArray(req.body.points) ? req.body.points.slice(0, 100) : [];
  const now = Date.now();
  let saved = 0, last = null;
  for (const p of pts) {
    const lat = num(p.lat), lng = num(p.lng);
    if (lat == null || lng == null || lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    let at = p.at ? new Date(p.at).getTime() : now;
    if (!Number.isFinite(at) || at > now + 60000 || at < now - 24 * 3600e3) at = Math.min(now, Math.max(at || now, now - 24 * 3600e3));
    await q('INSERT INTO tracking_points (order_id, user_id, lat, lng, accuracy, recorded_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [order.id, req.user.id, lat, lng, num(p.acc), new Date(at)]);
    saved++;
    if (!last || at >= last.at) last = { lat, lng, at };
  }
  // Deteção automática da fase final: perto do destino => "próximo do destino" + PIN por SMS.
  let near = order.near;
  if (last && order.status === 'IN_TRANSIT' && !order.near && order.dest_lat != null) {
    const d = haversineKm(last.lat, last.lng, order.dest_lat, order.dest_lng);
    const threshold = order.segment === 'RETALHO' ? 2 : 20;
    if (d <= threshold) near = await markNear(order, true) || near;
  }
  res.json({ saved, near });
});

router.get('/:id/tracking', auth, async (req, res) => {
  const r = await fullOrder(req.params.id, req.user);
  if (!r) return res.status(404).json({ error: 'Pedido não encontrado.' });
  const o = r.raw;
  if (!(await roleOnOrder(req.user, o))) return res.status(403).json({ error: 'Sem acesso a este pedido.' });
  const rows = await q('SELECT lat, lng, accuracy, recorded_at FROM tracking_points WHERE order_id=$1 ORDER BY recorded_at DESC LIMIT 1000', [o.id]);
  rows.reverse();
  const step = Math.max(1, Math.ceil(rows.length / 300));
  const points = rows.filter((_, i) => i % step === 0 || i === rows.length - 1).map((p) => ({ lat: p.lat, lng: p.lng, at: p.recorded_at }));
  const lastRow = rows[rows.length - 1] || null;
  const checkpoints = await q('SELECT kind, name, lat, lng, created_at FROM order_checkpoints WHERE order_id=$1 ORDER BY created_at ASC', [o.id]);
  const destName = o.dest_zone ? `${o.dest_zone}, ${o.dest_province}` : o.dest_province;
  res.json({
    status: o.status,
    origin: o.origin_lat != null ? { lat: o.origin_lat, lng: o.origin_lng, name: o.segment === 'RETALHO' ? `Micro-Hub urbano ${o.dest_province}` : `${o.farm_municipality}, ${o.farm_province}` } : null,
    dest: o.dest_lat != null ? { lat: o.dest_lat, lng: o.dest_lng, name: destName } : null,
    points,
    last: lastRow ? { lat: lastRow.lat, lng: lastRow.lng, at: lastRow.recorded_at } : null,
    remainingKm: lastRow && o.dest_lat != null ? Math.round(haversineKm(lastRow.lat, lastRow.lng, o.dest_lat, o.dest_lng) * 10) / 10 : null,
    checkpoints: checkpoints.map((c) => ({ kind: c.kind, name: c.name, lat: c.lat, lng: c.lng, at: c.created_at })),
    live: ['CARRIER_OK', 'IN_TRANSIT'].includes(o.status)
  });
});

// ---------- (legado) confirmar receção de pedidos já entregues ----------
router.post('/:id/confirm', auth, requireRole('BUYER'), async (req, res) => {
  const order = await one(`SELECT * FROM orders WHERE id=$1 AND buyer_id=$2 AND status='DELIVERED'`, [req.params.id, req.user.id]);
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado ou ainda não entregue.' });
  await q(`UPDATE orders SET status='CONFIRMED', confirmed_at=now() WHERE id=$1`, [order.id]);
  await addLog(order.id, 'Recebimento confirmado · custódia libertada');
  await releaseFunds(order.id);
  res.json(await loadOrder(order.id, req.user));
});

// ---------- avaliações ----------
router.post('/:id/rate', auth, requireRole('BUYER'), async (req, res) => {
  const order = await one(`SELECT * FROM orders WHERE id=$1 AND buyer_id=$2 AND status='CONFIRMED'`, [req.params.id, req.user.id]);
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado ou ainda não concluído.' });
  const { sellerStars, sellerText, carrierStars, carrierText } = req.body;
  if (!(sellerStars >= 1 && sellerStars <= 5)) return res.status(400).json({ error: 'Escolhe uma nota para o vendedor.' });
  const product = await one('SELECT f.id AS farm_id FROM products p JOIN farms f ON f.id=p.farm_id WHERE p.id=$1', [order.product_id]);
  await q('UPDATE farms SET rating_sum = rating_sum + $1, rating_count = rating_count + 1 WHERE id=$2', [sellerStars, product.farm_id]);
  await q(
    `INSERT INTO reviews (target_type, target_id, from_user_id, from_name, stars, text, order_id) VALUES ('FARM',$1,$2,$3,$4,$5,$6)`,
    [product.farm_id, req.user.id, req.user.name, sellerStars, sellerText || '', order.id]
  );
  if (order.carrier_id && carrierStars >= 1 && carrierStars <= 5) {
    await q('UPDATE carrier_profiles SET rating_sum = rating_sum + $1, rating_count = rating_count + 1 WHERE id=$2', [carrierStars, order.carrier_id]);
    await q(
      `INSERT INTO reviews (target_type, target_id, from_user_id, from_name, stars, text, order_id) VALUES ('CARRIER',$1,$2,$3,$4,$5,$6)`,
      [order.carrier_id, req.user.id, req.user.name, carrierStars, carrierText || '', order.id]
    );
  }
  await q(`UPDATE orders SET status='RATED' WHERE id=$1`, [order.id]);
  await addLog(order.id, 'Avaliação submetida');
  res.json(await loadOrder(order.id, req.user));
});

router.post('/:id/rate-buyer', auth, requireRole('SELLER'), async (req, res) => {
  const farm = await one('SELECT id FROM farms WHERE owner_id=$1', [req.user.id]);
  const order = await one(
    `SELECT o.* FROM orders o JOIN products p ON p.id=o.product_id WHERE o.id=$1 AND p.farm_id=$2 AND o.status IN ('CONFIRMED','RATED') AND o.rated_buyer=FALSE`,
    [req.params.id, farm?.id]
  );
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado ou já avaliado.' });
  const { stars, text } = req.body;
  if (!(stars >= 1 && stars <= 5)) return res.status(400).json({ error: 'Escolhe uma nota.' });
  await q('UPDATE users SET buyer_rating_sum = buyer_rating_sum + $1, buyer_rating_cnt = buyer_rating_cnt + 1 WHERE id=$2', [stars, order.buyer_id]);
  await q(
    `INSERT INTO reviews (target_type, target_id, from_user_id, from_name, stars, text, order_id) VALUES ('USER',$1,$2,$3,$4,$5,$6)`,
    [order.buyer_id, req.user.id, req.user.name, stars, text || '', order.id]
  );
  await q(`UPDATE orders SET rated_buyer=TRUE WHERE id=$1`, [order.id]);
  res.json(await loadOrder(order.id, req.user));
});

// ---------- disputa ----------
router.post('/:id/dispute', auth, requireRole('BUYER'), async (req, res) => {
  const order = await one('SELECT * FROM orders WHERE id=$1 AND buyer_id=$2', [req.params.id, req.user.id]);
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });
  const openStates = ['PAID', 'ACCEPTED', 'CARRIER_OK', 'IN_TRANSIT', 'DELIVERED', 'CONFIRMED', 'RATED'];
  if (!openStates.includes(order.status)) return res.status(409).json({ error: 'Não é possível abrir disputa neste estado.' });
  const { type, text, photoUrl } = req.body;
  if (!type || !text || text.trim().length < 10) return res.status(400).json({ error: 'Descreve o problema com pelo menos 10 caracteres.' });
  await q(`INSERT INTO disputes (order_id, type, text, photo_url) VALUES ($1,$2,$3,$4)`, [order.id, type, text.trim(), photoUrl || null]);
  await q(`UPDATE orders SET prev_status=status, status='DISPUTED' WHERE id=$1`, [order.id]);
  await addLog(order.id, `Disputa aberta: ${type}`);
  const product = await one('SELECT f.owner_id FROM products p JOIN farms f ON f.id=p.farm_id WHERE p.id=$1', [order.product_id]);
  const admins = await q(`SELECT id FROM users WHERE role='ADMIN'`);
  for (const a of admins) await notify(a.id, `Disputa aberta no pedido ${short(order.id)}: ${type.toLowerCase()}.`, 'warn', 'disp');
  await notify(product.owner_id, `Disputa aberta no pedido ${short(order.id)}.${order.released_at ? '' : ' O pagamento fica retido.'}`, 'warn', 'sales');
  res.json(await loadOrder(order.id, req.user));
});

module.exports = router;

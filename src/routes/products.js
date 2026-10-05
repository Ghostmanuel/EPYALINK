const express = require('express');
const { q, one } = require('../db');
const { auth, requireRole } = require('../middleware/auth');
const { RETAIL_UNITS } = require('../lib/business');

const router = express.Router();

function shapeProduct(p) {
  return {
    id: p.id,
    farmId: p.farm_id,
    name: p.name,
    category: p.category,
    unit: p.unit,
    price: p.price,
    qty: Number(p.qty),
    qty0: Number(p.qty0),
    minOrder: Number(p.min_order || 0),
    retailEnabled: !!p.retail_enabled,
    retailPriceKg: p.retail_price_kg,
    photoUrl: p.photo_url,
    createdAt: p.created_at,
    farm: p.farm_name
      ? {
          id: p.farm_id,
          name: p.farm_name,
          type: p.farm_type,
          province: p.province,
          municipality: p.municipality,
          verified: p.verified,
          rating: p.rating_count ? p.rating_sum / p.rating_count : 0,
          ratingCount: p.rating_count,
          ownerName: p.owner_name
        }
      : undefined
  };
}

// GET /products?q=&cat=&prov=&mun=&unit=&type=&avail=&min=&max=
router.get('/', async (req, res) => {
  const retail = req.query.retail === '1';
  const { qtext, cat, prov, mun, unit, type, avail, min, max } = {
    qtext: req.query.q, cat: req.query.cat, prov: req.query.prov, mun: req.query.mun,
    unit: req.query.unit, type: req.query.type, avail: req.query.avail, min: req.query.min, max: req.query.max
  };
  const params = [];
  const where = [];
  if (qtext) { params.push(`%${qtext.toLowerCase()}%`); where.push(`(lower(p.name) LIKE $${params.length} OR lower(f.name) LIKE $${params.length} OR lower(f.province) LIKE $${params.length} OR lower(f.municipality) LIKE $${params.length} OR lower(u.name) LIKE $${params.length})`); }
  if (cat) { params.push(cat); where.push(`p.category = $${params.length}`); }
  if (prov) { params.push(prov); where.push(`f.province = $${params.length}`); }
  if (mun) { params.push(mun); where.push(`f.municipality = $${params.length}`); }
  if (unit) { params.push(unit); where.push(`p.unit = $${params.length}`); }
  if (type) { params.push(type); where.push(`f.type = $${params.length}`); }
  if (retail) where.push(`p.retail_enabled = TRUE`);
  if (avail === 'disponivel') where.push(`p.qty > 0`);
  if (avail === 'esgotado') where.push(`p.qty <= 0`);
  if (min) { params.push(Number(min)); where.push(`p.price >= $${params.length}`); }
  if (max) { params.push(Number(max)); where.push(`p.price <= $${params.length}`); }

  const sql = `
    SELECT p.*, f.name AS farm_name, f.type AS farm_type, f.province, f.municipality, f.verified,
           f.rating_sum, f.rating_count, u.name AS owner_name
    FROM products p
    JOIN farms f ON f.id = p.farm_id
    JOIN users u ON u.id = f.owner_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY (p.qty > 0) DESC, f.rating_count DESC, p.created_at DESC
  `;
  const rows = await q(sql, params);
  if (cat) {
    q('INSERT INTO search_events (category, province) VALUES ($1,$2)', [cat, prov || null]).catch(() => {});
  }
  res.json(rows.map(shapeProduct));
});

router.get('/:id', async (req, res) => {
  const row = await one(
    `SELECT p.*, f.name AS farm_name, f.type AS farm_type, f.province, f.municipality, f.verified,
            f.rating_sum, f.rating_count, u.name AS owner_name
     FROM products p JOIN farms f ON f.id=p.farm_id JOIN users u ON u.id=f.owner_id WHERE p.id=$1`,
    [req.params.id]
  );
  if (!row) return res.status(404).json({ error: 'Produto não encontrado.' });
  res.json(shapeProduct(row));
});

router.get('/mine/list', auth, requireRole('SELLER'), async (req, res) => {
  const farm = await one('SELECT id FROM farms WHERE owner_id=$1', [req.user.id]);
  if (!farm) return res.json([]);
  const rows = await q('SELECT * FROM products WHERE farm_id=$1 ORDER BY created_at DESC', [farm.id]);
  res.json(rows.map(shapeProduct));
});

router.post('/', auth, requireRole('SELLER'), async (req, res) => {
  const { name, category, unit, price, qty, photoUrl } = req.body;
  if (!name || !category || !unit || !(price > 0) || !(qty > 0)) {
    return res.status(400).json({ error: 'Indica nome, categoria, unidade, preço e quantidade válidos.' });
  }
  const minOrder = Number(req.body.minOrder) > 0 ? Number(req.body.minOrder) : 0;
  const retailEnabled = !!req.body.retailEnabled;
  const retailPriceKg = retailEnabled ? Math.round(Number(req.body.retailPriceKg)) : null;
  if (retailEnabled && (!RETAIL_UNITS.includes(unit) || !(retailPriceKg > 0))) {
    return res.status(400).json({ error: 'Para vender a retalho, a unidade tem de ser kg, sacos ou toneladas e o preço por kg tem de ser válido.' });
  }
  const farm = await one('SELECT id FROM farms WHERE owner_id=$1', [req.user.id]);
  if (!farm) return res.status(404).json({ error: 'Cria primeiro o perfil da tua fazenda.' });
  const row = await one(
    `INSERT INTO products (farm_id, name, category, unit, price, qty, qty0, photo_url, min_order, retail_enabled, retail_price_kg)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10) RETURNING *`,
    [farm.id, name, category, unit, Math.round(price), qty, photoUrl || null, minOrder, retailEnabled, retailPriceKg]
  );
  res.json(shapeProduct(row));
});

router.put('/:id', auth, requireRole('SELLER'), async (req, res) => {
  const farm = await one('SELECT id FROM farms WHERE owner_id=$1', [req.user.id]);
  const prod = await one('SELECT * FROM products WHERE id=$1', [req.params.id]);
  if (!prod || !farm || prod.farm_id !== farm.id) return res.status(404).json({ error: 'Produto não encontrado.' });
  const { qty, price, photoUrl } = req.body;
  const minOrder = req.body.minOrder != null ? Math.max(0, Number(req.body.minOrder) || 0) : null;
  let retailEnabled = req.body.retailEnabled != null ? !!req.body.retailEnabled : null;
  let retailPriceKg = req.body.retailPriceKg != null ? Math.round(Number(req.body.retailPriceKg)) : null;
  const willRetail = retailEnabled != null ? retailEnabled : prod.retail_enabled;
  const priceKg = retailPriceKg != null ? retailPriceKg : prod.retail_price_kg;
  if (willRetail && (!RETAIL_UNITS.includes(prod.unit) || !(priceKg > 0))) {
    return res.status(400).json({ error: 'Para vender a retalho, a unidade tem de ser kg, sacos ou toneladas e o preço por kg tem de ser válido.' });
  }
  const newQty0 = qty != null ? Math.max(Number(prod.qty0), Number(qty)) : prod.qty0;
  const row = await one(
    `UPDATE products SET qty=COALESCE($1,qty), qty0=$2, price=COALESCE($3,price), photo_url=COALESCE($4,photo_url),
            min_order=COALESCE($5,min_order), retail_enabled=COALESCE($6,retail_enabled), retail_price_kg=COALESCE($7,retail_price_kg)
     WHERE id=$8 RETURNING *`,
    [qty, newQty0, price != null ? Math.round(price) : null, photoUrl, minOrder, retailEnabled, retailPriceKg, prod.id]
  );
  res.json(shapeProduct(row));
});

module.exports = router;

// Regras de negócio do EPYALINK: geografia, taxas, comissões e PIN de entrega.
const crypto = require('crypto');

const PROV = {
  Luanda: [-8.84, 13.23],
  Huambo: [-12.78, 15.74],
  Malanje: [-9.54, 16.34],
  'Bié': [-12.38, 16.93],
  'Cuanza Sul': [-11.2, 13.84],
  Benguela: [-12.58, 13.41]
};
const KG = { kg: 1, toneladas: 1000, sacos: 60, unidades: 1.5 };

// ---- Modelo financeiro (ver documento estratégico, secção 4) ----
const TAKE_RATE = 0.03;        // Take rate B2B: cobrado ao comprador, por cima do valor da mercadoria
const CUSTODY_RATE = 0.015;    // Taxa de custódia & PIN SMS (1%–2%): descontada ao vendedor
const AGENT_RATE = 0.04;       // Comissão do Ponto EPYALINK rural (3%–5%): paga pela plataforma
const COMM_CARRIER = 0.08;     // Comissão sobre o transporte interprovincial
const COMM_ESTAFETA = 0.10;    // Comissão sobre a entrega urbana (estafeta)
const FRAC_RATE = 0.10;        // Margem do fracionamento (retalho), descontada ao vendedor
const WITHDRAW_FEE_RATE = 0.015; // Taxa de intermediação/carteira móvel (1%–2%) no levantamento
const MIN_WITHDRAW = 5000;
const PIN_MAX_ATTEMPTS = 5;

// Retalho urbano: zonas de cada cidade (deslocamento em graus relativo ao centro da província).
const ZONE_OFFSETS = {
  Centro: [0, 0],
  Norte: [0.04, 0],
  Sul: [-0.04, 0],
  Este: [0, 0.05],
  Oeste: [0, -0.05]
};
const RETAIL_MAX_KG = 50;
const RETAIL_UNITS = ['kg', 'sacos', 'toneladas'];

function haversineKm(la1, lo1, la2, lo2) {
  const r = (x) => (x * Math.PI) / 180;
  const h = Math.sin(r(la2 - la1) / 2) ** 2 + Math.cos(r(la1)) * Math.cos(r(la2)) * Math.sin(r(lo2 - lo1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function km(a, b) {
  if (a === b) return 30;
  const A = PROV[a], B = PROV[b];
  if (!A || !B) return 50;
  return Math.round((haversineKm(A[0], A[1], B[0], B[1]) * 1.3) / 10) * 10;
}

/** Frete interprovincial calculado pela distância e peso. */
function feeFor(unit, qty, from, to) {
  const w = qty * (KG[unit] || 1);
  return Math.round((4000 + km(from, to) * (25 + Math.min(w, 20000) * 0.02)) / 100) * 100;
}

function zoneCoords(province, zone) {
  const c = PROV[province], off = ZONE_OFFSETS[zone];
  if (!c || !off) return null;
  return [c[0] + off[0], c[1] + off[1]];
}

/** Taxa de entrega urbana, ajustada estritamente à distância percorrida pelo estafeta. */
function retailFee(distanceKm) {
  return Math.round((500 + 150 * distanceKm) / 50) * 50;
}

/** PIN numérico de 6 dígitos gerado com fonte criptográfica. */
function genPin() {
  return String(crypto.randomInt(100000, 1000000));
}

module.exports = {
  PROV, KG, ZONE_OFFSETS, RETAIL_MAX_KG, RETAIL_UNITS,
  TAKE_RATE, CUSTODY_RATE, AGENT_RATE, COMM_CARRIER, COMM_ESTAFETA, FRAC_RATE,
  WITHDRAW_FEE_RATE, MIN_WITHDRAW, PIN_MAX_ATTEMPTS,
  haversineKm, km, feeFor, zoneCoords, retailFee, genPin
};

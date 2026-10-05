const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : (process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false)
});

async function q(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}
async function one(text, params) {
  const rows = await q(text, params);
  return rows[0] || null;
}

module.exports = { pool, q, one };

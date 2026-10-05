require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const hash = await bcrypt.hash('epyalink123', 10);

  async function upsertUser(name, phone, role, extra = {}) {
    const existing = await pool.query('SELECT id FROM users WHERE phone=$1', [phone]);
    if (existing.rows[0]) return existing.rows[0].id;
    const r = await pool.query(
      'INSERT INTO users (name, phone, password_hash, role, company_name, nif) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [name, phone, hash, role, extra.companyName || null, extra.nif || null]
    );
    return r.rows[0].id;
  }

  const joaoId = await upsertUser('João Manuel', '+244923000001', 'SELLER');
  const anaId = await upsertUser('Ana Kiala', '+244923000002', 'BUYER');
  const kiandaId = await upsertUser('Restaurante Kianda', '+244923000006', 'BUYER', { companyName: 'Restaurante Kianda, Lda', nif: '5401234567' });
  const xptoId = await upsertUser('Transportadora XPTO', '+244923000003', 'CARRIER');
  const motoId = await upsertUser('Estafeta Rápido Luanda', '+244923000005', 'CARRIER');
  const kizuaId = await upsertUser('Cantina do Kizua', '+244923000007', 'AGENT');
  const adminId = await upsertUser('Administrador EPYALINK', '+244923000004', 'ADMIN');

  let farm = (await pool.query('SELECT id FROM farms WHERE owner_id=$1', [joaoId])).rows[0];
  if (!farm) {
    farm = (await pool.query(
      `INSERT INTO farms (owner_id, name, type, province, municipality, about, verified, crops)
       VALUES ($1,'Fazenda Boa Esperança','PRODUTOR','Huambo','Caála',
       'Produção familiar no planalto do Huambo. Colheitas semanais de milho, feijão e tomate, vendidas por grosso a compradores interprovinciais e, em pequenas quantidades, a retalho em Luanda.', TRUE, ARRAY['Milho','Feijão','Tomate'])
       RETURNING id`,
      [joaoId]
    )).rows[0];

    await pool.query(
      `INSERT INTO products (farm_id, name, category, unit, price, qty, qty0, min_order, retail_enabled, retail_price_kg) VALUES
       ($1,'Tomate','Tomate','kg',180,1000,1000,100,TRUE,250),
       ($1,'Milho','Milho','kg',320,500,1200,200,TRUE,420),
       ($1,'Feijão','Feijão','kg',950,300,800,50,FALSE,NULL)`,
      [farm.id]
    );
  }

  let carrier = (await pool.query('SELECT id FROM carrier_profiles WHERE user_id=$1', [xptoId])).rows[0];
  if (!carrier) {
    carrier = (await pool.query(
      `INSERT INTO carrier_profiles (user_id, company_name, province, kind, verified) VALUES ($1,'Transportadora XPTO','Huambo','INTERPROVINCIAL',TRUE) RETURNING id`,
      [xptoId]
    )).rows[0];
    await pool.query(
      `INSERT INTO vehicles (carrier_id, plate, type, capacity_tons) VALUES
       ($1,'HU-21-44-AB','Camião',10), ($1,'HU-33-90-EF','Carrinha',1.5), ($1,'HU-12-56-GH','Camião',15)`,
      [carrier.id]
    );
    await pool.query(
      `INSERT INTO drivers (carrier_id, name) VALUES ($1,'Carlos Mendes'), ($1,'António Lopes'), ($1,'Joaquim Cassoma')`,
      [carrier.id]
    );
    await pool.query(
      `INSERT INTO carrier_documents (carrier_id, name, expires_at) VALUES
       ($1,'Alvará de transporte de mercadorias', now() + interval '200 days'),
       ($1,'Seguro da frota', now() + interval '20 days')`,
      [carrier.id]
    );
  }

  let moto = (await pool.query('SELECT id FROM carrier_profiles WHERE user_id=$1', [motoId])).rows[0];
  if (!moto) {
    moto = (await pool.query(
      `INSERT INTO carrier_profiles (user_id, company_name, province, kind, verified) VALUES ($1,'Estafeta Rápido Luanda','Luanda','ESTAFETA',TRUE) RETURNING id`,
      [motoId]
    )).rows[0];
    await pool.query(`INSERT INTO vehicles (carrier_id, plate, type, capacity_tons) VALUES ($1,'LD-77-30-KZ','Motocicleta',0.1)`, [moto.id]);
    await pool.query(`INSERT INTO drivers (carrier_id, name) VALUES ($1,'Isabel Nguli')`, [moto.id]);
  }

  await pool.query(
    `INSERT INTO agent_profiles (user_id, point_name, province, municipality, verified)
     SELECT $1,'Cantina do Kizua','Huambo','Caála',TRUE
     WHERE NOT EXISTS (SELECT 1 FROM agent_profiles WHERE user_id=$1)`,
    [kizuaId]
  );

  console.log('Seed concluído.');
  console.log('Contas de demonstração (password: epyalink123):');
  console.log('  Produtor:            +244923000001 (Fazenda Boa Esperança — Huambo)');
  console.log('  Comprador:           +244923000002 (Ana Kiala)');
  console.log('  Comprador corporativo:+244923000006 (Restaurante Kianda)');
  console.log('  Transportadora:      +244923000003 (interprovincial, XPTO)');
  console.log('  Estafeta urbano:     +244923000005 (Estafeta Rápido Luanda)');
  console.log('  Ponto EPYALINK:      +244923000007 (Cantina do Kizua)');
  console.log('  Administrador:       +244923000004');
  await pool.end();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

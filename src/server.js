require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { pool } = require('./db');

const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/farms', require('./routes/farms'));
app.use('/api/products', require('./routes/products'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/threads', require('./routes/messages'));
app.use('/api/disputes', require('./routes/disputes'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/favorites', require('./routes/favorites'));
app.use('/api/carrier', require('./routes/carrier'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/market', require('./routes/market'));
app.use('/api/wallet', require('./routes/wallet'));
app.use('/api/agent', require('./routes/agent'));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

async function ensureSchema() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(schema);
}
// 1. Defina a função aqui em cima
const bcrypt = require('bcrypt'); // Certifique-se de que o bcrypt está disponível no server.js

async function criarAdminSeguro() {
  try {
    const rawPhone = process.env.ADMIN_PHONE || '';
    const cleanPhone = rawPhone.replace(/\D/g, ''); 

    if (!cleanPhone) {
      console.log('[ADMIN] Variável ADMIN_PHONE não configurada.');
      return;
    }

    const result = await pool.query(
      "UPDATE users SET role = 'ADMIN' WHERE REGEXP_REPLACE(phone, '\\D', '', 'g') LIKE '%' || $1 || '%' RETURNING id, phone, role;",
      [cleanPhone]
    );

    if (result.rows.length > 0) {
      console.log('[ADMIN] Utilizador promovido a admin com sucesso:', result.rows[0]);
    } else {
      console.log('[ADMIN] Nenhum utilizador encontrado com o número configurado.');
    }
  } catch (error) {
    console.error('[ADMIN] Erro ao promover admin:', error);
  }
}

const PORT = process.env.PORT || 3000;
ensureSchema()
    .then(async () => {
        // Chamamos a função de criação do admin aqui dentro, antes do servidor aceitar pedidos
        await criarAdminSeguro();

        app.listen(PORT, () => console.log(`EPYALINK server a correr na porta ${PORT}`));
    })
  .catch((e) => {
    console.error('Falha ao preparar a base de dados:', e);
    process.exit(1);
  });

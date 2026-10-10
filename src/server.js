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
async function criarAdminSeguro() {
    try {
        const adminPhone = process.env.ADMIN_PHONE;
        const adminPassword = process.env.ADMIN_PASSWORD;

        if (!adminPhone || !adminPassword) {
            console.log("Variáveis ADMIN_PHONE ou ADMIN_PASSWORD não configuradas no Render.");
            return;
        }

        const checkUser = await pool.query('SELECT * FROM users WHERE phone = $1', [adminPhone]);

        if (checkUser.rows.length === 0) {
            await pool.query(
                'INSERT INTO users (phone, password, role) VALUES ($1, $2, $3)',
                [adminPhone, adminPassword, 'admin']
            );
            console.log('Utilizador Administrador criado automaticamente com sucesso!');
        } else {
            console.log('Utilizador Administrador já se encontra registado.');
        }
    } catch (error) {
        console.error('Erro ao verificar/criar o administrador:', error);
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

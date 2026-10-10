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
        const adminPhone = process.env.ADMIN_PHONE;
        const adminPassword = process.env.ADMIN_PASSWORD;

        if (!adminPhone || !adminPassword) {
            console.log("Variáveis ADMIN_PHONE ou ADMIN_PASSWORD não configuradas no Render.");
            return;
        }

        // Gera o hash seguro da password
        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(adminPassword, saltRounds);

        // Verifica se o utilizador já existe pelo telefone
        const checkUser = await pool.query('SELECT * FROM users WHERE phone = $1', [adminPhone]);

        if (checkUser.rows.length === 0) {
            // Se não existe, cria o admin com todos os campos obrigatórios da tabela
            await pool.query(
                `INSERT INTO users (name, phone, password_hash, role) 
                 VALUES ($1, $2, $3, $4)`,
                ['Administrador EPYALINK', adminPhone, passwordHash, 'admin']
            );
            console.log('Utilizador Administrador criado com sucesso!');
        } else {
            // Se já existe (ex: conta antiga de produtor), força a atualização para ADMIN e atualiza a password
            await pool.query(
                `UPDATE users 
                 SET role = 'admin', password_hash = $1 
                 WHERE phone = $2`,
                [passwordHash, adminPhone]
            );
            console.log('Conta existente promovida a Administrador com sucesso!');
        }
    } catch (error) {
        console.error('Erro detalhado ao criar/atualizar o administrador:', error);
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

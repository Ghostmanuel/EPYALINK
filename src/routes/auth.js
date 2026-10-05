const express = require('express');
const bcrypt = require('bcryptjs');
const { q, one } = require('../db');
const { sign } = require('../lib/jwt');
const { auth } = require('../middleware/auth');
const sms = require('../lib/sms');
const { PROV } = require('../lib/business');

const router = express.Router();

const PHONE_RE = /^\+244\d{9}$/;

function cleanPhone(p) {
  if (!p) return '';
  let s = String(p).trim().replace(/\s|-/g, '');
  if (/^9\d{8}$/.test(s)) s = '+244' + s;
  if (/^244\d{9}$/.test(s)) s = '+' + s;
  return s;
}

// ---------- registo ----------
router.post('/register', async (req, res) => {
  try {
    const { name, password, role } = req.body;
    const phone = cleanPhone(req.body.phone);
    if (!name || !password || !role) return res.status(400).json({ error: 'Preenche nome, telefone, password e o tipo de conta.' });
    if (!PHONE_RE.test(phone)) return res.status(400).json({ error: 'Telefone inválido. Usa o formato +244923456789.' });
    if (password.length < 6) return res.status(400).json({ error: 'A password deve ter pelo menos 6 caracteres.' });
    if (!['BUYER', 'SELLER', 'CARRIER', 'AGENT'].includes(role)) return res.status(400).json({ error: 'Tipo de conta inválido.' });

    // Validar os campos específicos de cada papel ANTES de criar a conta (evita contas órfãs).
    if (role === 'SELLER' && (!req.body.farmName || !PROV[req.body.province] || !req.body.municipality)) {
      return res.status(400).json({ error: 'Indica o nome da fazenda/empresa, a província e o município.' });
    }
    if (role === 'CARRIER' && (!req.body.companyName || !PROV[req.body.province])) {
      return res.status(400).json({ error: 'Indica o nome da empresa/estafeta e a província.' });
    }
    if (role === 'AGENT' && (!req.body.pointName || !PROV[req.body.province] || !req.body.municipality)) {
      return res.status(400).json({ error: 'Indica o nome do Ponto EPYALINK, a província e o município.' });
    }

    const exists = await one('SELECT id FROM users WHERE phone=$1', [phone]);
    if (exists) return res.status(409).json({ error: 'Já existe uma conta com este telefone.' });

    const hash = await bcrypt.hash(password, 10);
    const user = await one(
      `INSERT INTO users (name, phone, email, password_hash, role, company_name, nif) VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, name, phone, email, role`,
      [name, phone, req.body.email || null, hash, role,
       role === 'BUYER' && req.body.companyName ? String(req.body.companyName).trim().slice(0, 120) : null,
       role === 'BUYER' && req.body.nif ? String(req.body.nif).trim().slice(0, 20) : null]
    );

    if (role === 'SELLER') {
      const { farmName, farmType, province, municipality, about } = req.body;
      if (!farmName || !PROV[province] || !municipality) {
        return res.status(400).json({ error: 'Indica o nome da fazenda/empresa, a província e o município.' });
      }
      await q(
        `INSERT INTO farms (owner_id, name, type, province, municipality, about) VALUES ($1,$2,$3,$4,$5,$6)`,
        [user.id, farmName, farmType || 'PRODUTOR', province, municipality, about || '']
      );
    }
    if (role === 'CARRIER') {
      const { companyName, province } = req.body;
      const kind = req.body.carrierKind === 'ESTAFETA' ? 'ESTAFETA' : 'INTERPROVINCIAL';
      if (!companyName || !PROV[province]) return res.status(400).json({ error: 'Indica o nome da empresa/estafeta e a província.' });
      await q(`INSERT INTO carrier_profiles (user_id, company_name, province, kind) VALUES ($1,$2,$3,$4)`, [user.id, companyName, province, kind]);
    }
    if (role === 'AGENT') {
      const { pointName, province, municipality } = req.body;
      if (!pointName || !PROV[province] || !municipality) {
        return res.status(400).json({ error: 'Indica o nome do Ponto EPYALINK, a província e o município.' });
      }
      await q(`INSERT INTO agent_profiles (user_id, point_name, province, municipality) VALUES ($1,$2,$3,$4)`, [user.id, pointName, province, municipality]);
    }

    const token = sign(user);
    res.json({ token, user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Não foi possível criar a conta.' });
  }
});

// ---------- login ----------
router.post('/login', async (req, res) => {
  try {
    const phone = cleanPhone(req.body.phone);
    const { password } = req.body;
    const user = await one('SELECT * FROM users WHERE phone=$1', [phone]);
    if (!user) return res.status(401).json({ error: 'Telefone ou password incorretos.' });
    const ok = await bcrypt.compare(password || '', user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Telefone ou password incorretos.' });
    const token = sign(user);
    res.json({ token, user: { id: user.id, name: user.name, phone: user.phone, email: user.email, role: user.role } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Não foi possível iniciar sessão.' });
  }
});

router.get('/me', auth, (req, res) => res.json({ user: req.user }));

// ---------- recuperar password: pedir código ----------
// channel: 'SMS' (KambaSMS) ou 'WHATSAPP' (Meta Cloud API)
router.post('/forgot-password', async (req, res) => {
  try {
    const phone = cleanPhone(req.body.phone);
    const channel = (req.body.channel || 'SMS').toUpperCase();
    if (!PHONE_RE.test(phone)) return res.status(400).json({ error: 'Telefone inválido.' });
    const user = await one('SELECT id FROM users WHERE phone=$1', [phone]);
    // Resposta genérica mesmo se não existir, para não revelar quais números estão registados.
    if (!user) return res.json({ sent: true });

    if (channel === 'SMS' && sms.hasKamba()) {
      const r = await sms.kambaSendOtp(phone);
      return res.json({ sent: true, via: 'kambasms', expiresIn: r.expires_in || 300 });
    }

    // Modo local (fallback de desenvolvimento, ou canal WhatsApp)
    const code = sms.genCode();
    const hash = await bcrypt.hash(code, 8);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await q(
      `INSERT INTO password_reset_otps (user_id, code_hash, channel, expires_at) VALUES ($1,$2,$3,$4)`,
      [user.id, hash, channel === 'WHATSAPP' ? 'WHATSAPP' : 'SMS', expiresAt]
    );

    if (channel === 'WHATSAPP' && sms.hasWhatsapp()) {
      await sms.whatsappSendOtp(phone, code);
    } else if (channel === 'SMS' && sms.hasKamba()) {
      await sms.kambaSendSms(phone, `EPYALINK: o teu codigo de recuperacao e ${code}. Valido por 5 minutos.`);
    } else {
      // Sem credenciais configuradas: regista no log do servidor para poderes testar sem custos.
      console.log(`[EPYALINK] Código de recuperação (${channel}) para ${phone}: ${code}`);
    }

    res.json({ sent: true, via: 'local', expiresIn: 300, devHint: process.env.NODE_ENV !== 'production' ? code : undefined });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Não foi possível enviar o código. Tenta novamente.' });
  }
});

// ---------- recuperar password: confirmar código + nova password ----------
router.post('/reset-password', async (req, res) => {
  try {
    const phone = cleanPhone(req.body.phone);
    const { code, newPassword } = req.body;
    if (!code || !newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Indica o código e uma nova password com pelo menos 6 caracteres.' });
    }
    const user = await one('SELECT id FROM users WHERE phone=$1', [phone]);
    if (!user) return res.status(400).json({ error: 'Código inválido ou expirado.' });

    if (sms.hasKamba()) {
      const r = await sms.kambaVerifyOtp(phone, code);
      if (!r.success) return res.status(400).json({ error: r.message || 'Código inválido ou expirado.' });
    } else {
      const otp = await one(
        `SELECT * FROM password_reset_otps WHERE user_id=$1 AND consumed=FALSE ORDER BY created_at DESC LIMIT 1`,
        [user.id]
      );
      if (!otp) return res.status(400).json({ error: 'Pede um novo código.' });
      if (otp.attempts >= 5) return res.status(429).json({ error: 'Demasiadas tentativas. Pede um novo código.' });
      if (new Date(otp.expires_at) < new Date()) return res.status(400).json({ error: 'Código expirado. Pede um novo.' });
      const ok = await bcrypt.compare(code, otp.code_hash);
      await q('UPDATE password_reset_otps SET attempts = attempts + 1 WHERE id=$1', [otp.id]);
      if (!ok) return res.status(400).json({ error: 'Código incorreto.' });
      await q('UPDATE password_reset_otps SET consumed=TRUE WHERE id=$1', [otp.id]);
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await q('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, user.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Não foi possível repor a password.' });
  }
});

module.exports = router;

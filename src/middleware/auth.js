const { verify } = require('../lib/jwt');
const { one } = require('../db');

async function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Sessão não encontrada. Inicia sessão.' });
  try {
    const payload = verify(token);
    const user = await one('SELECT id, name, phone, email, role FROM users WHERE id=$1', [payload.id]);
    if (!user) return res.status(401).json({ error: 'Utilizador não encontrado.' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Não tens permissão para esta ação.' });
    }
    next();
  };
}

module.exports = { auth, requireRole };

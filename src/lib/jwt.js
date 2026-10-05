const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

function sign(user) {
  return jwt.sign({ id: user.id, role: user.role, phone: user.phone, name: user.name }, SECRET, { expiresIn: '30d' });
}
function verify(token) {
  return jwt.verify(token, SECRET);
}
module.exports = { sign, verify };

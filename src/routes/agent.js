const express = require('express');
const { one } = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/me', auth, requireRole('AGENT'), async (req, res) => {
  const a = await one('SELECT * FROM agent_profiles WHERE user_id=$1', [req.user.id]);
  if (!a) return res.status(404).json({ error: 'Ponto EPYALINK não encontrado.' });
  res.json({
    id: a.id,
    pointName: a.point_name,
    province: a.province,
    municipality: a.municipality,
    verified: a.verified,
    validationsCount: a.validations_count
  });
});

module.exports = router;

// Adaptador de recuperação de password por SMS (KambaSMS) ou WhatsApp (Meta Cloud API).
//
// KambaSMS tem um serviço de OTP gerido (enviar + verificar código), documentado em
// https://www.kambasms.ao/dashboard/docs — usamos esse serviço diretamente quando
// KAMBASMS_API_KEY está configurada. Sem chave configurada (ex.: em desenvolvimento),
// caímos num modo local: geramos o código nós próprios, guardamos o hash na base de
// dados (tabela password_reset_otps) e limitamo-nos a imprimir o código na consola —
// para nunca bloquear o fluxo de testes sem custos de SMS reais.
//
// IMPORTANTE: confirma sempre o endpoint e o nome exato do cabeçalho de autenticação
// no dashboard da KambaSMS antes de ires para produção — o endpoint abaixo segue a
// documentação pública disponível à data desta integração.

const KAMBASMS_BASE_URL = process.env.KAMBASMS_BASE_URL || 'https://api.kambasms.ao';
const KAMBASMS_API_KEY = process.env.KAMBASMS_API_KEY || '';

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || '';
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID || '';
const WHATSAPP_OTP_TEMPLATE = process.env.WHATSAPP_OTP_TEMPLATE || 'otp_code';

const hasKamba = () => !!KAMBASMS_API_KEY;
const hasWhatsapp = () => !!(WHATSAPP_TOKEN && WHATSAPP_PHONE_ID);

/** Envia um OTP gerido pela KambaSMS (eles guardam e validam o código do lado deles). */
async function kambaSendOtp(phone) {
  const res = await fetch(`${KAMBASMS_BASE_URL}/otp/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KAMBASMS_API_KEY}`
    },
    body: JSON.stringify({ phone })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Falha ao enviar OTP (KambaSMS, ${res.status})`);
  return data; // { expires_in, ... }
}

/** Verifica o OTP diretamente na KambaSMS (endpoint público, sem API key). */
async function kambaVerifyOtp(phone, code) {
  const res = await fetch(`${KAMBASMS_BASE_URL}/otp/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, code })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { success: false, message: data.message || 'Código inválido ou expirado.' };
  return data; // { success: true/false }
}

/** Envia uma SMS transacional simples (não-OTP) via KambaSMS. */
async function kambaSendSms(phone, text) {
  const res = await fetch(`${KAMBASMS_BASE_URL}/sms/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KAMBASMS_API_KEY}`
    },
    body: JSON.stringify({ to: phone, text, sender_id: 'EPYALINK' })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Falha ao enviar SMS (KambaSMS, ${res.status})`);
  return data;
}

/** Envia um código OTP por WhatsApp via Meta Cloud API (requer template aprovado). */
async function whatsappSendOtp(phone, code) {
  const to = phone.replace('+', '');
  const res = await fetch(`https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${WHATSAPP_TOKEN}`
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: WHATSAPP_OTP_TEMPLATE,
        language: { code: 'pt_PT' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: code }] }]
      }
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Falha ao enviar WhatsApp (${res.status})`);
  return data;
}

/**
 * Envia uma SMS transacional (PIN de entrega, código de levantamento...).
 * Sem KambaSMS configurada, regista no log do servidor (modo de desenvolvimento) e
 * devolve { via: 'local' } para o chamador saber que a SMS não saiu de facto.
 */
async function sendTransactional(phone, text) {
  if (hasKamba()) {
    try {
      await kambaSendSms(phone, text);
      return { via: 'kambasms' };
    } catch (e) {
      console.error('[EPYALINK] Falha ao enviar SMS:', e.message);
      return { via: 'failed' };
    }
  }
  console.log(`[EPYALINK] (SMS local) para ${phone}: ${text}`);
  return { via: 'local' };
}

function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

module.exports = {
  hasKamba,
  hasWhatsapp,
  kambaSendOtp,
  kambaVerifyOtp,
  kambaSendSms,
  sendTransactional,
  whatsappSendOtp,
  genCode
};

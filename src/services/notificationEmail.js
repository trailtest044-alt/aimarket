import { env } from '../config/env.js';
import { EmailNotification } from '../models/EmailNotification.js';
import crypto from 'node:crypto';

const transporterCache = new Map();

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function escapeAddressName(value) {
  return String(value || 'Ai Market').replace(/[\r\n"]/g, '').trim() || 'Ai Market';
}

function money(amount, currency) {
  const value = Number(amount || 0);
  if (currency === 'BDT') return `BDT ${Math.round(value).toLocaleString('en-BD')}`;
  if (currency === 'PKR') return `Rs ${Math.round(value).toLocaleString('en-PK')}`;
  return `${value.toFixed(2)} ${currency || 'USDT'}`;
}

function mailReady() {
  return Boolean(env.mail.host && env.mail.user && env.mail.password);
}

function normalizedFrom() {
  const from = String(env.mail.from || '').trim();
  const address = String(env.mail.user || env.mail.replyTo || 'support@aimarket.example').trim();
  if (from.includes('<') && from.includes('@')) return from;
  if (from.includes('@')) return `Ai Market <${from}>`;
  return `${escapeAddressName(from)} <${address}>`;
}

function smtpCandidates() {
  const user = env.mail.user;
  const password = env.mail.password;
  const configured = {
    host: env.mail.host,
    port: env.mail.port,
    secure: env.mail.secure,
    auth: { user, pass: password },
    pool: true,
    maxConnections: 1,
    maxMessages: 100,
    connectionTimeout: 6000,
    greetingTimeout: 6000,
    socketTimeout: 12000
  };
  const fallbacks = [
    { host: 'localhost', port: 465, secure: true, auth: { user, pass: password }, tls: { rejectUnauthorized: false } },
    { host: 'localhost', port: 587, secure: false, auth: { user, pass: password }, tls: { rejectUnauthorized: false } }
  ];
  const seen = new Set();
  return [configured, ...fallbacks].filter((item) => {
    if (!item.host || !item.auth.user || !item.auth.pass) return false;
    const key = `${item.host}:${item.port}:${item.secure}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function getTransporter(config) {
  const key = `${config.host}:${config.port}:${config.secure}`;
  if (!transporterCache.has(key)) {
    const { default: nodemailer } = await import('nodemailer');
    transporterCache.set(key, nodemailer.createTransport({
      pool: true,
      maxConnections: 1,
      maxMessages: 100,
      connectionTimeout: 6000,
      greetingTimeout: 6000,
      socketTimeout: 12000,
      ...config
    }));
  }
  return transporterCache.get(key);
}

// OTP delivery stays serialized for the shared hosting process limit. SMTP
// connections are reused, while the normal local-mail fallback remains
// available when the hosting SMTP endpoint is temporarily unavailable.
let loginCodeDeliveryQueue = Promise.resolve();

export function queueCustomerLoginCode(payload) {
  const delivery = loginCodeDeliveryQueue.then(() => sendCustomerLoginCode(payload));
  loginCodeDeliveryQueue = delivery.catch(() => undefined);
  return delivery;
}

async function getSendmailTransporter() {
  const key = 'sendmail:/usr/sbin/sendmail';
  if (!transporterCache.has(key)) {
    const { default: nodemailer } = await import('nodemailer');
    transporterCache.set(key, nodemailer.createTransport({
      sendmail: true,
      newline: 'unix',
      path: '/usr/sbin/sendmail'
    }));
  }
  return transporterCache.get(key);
}

async function sendWithFallback(mailOptions, { allowSendmail = true, configuredSmtpOnly = false } = {}) {
  let lastError = null;
  const candidates = smtpCandidates();
  const smtpAttempts = configuredSmtpOnly ? candidates.slice(0, 1) : candidates;
  for (const config of smtpAttempts) {
    try {
      const result = await (await getTransporter(config)).sendMail(mailOptions);
      return { result, host: config.host, port: config.port };
    } catch (error) {
      lastError = error;
    }
  }
  if (!allowSendmail) throw lastError || new Error('SMTP delivery failed');
  try {
    const result = await (await getSendmailTransporter()).sendMail(mailOptions);
    return { result, host: 'sendmail', port: 'local' };
  } catch (error) {
    lastError = error || lastError;
  }
  throw lastError || new Error('SMTP delivery failed');
}

function emailShell({ preheader, label, title, intro, body, footerNote = 'Need help? Reply to this email and our team will assist you.' }) {
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f6f9fc;color:#1a1f36;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased">
    <span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden">${escapeHtml(preheader)}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f9fc;padding:40px 12px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
          <tr><td style="padding:0 4px 18px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
              <td style="font-size:20px;font-weight:700;letter-spacing:-.2px;color:#1a1f36">Ai Market</td>
              <td align="right"><span style="display:inline-block;border:1px solid #d8dee9;border-radius:999px;background:#fff;padding:6px 10px;font-size:11px;font-weight:700;color:#536071;text-transform:uppercase;letter-spacing:.5px">${escapeHtml(label)}</span></td>
            </tr></table>
          </td></tr>
          <tr><td style="background:#ffffff;border:1px solid #e6ebf1;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(26,31,54,.04)">
            <div style="padding:32px 32px 30px">
              <h1 style="margin:0 0 10px;font-size:23px;line-height:1.28;font-weight:700;letter-spacing:-.2px;color:#1a1f36">${escapeHtml(title)}</h1>
              <p style="margin:0 0 26px;font-size:15px;line-height:1.62;color:#536071">${escapeHtml(intro)}</p>
              ${body}
            </div>
          </td></tr>
          <tr><td style="padding:22px 4px 0;font-size:12px;line-height:1.65;color:#697386">
            ${escapeHtml(footerNote)}<br>© ${new Date().getFullYear()} Ai Market. This is a transactional notification.
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

function infoRow(label, value, isSecret = false) {
  if (!value) return '';
  return `<tr><td style="padding:13px 0;border-bottom:1px solid #eef2f7;font-size:13px;color:#697386;vertical-align:top">${escapeHtml(label)}</td><td align="right" style="padding:13px 0 13px 16px;border-bottom:1px solid #eef2f7;font-size:14px;font-weight:${isSecret ? '700' : '600'};color:#1a1f36;word-break:break-word;vertical-align:top">${escapeHtml(value)}</td></tr>`;
}

async function recordMail({ type, to, subject, entityId, meta = {}, text, html, allowSendmail = true, configuredSmtpOnly = false }) {
  const record = await EmailNotification.create({ type, to, subject, entityId: String(entityId || ''), meta, status: mailReady() ? 'queued' : 'not_configured' });
  if (!mailReady()) return { sent: false, status: 'not_configured', id: record._id };
  try {
    const { result, host, port } = await sendWithFallback({
      from: normalizedFrom(),
      replyTo: env.mail.replyTo || undefined,
      to,
      subject,
      text,
      html,
      headers: { 'X-Ai-Market-Notification': type, 'X-Entity-Ref-ID': String(entityId || '') }
    }, { allowSendmail, configuredSmtpOnly });
    await EmailNotification.findByIdAndUpdate(record._id, { $set: { status: 'sent', sentAt: new Date(), providerMessageId: result.messageId || '', meta: { ...meta, smtpHost: host, smtpPort: port } } });
    return { sent: true, status: 'sent', id: record._id };
  } catch (error) {
    await EmailNotification.findByIdAndUpdate(record._id, { $set: { status: 'failed', failedAt: new Date(), error: String(error?.message || 'SMTP delivery failed').slice(0, 1000) } });
    console.error('System email failed:', error.message);
    return { sent: false, status: 'failed', id: record._id };
  }
}

export async function sendCustomerLoginCode({ email, code, expiresMinutes = 10 }) {
  const recipient = String(email || '').trim().toLowerCase();
  if (!recipient) return { sent: false, status: 'missing_recipient' };
  const text = `Your Ai Market sign-in code is ${code}. It expires in ${expiresMinutes} minutes. If you did not request this code, you can ignore this email.`;
  const body = `<div style="margin:4px 0 24px;padding:22px;border-radius:10px;background:#f6f9fc;border:1px solid #e6ebf1;text-align:center"><div style="font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#697386">Verification code</div><div style="margin-top:10px;font-size:34px;line-height:1;font-weight:800;letter-spacing:8px;color:#1a1f36">${escapeHtml(code)}</div><div style="margin-top:12px;font-size:13px;color:#697386">Expires in ${escapeHtml(expiresMinutes)} minutes</div></div><div style="padding:14px 16px;border-radius:8px;background:#fff8e6;color:#8a5a00;font-size:13px;line-height:1.55"><b>Security notice:</b> Ai Market will never ask you to share this code. If you did not request it, no action is needed.</div>`;
  const html = emailShell({
    preheader: `${code} is your Ai Market sign-in code.`,
    label: 'Secure sign in',
    title: 'Confirm your email address',
    intro: 'Enter this one-time code on Ai Market to finish signing in.',
    body,
    footerNote: 'This code can be used once and expires automatically.'
  });
  return recordMail({
    type: 'customer_login_code',
    to: recipient,
    subject: `${code} is your Ai Market sign-in code`,
    entityId: shaForLog(recipient),
    meta: { expiresMinutes },
    text,
    html,
    configuredSmtpOnly: true
  });
}

function shaForLog(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

export async function sendDeliveryEmail({ order, delivery }) {
  const recipient = String(order?.customer?.email || '').trim();
  if (!recipient) return { sent: false, status: 'missing_recipient' };

  const product = order.productSnapshot?.title || 'your Ai Market product';
  const productLogo = String(order.productSnapshot?.logoUrl || '').trim();
  const amount = money(order.productSnapshot?.price, order.productSnapshot?.currency);
  const detailLines = [
    delivery?.email ? `Account email: ${delivery.email}` : '',
    delivery?.password ? `Password: ${delivery.password}` : '',
    delivery?.activationCode ? `Activation key: ${delivery.activationCode}` : '',
    delivery?.instruction ? `Instructions: ${delivery.instruction}` : '',
    delivery?.videoUrl ? `Instruction video: ${delivery.videoUrl}` : ''
  ].filter(Boolean);
  const resellerDue = order.paymentMethod === 'reseller_due';
  const amountLabel = resellerDue ? 'Amount due' : 'Paid';
  const text = `Ai Market - your delivery is ready\n\nProduct: ${product}\nOrder: ${order.orderId}\n${amountLabel}: ${amount}\n${resellerDue ? 'Payment is due according to your reseller account statement.\n\n' : '\n'}${detailLines.join('\n')}\n\nSecurity note: Keep account details private. Do not forward this email or change recovery information.`;
  const logo = productLogo
    ? `<img src="${escapeHtml(productLogo)}" width="44" height="44" alt="${escapeHtml(product)}" style="display:block;width:44px;height:44px;border-radius:10px;object-fit:contain;background:#fff">`
    : `<div style="width:44px;height:44px;border-radius:10px;background:#f6f9fc;border:1px solid #e6ebf1;color:#1a1f36;font-size:18px;line-height:44px;text-align:center;font-weight:700">P</div>`;
  const deliveryRows = [
    infoRow('Account email', delivery?.email),
    infoRow('Password', delivery?.password, true),
    infoRow('Activation key', delivery?.activationCode, true)
  ].join('');
  const guidance = [
    delivery?.instruction ? `<div style="margin-top:22px"><div style="font-size:13px;font-weight:700;color:#1a1f36;margin-bottom:8px">Instructions</div><div style="font-size:14px;line-height:1.65;color:#536071">${escapeHtml(delivery.instruction)}</div></div>` : '',
    delivery?.videoUrl ? `<div style="margin-top:16px"><a href="${escapeHtml(delivery.videoUrl)}" style="display:inline-block;background:#635bff;color:#fff;text-decoration:none;border-radius:6px;padding:11px 14px;font-size:14px;font-weight:700">Watch setup video</a></div>` : ''
  ].join('');
  const body = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px"><tr><td style="width:52px;vertical-align:top">${logo}</td><td style="vertical-align:top"><div style="font-size:16px;font-weight:700;color:#1a1f36">${escapeHtml(product)}</div><div style="margin-top:4px;font-size:13px;color:#697386">Order ${escapeHtml(order.orderId)}</div></td><td align="right" style="vertical-align:top"><div style="font-size:13px;color:#697386">${resellerDue ? 'Amount due' : 'Amount paid'}</div><div style="margin-top:4px;font-size:16px;font-weight:700;color:#1a1f36">${escapeHtml(amount)}</div></td></tr></table>${resellerDue ? '<div style="margin:0 0 16px;padding:12px 14px;border-radius:8px;background:#fff8e6;color:#8a5a00;font-size:13px">This reseller order is recorded as due. Please pay it from your reseller account statement.</div>' : ''}<div style="height:1px;background:#eef2f7;margin:0 0 8px"></div>${deliveryRows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${deliveryRows}</table>` : ''}${guidance}<div style="margin-top:24px;padding:14px 16px;border-radius:8px;background:#f6f9fc;border:1px solid #e6ebf1;color:#536071;font-size:13px;line-height:1.55"><b style="color:#1a1f36">Security note:</b> Keep these details private. Do not forward this email or change recovery information.</div>`;
  const html = emailShell({ preheader: `${product} delivery details are ready.`, label: 'Delivered', title: 'Your delivery is ready', intro: 'We have prepared your order. The login details and setup information are below.', body });
  return recordMail({ type: 'delivery_receipt', to: recipient, subject: `Your ${product} delivery is ready`, entityId: order.orderId, meta: { orderId: order.orderId, product }, text, html });
}

export async function sendResellerPaymentReceipt({ reseller, receiptNo, currency, paymentReceived, discountApplied, allocations, remainingDue }) {
  const recipient = String(reseller?.email || '').trim();
  if (!recipient) return { sent: false, status: 'missing_recipient' };
  const completed = allocations.filter((item) => Number(item.remainingAmount || 0) === 0);
  const textLines = completed.length
    ? completed.map((item) => `${item.invoiceNo}: paid ${money(item.paymentApplied, currency)}, discount ${money(item.discountApplied, currency)}, cleared`).join('\n')
    : 'No invoice was fully closed in this receipt.';
  const text = `Ai Market reseller payment receipt\n\nReceipt: ${receiptNo}\nPayment received: ${money(paymentReceived, currency)}\nDiscount applied: ${money(discountApplied, currency)}\nRemaining due: ${money(remainingDue, currency)}\n\nCompleted invoices:\n${textLines}`;
  const invoiceRows = completed.length
    ? completed.map((item) => `<tr><td style="padding:13px 0;border-bottom:1px solid #eef2f7;font-size:13px;font-weight:600;color:#1a1f36">${escapeHtml(item.invoiceNo)}</td><td align="right" style="padding:13px 0 13px 16px;border-bottom:1px solid #eef2f7;font-size:13px;color:#1a1f36">Paid ${escapeHtml(money(item.paymentApplied, currency))}${Number(item.discountApplied || 0) > 0 ? `<br><span style="color:#697386">Discount ${escapeHtml(money(item.discountApplied, currency))}</span>` : ''}</td></tr>`).join('')
    : `<tr><td style="padding:13px 0;font-size:13px;color:#697386">No invoice was fully closed in this receipt.</td></tr>`;
  const body = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:22px"><tr><td><div style="font-size:13px;color:#697386">Receipt</div><div style="margin-top:4px;font-size:16px;font-weight:700;color:#1a1f36">${escapeHtml(receiptNo)}</div></td><td align="right"><div style="font-size:13px;color:#697386">Payment received</div><div style="margin-top:4px;font-size:20px;font-weight:700;color:#1a1f36">${escapeHtml(money(paymentReceived, currency))}</div></td></tr></table><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${infoRow('Discount applied', money(discountApplied, currency))}${infoRow('Remaining due', money(remainingDue, currency))}</table><div style="margin:24px 0 8px;font-size:13px;font-weight:700;color:#1a1f36">Invoices cleared in this payment</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${invoiceRows}</table>`;
  const html = emailShell({ preheader: `Payment receipt ${receiptNo} is ready.`, label: 'Receipt', title: 'Payment received', intro: 'Your reseller payment has been recorded. The receipt summary and cleared invoices are shown below.', body });
  return recordMail({ type: 'reseller_payment_receipt', to: recipient, subject: `Payment receipt ${receiptNo}`, entityId: receiptNo, meta: { receiptNo, currency, paymentReceived, discountApplied, completedInvoiceCount: completed.length }, text, html });
}

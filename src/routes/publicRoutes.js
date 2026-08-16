import express from 'express';
import { z } from 'zod';
import validator from 'validator';
import { Product } from '../models/Product.js';
import { PaymentMethod } from '../models/PaymentMethod.js';
import { Order } from '../models/Order.js';
import { StockItem } from '../models/StockItem.js';
import { MailTxtFile } from '../models/MailTxtFile.js';
import { Customer } from '../models/Customer.js';
import { EmailLoginChallenge } from '../models/EmailLoginChallenge.js';
import { PromoCode } from '../models/PromoCode.js';
import { Visitor } from '../models/Visitor.js';
import { Reseller } from '../models/Reseller.js';
import { ResellerProductAccess } from '../models/ResellerProductAccess.js';
import { ResellerLedger } from '../models/ResellerLedger.js';
import { ResellerInvoice } from '../models/ResellerInvoice.js';
import { ResellerPaymentRequest } from '../models/ResellerPaymentRequest.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { createAccessToken, createOrderId, sha256 } from '../utils/tokens.js';
import { decryptJson, encryptJson } from '../utils/cryptoBox.js';
import { orderLimiter, emailLoginStartLimiter, emailLoginVerifyLimiter } from '../middleware/rateLimits.js';
import { notifyNewOrder, notifyOrderDelivered, notifyManualActivationSubmitted, notifyResellerPaymentRequest } from '../services/telegramBot.js';
import { markOrderDelivered } from '../services/orderWorkflow.js';
import { optionalCustomer, requireCustomer, signCustomerToken } from '../middleware/auth.js';
import { detectRegion, priceForRegion, allowedPaymentMethods, priceRegionForPaymentMethod } from '../utils/region.js';
import { env } from '../config/env.js';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { queueCustomerLoginCode } from '../services/notificationEmail.js';

export const publicRouter = express.Router();
const activeCheckoutRequests = new Set();
const activeFreeClaims = new Set();

async function nextAvailableStock(productId) {
  const items = await StockItem.find({ productId, status: 'available' })
    .sort({ createdAt: 1 })
    .limit(1)
    .lean();
  return items[0] || null;
}

// Stock is the source of truth for delivery. Product-level mode is only a
// fallback for fake-stock/backorder orders where no real item exists yet.
// This also repairs older snapshots that were incorrectly latched to manual
// while their assigned item is actually Login with Get Code.
async function latchManualDeliveryMode(order) {
  if (!order) return false;
  const [product, stock] = await Promise.all([
    Product.findById(order.productId).select('deliveryMode deliveryInstruction deliveryVideoUrl deliveryImageUrl manualInputMode').lean(),
    order.assignedStockItemId
      ? StockItem.findById(order.assignedStockItemId).lean()
      : nextAvailableStock(order.productId)
  ]);
  const deliveryMode = stock?.type || product?.deliveryMode || order.productSnapshot?.deliveryMode || 'credentials';

  order.productSnapshot = {
    ...(order.productSnapshot || {}),
    deliveryMode,
    deliveryInstruction: order.productSnapshot?.deliveryInstruction || product?.deliveryInstruction || '',
    deliveryVideoUrl: order.productSnapshot?.deliveryVideoUrl || product?.deliveryVideoUrl || '',
    deliveryImageUrl: order.productSnapshot?.deliveryImageUrl || product?.deliveryImageUrl || '',
    manualInputMode: order.productSnapshot?.manualInputMode || product?.manualInputMode || 'ideogram_credentials'
  };
  if (typeof order.save === 'function') await order.save();
  else await Order.updateOne({ _id: order._id }, { $set: { productSnapshot: order.productSnapshot } });
  return deliveryMode === 'manual';
}

const createOrderSchema = z.object({
  productId: z.string().min(1),
  customer: z.object({
    name: z.string().min(2).max(80),
    email: z.string().email().max(120),
    whatsapp: z.string().max(40).optional().default('')
  }),
  paymentMethod: z.enum(['bangladesh', 'pakistan', 'binance', 'reseller_due', 'free']),
  priceRegion: z.enum(['bd', 'pk', 'world']).optional().default('world'),
  transactionId: z.string().max(120).optional().default(''),
  customerOrderRef: z.string().max(120).optional().default(''),
  paymentNote: z.string().max(500).optional().default(''),
  promoCode: z.string().max(40).optional().default(''),
  manualActivation: z.object({
    email: z.string().email().max(200),
    password: z.string().max(500).optional().default('')
  }).optional()
});

// One checkout can create several independently deliverable orders.  They
// share a batch id and payment proof, but every account still receives its
// own stock item, approval and delivery record.
const createOrderBatchSchema = z.object({
  items: z.array(z.object({
    productId: z.string().min(1),
    quantity: z.number().int().min(1).max(20)
  })).min(1).max(10),
  customer: z.object({
    name: z.string().min(2).max(80),
    email: z.string().email().max(120),
    whatsapp: z.string().max(40).optional().default('')
  }),
  paymentMethod: z.enum(['bangladesh', 'pakistan', 'binance', 'reseller_due', 'free']),
  priceRegion: z.enum(['bd', 'pk', 'world']).optional().default('world'),
  transactionId: z.string().max(120).optional().default(''),
  customerOrderRef: z.string().max(120).optional().default(''),
  paymentNote: z.string().max(500).optional().default(''),
  promoCode: z.string().max(40).optional().default(''),
  clientRequestId: z.string().max(128).regex(/^(?:[A-Za-z0-9._:-]{12,})?$/).optional().default(''),
  manualActivation: z.object({
    email: z.string().email().max(200),
    password: z.string().max(500).optional().default('')
  }).optional()
});

const manualActivationSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().max(500).optional().default('')
});

function manualInputMode(productOrSnapshot) {
  const mode = productOrSnapshot?.manualInputMode;
  return ['ideogram_credentials', 'email_password', 'email_only'].includes(mode) ? mode : 'ideogram_credentials';
}

function validateManualActivation(details, products) {
  if (!details) return 'Enter the required account details before submitting this manual activation order.';
  const needsPassword = products.some((product) => manualInputMode(product) !== 'email_only');
  if (needsPassword && !String(details.password || '').trim()) return 'Enter the required email and password before submitting this manual activation order.';
  return '';
}

const visitorSchema = z.object({
  visitorId: z.string().min(16).max(128),
  sessionId: z.string().min(16).max(128),
  path: z.string().max(220).optional().default('/'),
  referrer: z.string().max(1000).optional().default('')
});

function customerSafe(customer) {
  return {
    id: customer._id?.toString?.() || customer.id,
    name: customer.name || '',
    email: customer.email || '',
    picture: customer.picture || ''
  };
}

function requireGoogleConfig() {
  if (!env.googleClientId || !env.googleClientSecret) {
    const err = new Error('Google OAuth is not configured');
    err.status = 503;
    err.publicMessage = 'Google login is not configured yet.';
    throw err;
  }
}

function googleRedirectUri() {
  return `${env.publicApiUrl.replace(/\/$/, '')}/api/auth/google/callback`;
}

function safeReturnTo(value) {
  const fallback = '/account';
  const raw = String(value || fallback);
  if (!raw.startsWith('/') || raw.startsWith('//')) return fallback;
  return raw.slice(0, 300);
}

function safeFrontendOrigin(value) {
  const fallback = env.frontendUrl.replace(/\/$/, '');
  try {
    const origin = new URL(String(value || fallback)).origin;
    const allowed = new Set([fallback]);
    return allowed.has(origin) ? origin : fallback;
  } catch {
    return fallback;
  }
}

function signGoogleState(returnTo, frontendOrigin) {
  return jwt.sign({ type: 'google_oauth_state', returnTo: safeReturnTo(returnTo), frontendOrigin: safeFrontendOrigin(frontendOrigin) }, env.jwtSecret, { expiresIn: '10m' });
}

function readGoogleState(state) {
  try {
    const decoded = jwt.verify(String(state || ''), env.jwtSecret);
    if (decoded.type !== 'google_oauth_state') return { returnTo: '/account', frontendOrigin: safeFrontendOrigin() };
    return { returnTo: safeReturnTo(decoded.returnTo), frontendOrigin: safeFrontendOrigin(decoded.frontendOrigin) };
  } catch {
    return { returnTo: '/account', frontendOrigin: safeFrontendOrigin() };
  }
}

async function exchangeGoogleCode(code) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      redirect_uri: googleRedirectUri(),
      grant_type: 'authorization_code'
    })
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.access_token) {
    const err = new Error(json.error_description || json.error || 'Google token exchange failed');
    err.status = 502;
    err.publicMessage = 'Google login failed. Please try again.';
    throw err;
  }
  return json.access_token;
}

async function fetchGoogleProfile(accessToken) {
  const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const profile = await response.json().catch(() => ({}));
  if (!response.ok || !profile.sub || !profile.email) {
    const err = new Error(profile.error_description || profile.error || 'Google profile fetch failed');
    err.status = 502;
    err.publicMessage = 'Could not read Google profile. Please try again.';
    throw err;
  }
  if (profile.email_verified === false) {
    const err = new Error('Google email is not verified');
    err.status = 403;
    err.publicMessage = 'Please use a verified Google account.';
    throw err;
  }
  return profile;
}

async function upsertGoogleCustomer(profile) {
  const email = String(profile.email || '').toLowerCase().trim();
  let customer = await Customer.findOne({ googleId: String(profile.sub) });
  if (!customer) customer = await Customer.findOne({ email });
  if (!customer) customer = await Customer.create({ email });
  customer.googleId = String(profile.sub);
  customer.email = email;
  customer.name = profile.name || customer.name || email.split('@')[0];
  customer.picture = profile.picture || customer.picture || '';
  customer.authProvider = 'google';
  customer.emailVerifiedAt = customer.emailVerifiedAt || new Date();
  customer.isActive = true;
  customer.lastLoginAt = new Date();
  await customer.save();

  await Order.updateMany(
    { customerId: null, 'customer.email': email },
    { $set: { customerId: customer._id } }
  );

  const reseller = await Reseller.findOne({ email });
  if (reseller) {
    reseller.customerId = customer._id;
    reseller.name = customer.name || reseller.name || email.split('@')[0];
    if (reseller.status === 'invited') reseller.status = 'active';
    await reseller.save();
  }

  return customer;
}

async function linkCustomerData(customer) {
  const email = String(customer.email || '').toLowerCase().trim();
  await Order.updateMany({ customerId: null, 'customer.email': email }, { $set: { customerId: customer._id } });
  const reseller = await Reseller.findOne({ email });
  if (reseller) {
    reseller.customerId = customer._id;
    reseller.name = customer.name || reseller.name || email.split('@')[0];
    if (reseller.status === 'invited') reseller.status = 'active';
    await reseller.save();
  }
}

async function removeEmailChallenges(email) {
  const challenges = await EmailLoginChallenge.find({ email }).lean();
  await Promise.all(challenges.map((challenge) => EmailLoginChallenge.findByIdAndDelete(challenge._id)));
}

function loginCodeHash(email, code) {
  return sha256(`${env.jwtSecret}:${String(email).toLowerCase()}:${String(code)}`);
}

function resellerPriceForRegion(access, product, region) {
  const field = region === 'bd' ? 'priceBDT' : region === 'pk' ? 'pricePKR' : 'priceUSDT';
  const configured = access?.[field];
  if (configured !== null && configured !== undefined && Number.isFinite(Number(configured))) {
    return { amount: Number(configured), currency: region === 'bd' ? 'BDT' : region === 'pk' ? 'PKR' : 'USDT' };
  }
  return priceForRegion(product, region);
}

function publicProduct(p, availableStock, region = 'world', access = null) {
  const {
    pricePKR, originalPricePKR, purchaseCostPKR, accountCostPKR,
    paymentGatewayFeePKR, otherExpensePKR, ...publicBase
  } = p;
  const displayPrice = access ? resellerPriceForRegion(access, p, region) : priceForRegion(p, region);
  const bdPrice = access?.priceBDT ?? p.priceBDT;
  const worldPrice = access?.priceUSDT ?? p.priceUSDT;
  return {
    ...publicBase,
    // The checkout reads the regional fields below. For a reseller, return
    // their assigned prices there as well as in displayPrice; otherwise the
    // card can show the custom price while checkout falls back to the retail
    // price from the original product record.
    priceBDT: Number(bdPrice || 0),
    priceUSDT: Number(worldPrice || 0),
    pricing: {
      bd: { amount: Number(bdPrice || 0), currency: 'BDT', originalAmount: Number(p.originalPriceBDT || 0) },
      world: { amount: Number(worldPrice || 0), currency: 'USDT', originalAmount: Number(p.originalPriceUSDT || 0) }
    },
    displayPrice: { ...displayPrice, region },
    availableStock: availableStock || 0,
    actualStock: Number(p.actualStock || 0),
    backorderAvailable: Number(p.backorderAvailable || 0),
    resellerPrice: Boolean(access)
  };
}

function configuredBackorder(product) {
  return Math.max(0, Math.floor(Number(product?.backorderStock || 0)));
}

function isFreeProductPrice(product, price) {
  return product?.isFree === true || Number(price?.amount ?? 0) <= 0;
}

function customerFreeOrderQuery(customer) {
  const email = String(customer?.email || '').toLowerCase().trim();
  if (!customer?._id && !email) return { _id: null };
  const query = {
    paymentMethod: 'free',
    status: { $nin: ['rejected', 'cancelled', 'void'] }
  };
  const identities = [];
  if (customer?._id) identities.push({ customerId: customer._id });
  if (email) identities.push({ 'customer.email': new RegExp(`^${escapeRegex(email)}$`, 'i') });
  if (identities.length) query.$or = identities;
  return query;
}

async function assertFreeProductAvailableForCustomer(customer) {
  const previousFreeOrder = await Order.findOne(customerFreeOrderQuery(customer)).select('orderId productSnapshot.title').lean();
  if (previousFreeOrder) {
    throw new Error(`Free product already claimed on order ${previousFreeOrder.orderId}. One user can take only one free product.`);
  }
}

function freeClaimKey(customer) {
  const email = String(customer?.email || '').toLowerCase().trim();
  return customer?._id ? `id:${customer._id}` : `email:${email}`;
}

function lockFreeClaim(customer) {
  const key = freeClaimKey(customer);
  if (!key || key === 'email:') return null;
  if (activeFreeClaims.has(key)) {
    const error = new Error('Free product is already being submitted for this user. Please wait and check your order history.');
    error.status = 409;
    throw error;
  }
  activeFreeClaims.add(key);
  const expiry = setTimeout(() => activeFreeClaims.delete(key), 2 * 60 * 1000);
  expiry.unref?.();
  return key;
}

async function stockCapacity(product) {
  const [actualStock, pendingBackorders] = await Promise.all([
    StockItem.countDocuments({ productId: product._id, status: 'available' }),
    Order.countDocuments({ productId: product._id, status: 'pending', assignedStockItemId: null, 'fulfillment.isBackorder': true })
  ]);
  const backorderAvailable = Math.max(0, configuredBackorder(product) - pendingBackorders);
  return { actualStock, backorderAvailable, sellable: actualStock + backorderAvailable };
}

// Storefront product routes must never wait on external IP geo providers.
// VPNs, mobile networks and ad blockers often block those providers. The
// frontend always sends its region hint; without one we safely use worldwide.
async function storefrontRegion(req) {
  return detectRegion(req, ['bd', 'pk', 'world'].includes(String(req.query.region)) ? req.query.region : 'world', req.query.country);
}

// A reseller has already been checked against their credit limit at checkout.
// Non-manual products therefore skip the approval queue and are fulfilled by the
// system immediately. Manual subscriptions still require the customer's login
// details and an admin activation confirmation.
async function fulfillResellerOrderIfEligible(order) {
  if (order.paymentMethod !== 'reseller_due' || order.productSnapshot?.deliveryMode === 'manual' || order.fulfillment?.isBackorder) {
    try {
      if (order.productSnapshot?.deliveryMode === 'manual' && order.manualActivationSubmittedAt) {
        await notifyManualActivationSubmitted(order, decryptJson(order.manualActivationEncrypted));
      } else {
        await notifyNewOrder(order);
      }
    } catch (error) {
      // Telegram is an admin convenience. A temporary Telegram/network error
      // must never turn a successfully saved reseller order into an HTTP 500.
      console.error('Reseller notification failed for ' + order.orderId + ':', error.message);
    }
    return { order, autoDelivered: false };
  }
  try {
    const result = await markOrderDelivered({
      orderId: order.orderId,
      admin: { name: 'Reseller Auto Delivery', nickname: 'Reseller Auto Delivery' },
      source: 'reseller_credit_auto',
      deferEmail: true
    });
    setImmediate(() => notifyOrderDelivered(result.order, result.email).catch((error) => {
      console.error('Reseller delivery notification failed for ' + order.orderId + ':', error.message);
    }));
    return { order: result.order, autoDelivered: true };
  } catch (error) {
    // markOrderDelivered saves the order before sending its receipt. If the
    // receipt transport fails, return the already-delivered order instead of
    // reporting a server error after the customer was charged.
    const persisted = await Order.findOne({ orderId: order.orderId });
    if (persisted && ['approved', 'delivered'].includes(persisted.status)) {
      console.error('Reseller delivery follow-up failed for ' + order.orderId + ':', error.message);
      return { order: persisted, autoDelivered: true };
    }
    // Do not lose a valid credit order if stock changes in the small gap after
    // checkout. It remains pending and the admin receives the normal alert.
    console.error('Reseller auto delivery failed for ' + order.orderId + ':', error.message);
    try {
      await notifyNewOrder(order);
    } catch (notifyError) {
      console.error('Reseller fallback notification failed for ' + order.orderId + ':', notifyError.message);
    }
    return { order, autoDelivered: false };
  }
}

// Free products use the same atomic stock assignment and delivery workflow as
// approved orders. This keeps stock, receipts and customer access consistent.
// Manual-activation products and backorders cannot be auto-delivered.
async function fulfillFreeOrderIfEligible(order) {
  if (order.paymentMethod !== 'free' || order.productSnapshot?.deliveryMode === 'manual' || order.fulfillment?.isBackorder) {
    try {
      if (order.productSnapshot?.deliveryMode === 'manual' && order.manualActivationSubmittedAt) {
        await notifyManualActivationSubmitted(order, decryptJson(order.manualActivationEncrypted));
      } else {
        await notifyNewOrder(order);
      }
    } catch (error) {
      console.error('Free order notification failed for ' + order.orderId + ':', error.message);
    }
    return { order, autoDelivered: false };
  }
  try {
    const result = await markOrderDelivered({
      orderId: order.orderId,
      admin: { name: 'Free Auto Delivery', nickname: 'Free Auto Delivery' },
      source: 'free_product_auto',
      deferEmail: true
    });
    setImmediate(() => notifyOrderDelivered(result.order, result.email).catch((error) => {
      console.error('Free delivery notification failed for ' + order.orderId + ':', error.message);
    }));
    return { order: result.order, autoDelivered: true };
  } catch (error) {
    const persisted = await Order.findOne({ orderId: order.orderId });
    if (persisted && ['approved', 'delivered'].includes(persisted.status)) {
      console.error('Free delivery follow-up failed for ' + order.orderId + ':', error.message);
      return { order: persisted, autoDelivered: true };
    }
    console.error('Free auto delivery failed for ' + order.orderId + ':', error.message);
    try { await notifyNewOrder(order); } catch (notifyError) {
      console.error('Free fallback notification failed for ' + order.orderId + ':', notifyError.message);
    }
    return { order, autoDelivered: false };
  }
}

// A customer checkout must return as soon as its database record is safely
// created. Telegram is a best-effort admin alert and can occasionally be slow
// or unavailable; it must never hold the buyer on the checkout screen.
function queueNewOrderNotification(order) {
  setImmediate(() => {
    notifyNewOrder(order).catch((error) => {
      console.error(`New-order Telegram notification failed for ${order.orderId}:`, error.message);
    });
  });
}

async function activeResellerForCustomer(customer) {
  if (!customer) return null;
  const email = String(customer.email || '').toLowerCase();
  const reseller = await Reseller.findOne({ $or: [{ customerId: customer._id }, { email }] });
  return reseller?.status === 'active' ? reseller : null;
}

function ledgerBalances(entries) {
  return entries.reduce((balances, entry) => {
    const currency = String(entry.currency || 'BDT');
    const amount = Number(entry.amount || 0);
    balances[currency] = Math.round(((balances[currency] || 0) + amount) * 100) / 100;
    return balances;
  }, {});
}

function promoAmountFields(region) {
  if (region === 'bd') return { fixed: 'fixedBDT', min: 'minAmountBDT' };
  return { fixed: 'fixedUSDT', min: 'minAmountUSDT' };
}

function costSuffixForRegion(region) {
  if (region === 'bd') return 'BDT';
  return 'USDT';
}

function productCostForRegion(product, region, field) {
  const suffix = costSuffixForRegion(region);
  return Number(product?.[`${field}${suffix}`] || 0);
}

function normalizePromoCode(code) {
  return String(code || '').toUpperCase().trim();
}

function promoAvailabilityError(promo, productId, region, amount, { isReseller = false } = {}) {
  const now = new Date();
  if (!promo) return 'This promo code is not valid.';
  if (!promo.isActive) return 'This promo code is not active.';
  if (isReseller && promo.allowResellers !== true) return 'This promo code is not available for reseller accounts.';
  if (promo.startsAt && new Date(promo.startsAt) > now) return 'This promo code has not started yet.';
  if (promo.expiresAt && new Date(promo.expiresAt) < now) return 'This promo code has expired.';
  if (promo.maxUses > 0 && promo.usedCount >= promo.maxUses) return 'This promo code has reached its usage limit.';
  if (Array.isArray(promo.productIds) && promo.productIds.length && !promo.productIds.some((id) => String(id) === String(productId))) return 'This promo code is not valid for this product.';

  const { min } = promoAmountFields(region);
  if (Number(promo[min] || 0) > 0 && amount < Number(promo[min] || 0)) return 'Order amount is too low for this promo code.';
  return '';
}

function calculatePromoDiscount(promo, region, amount) {
  if (!promo) return 0;
  if (promo.discountType === 'percent') {
    return Math.min(amount, Math.round((amount * Number(promo.percentOff || 0)) / 100 * 100) / 100);
  }
  const { fixed } = promoAmountFields(region);
  return Math.min(amount, Number(promo[fixed] || 0));
}

async function applyPromoToPrice(code, productId, region, amount, { isReseller = false } = {}) {
  const normalized = normalizePromoCode(code);
  if (!normalized) return { discount: 0, promo: null };

  const promo = await PromoCode.findOne({ code: normalized });
  const error = promoAvailabilityError(promo, productId, region, amount, { isReseller });
  if (error) {
    const err = new Error(error);
    err.status = 400;
    err.publicMessage = error;
    throw err;
  }

  const discount = calculatePromoDiscount(promo, region, amount);
  return { discount, promo };
}

publicRouter.get('/health', (req, res) => {
  res.json({ ok: true, service: 'ai-digital-marketplace-api' });
});

// Privacy-safe traffic analytics. This deliberately stores no IP address,
// customer identity, or full referral URL.
publicRouter.post('/analytics/visit', asyncHandler(async (req, res) => {
  const data = visitorSchema.parse(req.body);
  let referrerHost = '';
  try { referrerHost = data.referrer ? new URL(data.referrer).hostname.slice(0, 180) : ''; } catch {}

  const visitor = await Visitor.findOne({ visitorId: data.visitorId });
  if (!visitor) {
    await Visitor.create({
      visitorId: data.visitorId,
      lastSessionId: data.sessionId,
      visitCount: 1,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      lastPath: data.path,
      referrerHost
    });
  } else {
    if (visitor.lastSessionId !== data.sessionId) visitor.visitCount = Number(visitor.visitCount || 0) + 1;
    visitor.lastSessionId = data.sessionId;
    visitor.lastSeenAt = new Date();
    visitor.lastPath = data.path;
    visitor.referrerHost = referrerHost;
    await visitor.save();
  }
  res.status(204).end();
}));

publicRouter.get('/auth/google/start', asyncHandler(async (req, res) => {
  requireGoogleConfig();
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', env.googleClientId);
  url.searchParams.set('redirect_uri', googleRedirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('prompt', 'select_account');
  url.searchParams.set('state', signGoogleState(req.query.returnTo, req.query.origin));
  res.redirect(url.toString());
}));

publicRouter.get('/auth/google/callback', asyncHandler(async (req, res) => {
  requireGoogleConfig();
  const { returnTo, frontendOrigin } = readGoogleState(req.query.state);
  if (!req.query.code || typeof req.query.code !== 'string') {
    return res.redirect(`${frontendOrigin}/auth/google/callback?error=missing_code&returnTo=${encodeURIComponent(returnTo)}`);
  }

  try {
    const accessToken = await exchangeGoogleCode(req.query.code);
    const profile = await fetchGoogleProfile(accessToken);
    const customer = await upsertGoogleCustomer(profile);
    const token = signCustomerToken(customer);

    const redirect = new URL(`${frontendOrigin}/auth/google/callback`);
    redirect.searchParams.set('token', token);
    redirect.searchParams.set('returnTo', returnTo);
    redirect.searchParams.set('name', customer.name || '');
    redirect.searchParams.set('email', customer.email || '');
    redirect.searchParams.set('picture', customer.picture || '');
    return res.redirect(redirect.toString());
  } catch (error) {
    console.error('Google login callback failed:', error?.message || error);
    const redirect = new URL(`${frontendOrigin}/auth/google/callback`);
    redirect.searchParams.set('error', 'google_login_failed');
    redirect.searchParams.set('returnTo', returnTo);
    return res.redirect(redirect.toString());
  }
}));

publicRouter.post('/auth/email/start', emailLoginStartLimiter, asyncHandler(async (req, res) => {
  const { email } = z.object({ email: z.string().email().max(120) }).parse(req.body);
  const normalizedEmail = email.toLowerCase().trim();
  const code = String(crypto.randomInt(100000, 1000000));
  const expiresMinutes = 10;

  await removeEmailChallenges(normalizedEmail);
  const challenge = await EmailLoginChallenge.create({
    email: normalizedEmail,
    codeHash: loginCodeHash(normalizedEmail, code),
    expiresAt: new Date(Date.now() + expiresMinutes * 60 * 1000),
    attempts: 0,
    createdAt: new Date()
  });

  queueCustomerLoginCode({ email: normalizedEmail, code, expiresMinutes })
    .then((mail) => {
      if (!mail.sent) console.error('Login code delivery failed:', mail.status || 'unknown mail status');
    })
    .catch((error) => {
      console.error('Login code delivery failed:', error?.message || error);
    });

  // SMTP delivery continues inside the same Node process. Returning now keeps
  // the browser responsive even when the mail server needs a few seconds.
  return res.status(202).json({ ok: true, expiresIn: expiresMinutes * 60, message: 'Your verification code is on the way.' });
}));

publicRouter.post('/auth/email/verify', emailLoginVerifyLimiter, asyncHandler(async (req, res) => {
  const data = z.object({
    email: z.string().email().max(120),
    code: z.string().regex(/^\d{6}$/)
  }).parse(req.body);
  const email = data.email.toLowerCase().trim();
  const challenge = await EmailLoginChallenge.findOne({ email }).sort({ createdAt: -1 });
  const invalid = !challenge || challenge.consumedAt || new Date(challenge.expiresAt).getTime() <= Date.now();
  if (invalid) {
    if (challenge) await EmailLoginChallenge.findByIdAndDelete(challenge._id);
    return res.status(400).json({ error: 'This code has expired. Request a new code.' });
  }

  challenge.attempts = Number(challenge.attempts || 0) + 1;
  if (challenge.attempts > 5 || loginCodeHash(email, data.code) !== challenge.codeHash) {
    if (challenge.attempts >= 5) await EmailLoginChallenge.findByIdAndDelete(challenge._id);
    else await challenge.save();
    return res.status(400).json({ error: challenge.attempts >= 5 ? 'Too many incorrect attempts. Request a new code.' : 'The verification code is incorrect.' });
  }

  await EmailLoginChallenge.findByIdAndDelete(challenge._id);
  let customer = await Customer.findOne({ email });
  if (!customer) customer = await Customer.create({ email, name: email.split('@')[0] });
  customer.email = email;
  customer.name = customer.name || email.split('@')[0];
  customer.authProvider = customer.googleId ? 'google_and_email' : 'email';
  customer.emailVerifiedAt = new Date();
  customer.lastLoginAt = new Date();
  customer.isActive = true;
  await customer.save();
  await linkCustomerData(customer);

  return res.json({ token: signCustomerToken(customer), customer: customerSafe(customer) });
}));

publicRouter.get('/auth/customer/me', requireCustomer, asyncHandler(async (req, res) => {
  res.json({ customer: customerSafe(req.customer) });
}));

publicRouter.get('/reseller/me', requireCustomer, asyncHandler(async (req, res) => {
  const reseller = await activeResellerForCustomer(req.customer);
  if (!reseller) return res.status(404).json({ error: 'No active reseller profile for this account' });
  const entries = await ResellerLedger.find({ resellerId: reseller._id }).sort({ createdAt: -1 }).lean();
  res.json({
    reseller: {
      id: reseller._id,
      name: reseller.name || req.customer.name || '',
      email: reseller.email,
      status: reseller.status,
      creditLimitBDT: Number(reseller.creditLimitBDT || 0),
      balances: ledgerBalances(entries)
    }
  });
}));

publicRouter.get('/reseller/statement', requireCustomer, asyncHandler(async (req, res) => {
  const reseller = await activeResellerForCustomer(req.customer);
  if (!reseller) return res.status(404).json({ error: 'No active reseller profile for this account' });
  const start = req.query.start ? new Date(String(req.query.start)) : null;
  const end = req.query.end ? new Date(`${String(req.query.end)}T23:59:59.999Z`) : null;
  const entries = (await ResellerLedger.find({ resellerId: reseller._id }).sort({ createdAt: -1 }).lean())
    .filter((entry) => (!start || new Date(entry.createdAt) >= start) && (!end || new Date(entry.createdAt) <= end));
  res.json({ entries, balances: ledgerBalances(entries) });
}));

// Resellers can accumulate hundreds of delivered accounts. This endpoint
// searches only their own reseller-credit orders by the assigned delivery
// email. Passwords, activation keys and mailbox data never leave this list API.
publicRouter.get('/reseller/orders', requireCustomer, asyncHandler(async (req, res) => {
  const reseller = await activeResellerForCustomer(req.customer);
  if (!reseller) return res.status(404).json({ error: 'No active reseller profile for this account' });

  const emailQuery = String(req.query.email || '').trim().toLowerCase().slice(0, 254);
  if (emailQuery.length < 3) {
    return res.status(400).json({ error: 'Enter at least 3 characters of the delivery email.' });
  }
  const orders = await Order.find({
    ...customerOrderAccessQuery(req.customer),
    paymentMethod: 'reseller_due'
  }).sort({ createdAt: -1 }).limit(500).lean();

  const stockIds = [...new Set(orders.map((order) => String(order.assignedStockItemId || '')).filter(Boolean))];
  const stocks = stockIds.length ? await StockItem.find({ _id: { $in: stockIds } }).lean() : [];
  const stockById = new Map(stocks.map((stock) => [String(stock._id), stock]));
  const matches = [];

  for (const order of orders) {
    const stock = stockById.get(String(order.assignedStockItemId || ''));
    let deliveryEmail = '';
    let deliveryMode = order.productSnapshot?.deliveryMode || '';
    if (stock?.encryptedPayload) {
      try {
        const payload = decryptJson(stock.encryptedPayload);
        deliveryEmail = String(payload?.email || '').trim().toLowerCase();
        deliveryMode = payload?.deliveryMode || stock.type || deliveryMode;
      } catch { deliveryEmail = ''; }
    }
    if (emailQuery && !deliveryEmail.includes(emailQuery)) continue;
    matches.push({
      ...publicOrderPayload(order, null),
      deliveryEmail,
      deliveryMode
    });
    if (matches.length >= 100) break;
  }

  res.json({ orders: matches, query: emailQuery });
}));

publicRouter.get('/reseller/payment-requests', requireCustomer, asyncHandler(async (req, res) => {
  const reseller = await activeResellerForCustomer(req.customer);
  if (!reseller) return res.status(404).json({ error: 'No active reseller profile for this account' });
  const requests = await ResellerPaymentRequest.find({ resellerId: reseller._id }).sort({ createdAt: -1 }).limit(100).lean();
  res.json({ requests });
}));

publicRouter.post('/reseller/payment-requests', requireCustomer, asyncHandler(async (req, res) => {
  const reseller = await activeResellerForCustomer(req.customer);
  if (!reseller) return res.status(404).json({ error: 'No active reseller profile for this account' });
  const data = z.object({ amount: z.number().positive().max(100000000), channel: z.enum(['bkash', 'nagad']), transactionId: z.string().min(4).max(200), note: z.string().max(1000).optional().default('') }).parse(req.body);
  const invoices = await ResellerInvoice.find({ resellerId: reseller._id, currency: 'BDT', status: { $in: ['open', 'partial'] } }).lean();
  const due = invoices.reduce((sum, invoice) => sum + Number(invoice.remainingAmount || 0), 0);
  if (!due) return res.status(409).json({ error: 'There is no BDT due to pay.' });
  if (Math.abs(Number(data.amount) - due) > 0.01) return res.status(409).json({ error: `Please submit the exact open due (${due} BDT). Partial payments are handled by the owner.` });
  const duplicate = await ResellerPaymentRequest.findOne({ status: 'pending', transactionId: data.transactionId.trim() }).lean();
  if (duplicate) return res.status(409).json({ error: 'This transaction ID is already waiting for review.' });
  const request = await ResellerPaymentRequest.create({ resellerId: reseller._id, amount: data.amount, currency: 'BDT', channel: data.channel, transactionId: data.transactionId.trim(), note: data.note, status: 'pending' });
  await notifyResellerPaymentRequest(request.toObject(), reseller);
  res.status(201).json({ request: request.toObject(), message: 'Payment submitted for owner review.' });
}));

publicRouter.get('/region', asyncHandler(async (req, res) => {
  const { country, region } = await detectRegion(req, req.query.region, req.query.country);
  res.json({ country, region });
}));

publicRouter.get('/products', optionalCustomer, asyncHandler(async (req, res) => {
  const { region } = await storefrontRegion(req);
  let products = await Product.find({ isActive: true }).sort({ sortOrder: 1, createdAt: -1 }).lean();
  const reseller = await activeResellerForCustomer(req.customer);
  const accessMap = new Map();
  if (reseller) {
    const accesses = await ResellerProductAccess.find({ resellerId: reseller._id, isVisible: true }).lean();
    for (const access of accesses) accessMap.set(String(access.productId), access);
    products = products.filter((product) => accessMap.has(String(product._id)));
  }

  const [stockCounts, availableStockItems, pendingBackorderCounts] = await Promise.all([
    StockItem.aggregate([
      { $match: { status: 'available' } },
      { $group: { _id: '$productId', count: { $sum: 1 } } }
    ]),
    StockItem.find({ status: 'available' }).sort({ createdAt: 1 }).lean(),
    Order.aggregate([
      { $match: { status: 'pending', assignedStockItemId: null, 'fulfillment.isBackorder': true } },
      { $group: { _id: '$productId', count: { $sum: 1 } } }
    ])
  ]);
  const stockMap = new Map(stockCounts.map((item) => [item._id.toString(), item.count]));
  const nextStockTypeMap = new Map();
  for (const stock of availableStockItems) {
    const productId = String(stock.productId);
    if (!nextStockTypeMap.has(productId)) nextStockTypeMap.set(productId, stock.type);
  }
  const pendingBackorderMap = new Map(pendingBackorderCounts.map((item) => [item._id.toString(), item.count]));

  // The oldest available stock item is exactly what fulfilment will allocate,
  // so expose its delivery type to checkout instead of guessing from the
  // product record or from some unrelated stock item.
  res.json({ products: products.map((p) => {
    const actualStock = Number(stockMap.get(p._id.toString()) || 0);
    const backorderAvailable = Math.max(0, configuredBackorder(p) - Number(pendingBackorderMap.get(p._id.toString()) || 0));
    const deliveryMode = nextStockTypeMap.get(p._id.toString()) || p.deliveryMode;
    return publicProduct({ ...p, actualStock, backorderAvailable, deliveryMode }, actualStock + backorderAvailable, region, accessMap.get(String(p._id)) || null);
  }), region, reseller: reseller ? { active: true, name: reseller.name || req.customer?.name || '', email: reseller.email } : null });
}));

publicRouter.get('/products/:slug', optionalCustomer, asyncHandler(async (req, res) => {
  const { region } = await storefrontRegion(req);
  const product = await Product.findOne({ slug: req.params.slug, isActive: true }).lean();
  if (!product) return res.status(404).json({ error: 'Product not found' });
  const reseller = await activeResellerForCustomer(req.customer);
  const access = reseller ? await ResellerProductAccess.findOne({ resellerId: reseller._id, productId: product._id, isVisible: true }).lean() : null;
  if (reseller && !access) return res.status(404).json({ error: 'Product not available for this reseller' });
  const [capacity, nextStock] = await Promise.all([
    stockCapacity(product),
    nextAvailableStock(product._id)
  ]);
  const deliveryMode = nextStock?.type || product.deliveryMode;
  res.json({ product: publicProduct({ ...product, actualStock: capacity.actualStock, backorderAvailable: capacity.backorderAvailable, deliveryMode }, capacity.sellable, region, access), region, reseller: reseller ? { active: true, name: reseller.name || req.customer?.name || '', email: reseller.email } : null });
}));

publicRouter.get('/payment-methods', asyncHandler(async (req, res) => {
  const methods = await PaymentMethod.find({ isActive: true, key: { $in: ['bangladesh', 'pakistan', 'binance'] } }).sort({ key: 1 }).lean();
  res.json({ methods });
}));

publicRouter.post('/promo/validate', optionalCustomer, asyncHandler(async (req, res) => {
  const data = z.object({
    code: z.string().min(1).max(40),
    productId: z.string().refine((value) => validator.isMongoId(value), { message: 'Invalid product ID' }),
    priceRegion: z.enum(['bd', 'pk', 'world'])
  }).parse(req.body);

  const product = await Product.findOne({ _id: data.productId, isActive: true }).lean();
  if (!product) return res.status(404).json({ error: 'Product not found' });
  const isFreeOrder = product.isFree === true;

  const price = priceForRegion(product, data.priceRegion);
  const reseller = await activeResellerForCustomer(req.customer);
  const { discount, promo } = await applyPromoToPrice(data.code, product._id, data.priceRegion, Number(price.amount || 0), { isReseller: Boolean(reseller) });

  res.json({
    valid: true,
    code: promo.code,
    description: promo.description || '',
    discountType: promo.discountType,
    percentOff: promo.percentOff || 0,
    discount,
    originalAmount: Number(price.amount || 0),
    finalAmount: Math.max(0, Math.round((Number(price.amount || 0) - discount) * 100) / 100)
  });
}));

// Only promos explicitly enabled by the owner are exposed on the storefront.
// Checkout still performs the final availability and usage-limit validation.
publicRouter.get('/promo/homepage', optionalCustomer, asyncHandler(async (req, res) => {
  const now = new Date();
  const reseller = await activeResellerForCustomer(req.customer);
  const promos = await PromoCode.find({ isActive: true, showOnHomepage: true }).sort({ updatedAt: -1, createdAt: -1 }).lean();
  res.json({ promos: promos.filter((promo) => {
    if (reseller && promo.allowResellers !== true) return false;
    if (promo.startsAt && new Date(promo.startsAt) > now) return false;
    if (promo.expiresAt && new Date(promo.expiresAt) < now) return false;
    return !(promo.maxUses > 0 && promo.usedCount >= promo.maxUses);
  }).slice(0, 3).map((promo) => ({
    code: promo.code,
    discountType: promo.discountType,
    percentOff: promo.percentOff || 0,
    fixedBDT: promo.fixedBDT || 0,
    fixedPKR: promo.fixedPKR || 0,
    fixedUSDT: promo.fixedUSDT || 0,
    productIds: (promo.productIds || []).map(String)
  })) });
}));

publicRouter.post('/orders', orderLimiter, requireCustomer, asyncHandler(async (req, res) => {
  const data = createOrderSchema.parse(req.body);

  if (!validator.isMongoId(data.productId)) {
    return res.status(400).json({ error: 'Invalid product ID' });
  }

  const product = await Product.findOne({ _id: data.productId, isActive: true }).lean();
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const [capacity, nextStock] = await Promise.all([
    stockCapacity(product),
    nextAvailableStock(product._id)
  ]);
  if (capacity.sellable <= 0) return res.status(409).json({ error: 'This product is out of stock' });
  const isBackorder = capacity.actualStock <= 0;
  const effectiveDeliveryMode = nextStock?.type || product.deliveryMode || 'credentials';
  const manualDelivery = effectiveDeliveryMode === 'manual';
  const manualValidationError = manualDelivery ? validateManualActivation(data.manualActivation, [product]) : '';
  if (manualValidationError) return res.status(400).json({ error: manualValidationError });

  const { country, region: detectedRegion } = await detectRegion(req, data.priceRegion);
  const reseller = await activeResellerForCustomer(req.customer);
  const requestedResellerOrder = data.paymentMethod === 'reseller_due';
  if (requestedResellerOrder && !reseller) return res.status(403).json({ error: 'This Google account is not an active reseller' });
  const finalPriceRegion = (requestedResellerOrder || data.paymentMethod === 'free') ? (['bd', 'pk', 'world'].includes(data.priceRegion) ? data.priceRegion : detectedRegion) : priceRegionForPaymentMethod(data.paymentMethod, detectedRegion);
  const access = requestedResellerOrder ? await ResellerProductAccess.findOne({ resellerId: reseller._id, productId: product._id, isVisible: true }).lean() : null;
  if (requestedResellerOrder && !access) return res.status(403).json({ error: 'This product is not available for this reseller' });
  const price = requestedResellerOrder ? resellerPriceForRegion(access, product, finalPriceRegion) : priceForRegion(product, finalPriceRegion);
  const isFreeOrder = isFreeProductPrice(product, price);
  let freeClaimLock = null;
  if (data.paymentMethod === 'free' && !isFreeOrder) return res.status(400).json({ error: 'Free checkout is available only for products with a zero price.' });
  if (isFreeOrder) {
    try {
      await assertFreeProductAvailableForCustomer(req.customer);
      freeClaimLock = lockFreeClaim(req.customer);
    } catch (error) {
      return res.status(error.status || 409).json({ error: error.message });
    }
  }
  const isResellerOrder = !isFreeOrder && requestedResellerOrder;
  if (!isFreeOrder && !isResellerOrder && data.transactionId.trim().length < 4) return res.status(400).json({ error: 'A valid payment transaction ID is required' });

  if (!isFreeOrder && !isResellerOrder) {
    const allowedMethods = allowedPaymentMethods(detectedRegion);
    if (!allowedMethods.includes(data.paymentMethod)) return res.status(400).json({ error: `This region can use only: ${allowedMethods.join(', ')}` });
  }

  const duplicateQuery = [];
  if (data.transactionId.trim()) duplicateQuery.push({ transactionId: data.transactionId.trim() });
  if (data.customerOrderRef?.trim()) duplicateQuery.push({ customerOrderRef: data.customerOrderRef.trim() });
  const duplicate = duplicateQuery.length ? await Order.findOne({ $or: duplicateQuery }).lean() : null;
  if (duplicate) {
    return res.status(409).json({ error: 'This transaction/order reference is already submitted. Use Track Your Orders to check status.' });
  }
  if (!isFreeOrder && !isResellerOrder) {
    const method = await PaymentMethod.findOne({ key: data.paymentMethod, isActive: true }).lean();
    if (!method) return res.status(400).json({ error: 'Payment method is not active' });
  }
  const promoResult = await applyPromoToPrice(data.promoCode, product._id, finalPriceRegion, Number(price.amount || 0), { isReseller: Boolean(reseller) });
  const finalAmount = isFreeOrder ? 0 : Math.max(0, Math.round((Number(price.amount || 0) - promoResult.discount) * 100) / 100);
  if (isResellerOrder && price.currency === 'BDT' && Number(reseller.creditLimitBDT || 0) > 0) {
    const balances = ledgerBalances(await ResellerLedger.find({ resellerId: reseller._id, currency: 'BDT' }).lean());
    if (Number(balances.BDT || 0) + finalAmount > Number(reseller.creditLimitBDT)) return res.status(409).json({ error: `Credit limit reached. Current due: ${balances.BDT || 0} BDT` });
  }
  const accessToken = createAccessToken();
  const orderId = createOrderId();
  let order = await Order.create({
    orderId,
    productId: product._id,
    customerId: req.customer?._id || null,
    productSnapshot: {
      title: product.title,
      logoUrl: product.imageUrl || '',
      icon: product.icon || '✨',
      deliveryMode: effectiveDeliveryMode,
      manualInputMode: manualInputMode(product),
      backorder: isBackorder,
      deliveryInstruction: product.deliveryInstruction || '',
      deliveryVideoUrl: product.deliveryVideoUrl || '',
      deliveryImageUrl: product.deliveryImageUrl || '',
      price: finalAmount,
      originalAmount: Number(price.amount || 0),
      discountAmount: promoResult.discount,
      currency: price.currency,
      priceRegion: finalPriceRegion,
      purchaseCost: productCostForRegion(product, finalPriceRegion, 'purchaseCost'),
      accountCost: productCostForRegion(product, finalPriceRegion, 'accountCost'),
      paymentGatewayFee: productCostForRegion(product, finalPriceRegion, 'paymentGatewayFee'),
      otherExpense: productCostForRegion(product, finalPriceRegion, 'otherExpense')
    },
    customer: {
      name: data.customer.name.trim() || req.customer.name || '',
      email: req.customer.email,
      whatsapp: data.customer.whatsapp?.trim() || ''
    },
    paymentMethod: isFreeOrder ? 'free' : (isResellerOrder ? 'reseller_due' : data.paymentMethod),
    priceRegion: finalPriceRegion,
    detectedCountry: country,
    transactionId: isFreeOrder ? `FREE-${orderId}` : data.transactionId.trim(),
    customerOrderRef: data.customerOrderRef?.trim() || '',
    paymentNote: data.paymentNote,
    status: 'pending',
    fulfillment: { isBackorder, deliveryDetailsAddedAt: null, note: isBackorder ? 'Waiting for admin delivery details' : '' },
    manualActivationEncrypted: manualDelivery ? encryptJson({ email: data.manualActivation.email.trim(), password: data.manualActivation.password || '', mode: manualInputMode(product) }) : null,
    manualActivationSubmittedAt: manualDelivery ? new Date() : null,
    accessTokenHash: sha256(accessToken),
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'] || ''
  });

  if (!isFreeOrder && promoResult.promo) {
    await PromoCode.updateOne({ _id: promoResult.promo._id }, { $inc: { usedCount: 1 } });
  }
  if (isResellerOrder) {
    await ResellerLedger.create({
      resellerId: reseller._id,
      orderId: order.orderId,
      kind: 'order_charge',
      currency: price.currency,
      amount: finalAmount,
      note: `Reseller order: ${product.title}`
    });
    await ResellerInvoice.create({
      resellerId: reseller._id,
      orderId: order.orderId,
      productTitle: product.title,
      currency: price.currency,
      originalAmount: finalAmount,
      remainingAmount: finalAmount,
      status: 'open'
    });
  }

  let fulfillment = { order, autoDelivered: false };
  if (isFreeOrder) {
    fulfillment = await fulfillFreeOrderIfEligible(order);
    order = fulfillment.order;
  } else if (isResellerOrder) {
    fulfillment = await fulfillResellerOrderIfEligible(order);
    order = fulfillment.order;
  } else {
    queueNewOrderNotification(order);
  }

  if (freeClaimLock) activeFreeClaims.delete(freeClaimLock);
  res.status(201).json({
    message: isFreeOrder
      ? (fulfillment.autoDelivered ? 'Free order delivered automatically.' : 'Free order submitted. It is waiting for fulfilment.')
      : isResellerOrder
      ? (fulfillment.autoDelivered ? 'Reseller order delivered automatically. The amount was added to your due balance.' : (isBackorder ? 'Reseller backorder submitted. It is waiting for delivery details and the amount was added to your due balance.' : 'Reseller order submitted. The amount was added to your due balance.'))
      : 'Order submitted. Waiting for admin approval.',
    order: {
      orderId: order.orderId,
      status: order.status,
      productTitle: product.title,
      amount: finalAmount,
      currency: price.currency,
      priceRegion: finalPriceRegion,
      paymentMethod: isFreeOrder ? 'free' : data.paymentMethod,
      transactionId: order.transactionId,
      customerOrderRef: order.customerOrderRef
    },
    accessToken
  });
}));

publicRouter.post('/orders/batch', orderLimiter, requireCustomer, asyncHandler(async (req, res) => {
  const data = createOrderBatchSchema.parse(req.body);
  const checkoutRequestId = data.clientRequestId.trim();
  const requestKey = checkoutRequestId ? `${req.customer?._id || req.customer?.email}:${checkoutRequestId}` : '';
  let activeKey = '';
  if (checkoutRequestId) {
    if (activeCheckoutRequests.has(requestKey)) {
      return res.status(409).json({ error: 'This order is already being submitted. Please wait a moment.' });
    }
    const previousOrders = await Order.find({
      customerId: req.customer?._id || null,
      checkoutRequestId
    }).sort({ createdAt: 1 });
    if (previousOrders.length) {
      const replayed = [];
      for (const order of previousOrders) {
        const accessToken = createAccessToken();
        order.accessTokenHash = sha256(accessToken);
        await order.save();
        replayed.push({ order, accessToken });
      }
      const totalAmount = replayed.reduce((sum, item) => sum + Number(item.order.productSnapshot?.price || 0), 0);
      return res.status(200).json({
        message: 'This checkout was already submitted. Returning the original order.',
        batchId: replayed[0]?.order.batchId || '',
        totalAmount,
        currency: replayed[0]?.order.productSnapshot?.currency || 'USDT',
        orders: replayed.map(({ order, accessToken }) => ({
          orderId: order.orderId,
          productTitle: order.productSnapshot?.title || 'Product',
          amount: order.productSnapshot?.price || 0,
          currency: order.productSnapshot?.currency || 'USDT',
          status: order.status,
          accessToken
        }))
      });
    }

  }
  const grouped = new Map();
  for (const item of data.items) {
    if (!validator.isMongoId(item.productId)) return res.status(400).json({ error: 'Invalid product ID' });
    grouped.set(item.productId, Number(grouped.get(item.productId) || 0) + item.quantity);
  }
  const items = Array.from(grouped, ([productId, quantity]) => ({ productId, quantity }));
  if (items.some((item) => item.quantity > 20)) return res.status(400).json({ error: 'Maximum quantity is 20 per product' });
  if (data.promoCode.trim() && items.reduce((sum, item) => sum + item.quantity, 0) > 1) return res.status(400).json({ error: 'Promo codes can be used only for a single-account checkout' });

  const reseller = await activeResellerForCustomer(req.customer);
  const isResellerOrder = data.paymentMethod === 'reseller_due';
  if (isResellerOrder && !reseller) return res.status(403).json({ error: 'This Google account is not an active reseller' });

  const { country, region: detectedRegion } = await detectRegion(req, data.priceRegion);
  if (!isResellerOrder && data.paymentMethod !== 'free') {
    const allowedMethods = allowedPaymentMethods(detectedRegion);
    if (!allowedMethods.includes(data.paymentMethod)) return res.status(400).json({ error: `This region can use only: ${allowedMethods.join(', ')}` });
    const method = await PaymentMethod.findOne({ key: data.paymentMethod, isActive: true }).lean();
    if (!method) return res.status(400).json({ error: 'Payment method is not active' });
  }

  const duplicateQuery = [];
  if (data.transactionId.trim()) duplicateQuery.push({ transactionId: data.transactionId.trim() });
  if (data.customerOrderRef.trim()) duplicateQuery.push({ customerOrderRef: data.customerOrderRef.trim() });
  if (duplicateQuery.length && await Order.findOne({ $or: duplicateQuery }).lean()) {
    return res.status(409).json({ error: 'This transaction/order reference is already submitted. Use Track Your Orders to check status.' });
  }

  const finalPriceRegion = (isResellerOrder || data.paymentMethod === 'free') ? (['bd', 'pk', 'world'].includes(data.priceRegion) ? data.priceRegion : detectedRegion) : priceRegionForPaymentMethod(data.paymentMethod, detectedRegion);
  const prepared = [];
  for (const item of items) {
    const product = await Product.findOne({ _id: item.productId, isActive: true }).lean();
    if (!product) return res.status(404).json({ error: 'A selected product is no longer available' });
    const [capacity, nextStock] = await Promise.all([
      stockCapacity(product),
      nextAvailableStock(product._id)
    ]);
    if (capacity.sellable < item.quantity) return res.status(409).json({ error: `${product.title} has only ${capacity.sellable} account(s) available` });
    const access = isResellerOrder ? await ResellerProductAccess.findOne({ resellerId: reseller._id, productId: product._id, isVisible: true }).lean() : null;
    if (isResellerOrder && !access) return res.status(403).json({ error: `${product.title} is not available for this reseller` });
    const price = isResellerOrder ? resellerPriceForRegion(access, product, finalPriceRegion) : priceForRegion(product, finalPriceRegion);
    const promoResult = await applyPromoToPrice(data.promoCode, product._id, finalPriceRegion, Number(price.amount || 0), { isReseller: Boolean(reseller) });
    const deliveryMode = nextStock?.type || product.deliveryMode || 'credentials';
    const isFree = isFreeProductPrice(product, price);
    prepared.push({ product, quantity: item.quantity, price, promoResult, isFree, actualAvailable: capacity.actualStock, deliveryMode, manualDelivery: deliveryMode === 'manual', finalAmount: isFree ? 0 : Math.max(0, Math.round((Number(price.amount || 0) - promoResult.discount) * 100) / 100) });
  }
  const allFree = prepared.length > 0 && prepared.every((item) => item.isFree);
  if (data.paymentMethod === 'free' && !allFree) return res.status(400).json({ error: 'Free checkout can contain only products with a zero price.' });
  const freeQuantity = prepared.reduce((sum, item) => sum + (item.isFree ? item.quantity : 0), 0);
  let freeClaimLock = null;
  if (freeQuantity > 1) return res.status(400).json({ error: 'One user can take only one free product.' });
  if (freeQuantity === 1) {
    try {
      await assertFreeProductAvailableForCustomer(req.customer);
      freeClaimLock = lockFreeClaim(req.customer);
    } catch (error) {
      return res.status(error.status || 409).json({ error: error.message });
    }
  }
  if (!isResellerOrder && !allFree && data.paymentMethod !== 'free' && data.transactionId.trim().length < 4) return res.status(400).json({ error: 'A valid payment transaction ID is required' });
  const manualPrepared = prepared.filter((item) => item.manualDelivery).map((item) => item.product);
  const manualValidationError = manualPrepared.length ? validateManualActivation(data.manualActivation, manualPrepared) : '';
  if (manualValidationError) return res.status(400).json({ error: manualValidationError });
  const currency = prepared[0]?.price?.currency;
  if (!prepared.every((item) => item.price.currency === currency)) return res.status(400).json({ error: 'Selected products use different currencies. Please submit them separately.' });
  const totalAmount = prepared.reduce((sum, item) => sum + (item.finalAmount * item.quantity), 0);
  if (isResellerOrder && currency === 'BDT' && Number(reseller.creditLimitBDT || 0) > 0) {
    const balances = ledgerBalances(await ResellerLedger.find({ resellerId: reseller._id, currency: 'BDT' }).lean());
    if (Number(balances.BDT || 0) + totalAmount > Number(reseller.creditLimitBDT)) return res.status(409).json({ error: `Credit limit reached. Current due: ${balances.BDT || 0} BDT` });
  }

  // Claim the checkout only after every validation has passed.  Do not release
  // this lock when the browser connection closes: slow reseller fulfilment can
  // outlive the client's HTTP timeout, and releasing on `close` allowed a
  // second click to create the same order again.  The explicit completion
  // release below handles normal requests; the timer is a crash safety net.
  if (checkoutRequestId) {
    activeKey = requestKey;
    if (activeCheckoutRequests.has(activeKey)) {
      return res.status(409).json({ error: 'This order is already being submitted. Please wait a moment.' });
    }
    activeCheckoutRequests.add(activeKey);
    const expiry = setTimeout(() => activeCheckoutRequests.delete(activeKey), 2 * 60 * 1000);
    expiry.unref?.();
  }

  const batchId = `BATCH-${Date.now().toString(36).toUpperCase()}-${createAccessToken().slice(0, 6).toUpperCase()}`;
  const created = [];
  for (const item of prepared) {
    for (let number = 0; number < item.quantity; number += 1) {
      const isBackorder = number >= Number(item.actualAvailable || 0);
      const accessToken = createAccessToken();
      const orderId = createOrderId();
      let order = await Order.create({
        orderId, batchId, productId: item.product._id, customerId: req.customer?._id || null,
        checkoutRequestId,
        productSnapshot: {
          title: item.product.title, logoUrl: item.product.imageUrl || '', icon: item.product.icon || '✨',
          deliveryMode: item.deliveryMode,
          deliveryInstruction: item.product.deliveryInstruction || '',
          deliveryVideoUrl: item.product.deliveryVideoUrl || '',
          deliveryImageUrl: item.product.deliveryImageUrl || '',
          manualInputMode: manualInputMode(item.product),
          backorder: isBackorder,
          price: item.finalAmount, originalAmount: Number(item.price.amount || 0), discountAmount: item.promoResult.discount,
          currency: item.price.currency, priceRegion: finalPriceRegion,
          purchaseCost: productCostForRegion(item.product, finalPriceRegion, 'purchaseCost'), accountCost: productCostForRegion(item.product, finalPriceRegion, 'accountCost'),
          paymentGatewayFee: productCostForRegion(item.product, finalPriceRegion, 'paymentGatewayFee'), otherExpense: productCostForRegion(item.product, finalPriceRegion, 'otherExpense')
        },
        customer: { name: data.customer.name.trim() || req.customer.name || '', email: req.customer.email, whatsapp: data.customer.whatsapp?.trim() || '' },
        paymentMethod: item.isFree ? 'free' : (isResellerOrder ? 'reseller_due' : data.paymentMethod), priceRegion: finalPriceRegion, detectedCountry: country,
        transactionId: item.isFree ? `FREE-${orderId}` : data.transactionId.trim(), customerOrderRef: data.customerOrderRef.trim() || '', paymentNote: data.paymentNote,
        status: 'pending',
        fulfillment: { isBackorder, deliveryDetailsAddedAt: null, note: isBackorder ? 'Waiting for admin delivery details' : '' },
        manualActivationEncrypted: item.manualDelivery ? encryptJson({ email: data.manualActivation.email.trim(), password: data.manualActivation.password || '', mode: manualInputMode(item.product) }) : null,
        manualActivationSubmittedAt: item.manualDelivery ? new Date() : null,
        accessTokenHash: sha256(accessToken), ipAddress: req.ip, userAgent: req.headers['user-agent'] || ''
      });
      if (isResellerOrder && !item.isFree) {
        await ResellerLedger.create({ resellerId: reseller._id, orderId: order.orderId, kind: 'order_charge', currency: item.price.currency, amount: item.finalAmount, note: `Reseller order: ${item.product.title}` });
        await ResellerInvoice.create({ resellerId: reseller._id, orderId: order.orderId, productTitle: item.product.title, currency: item.price.currency, originalAmount: item.finalAmount, remainingAmount: item.finalAmount, status: 'open' });
      }
      if (item.isFree) {
        const fulfillment = await fulfillFreeOrderIfEligible(order);
        order = fulfillment.order;
      } else if (isResellerOrder) {
        const fulfillment = await fulfillResellerOrderIfEligible(order);
        order = fulfillment.order;
      } else {
        queueNewOrderNotification(order);
      }
      created.push({ order, accessToken });
    }
    if (!item.isFree && item.promoResult.promo) await PromoCode.updateOne({ _id: item.promoResult.promo._id }, { $inc: { usedCount: 1 } });
  }

  if (activeKey) activeCheckoutRequests.delete(activeKey);
  if (freeClaimLock) activeFreeClaims.delete(freeClaimLock);
  res.status(201).json({
    message: allFree ? 'Free order submitted. Eligible products were delivered automatically.' : (isResellerOrder ? 'Reseller orders submitted. Eligible non-manual products were delivered automatically; manual products await activation.' : 'Orders submitted. Waiting for admin approval.'),
    batchId, totalAmount, currency,
    orders: created.map(({ order, accessToken }) => ({ orderId: order.orderId, productTitle: order.productSnapshot.title, amount: order.productSnapshot.price, currency: order.productSnapshot.currency, status: order.status, accessToken }))
  });
}));

function publicOrderPayload(order, delivery = null) {
  return {
    orderId: order.orderId,
    status: order.status,
    product: order.productSnapshot,
    productTitle: order.productSnapshot?.title || 'Product',
    amount: order.productSnapshot?.price || 0,
    currency: order.productSnapshot?.currency || 'USDT',
    paymentMethod: order.paymentMethod,
    priceRegion: order.priceRegion,
    transactionId: order.transactionId,
    customerOrderRef: order.customerOrderRef || '',
    batchId: order.batchId || '',
    customer: {
      name: order.customer?.name || '',
      email: order.customer?.email || '',
      whatsapp: order.customer?.whatsapp || ''
    },
    createdAt: order.createdAt,
    reviewedAt: order.reviewedAt,
    approvedByNickname: order.approvedByNickname || '',
    deliveredByNickname: order.deliveredByNickname || '',
    rejectedByNickname: order.rejectedByNickname || '',
    cancelledByNickname: order.cancelledByNickname || '',
    reviewedByNickname: order.reviewedByNickname || '',
    rejectReason: order.rejectReason || null,
    cancelReason: order.cancelReason || null,
    cancelledAt: order.cancelledAt || null,
    manualActivationRequired: order.productSnapshot?.deliveryMode === 'manual',
    manualActivationSubmitted: Boolean(order.manualActivationSubmittedAt),
    manualActivationActivated: Boolean(order.manualActivationActivatedAt),
    deliveryAvailable: ['approved', 'delivered'].includes(order.status) && !!order.assignedStockItemId,
    delivery
  };
}

function loginCodeAccessState(order, stock, payload) {
  const deliveryMode = payload?.deliveryMode || stock?.type;
  if (deliveryMode !== 'login_code') return payload;
  const days = Math.min(3650, Math.max(1, Math.floor(Number(payload?.getCodeAccessDays || order?.getCodeAccessDays || 25))));
  const startAt = stock?.createdAt || order?.createdAt || order?.approvedAt || order?.deliveredAt || order?.reviewedAt || new Date();
  const configuredExpiry = payload?.getCodeAccessExpiresAt ? new Date(payload.getCodeAccessExpiresAt) : null;
  const calculatedStockExpiry = new Date(new Date(startAt).getTime() + days * 24 * 60 * 60 * 1000);
  const expiryCandidates = [order?.getCodeAccessExpiresAt, configuredExpiry, calculatedStockExpiry]
    .map((value) => value ? new Date(value) : null)
    .filter((value) => value && Number.isFinite(value.getTime()));
  const expiresAt = new Date(Math.min(...expiryCandidates.map((value) => value.getTime())));
  return {
    ...payload,
    getCodeAccessDays: days,
    getCodeAccessExpiresAt: new Date(expiresAt).toISOString(),
    canFetchLoginCode: Date.now() < new Date(expiresAt).getTime()
  };
}

async function deliveryWithProductDefaults(order, stock, payload) {
  const product = await Product.findById(order.productId)
    .select('deliveryInstruction deliveryVideoUrl deliveryImageUrl')
    .lean()
    .catch(() => null);
  const instruction = payload?.instruction || payload?.instructions || order.productSnapshot?.deliveryInstruction || product?.deliveryInstruction || '';
  return {
    ...(payload || {}),
    deliveryMode: payload?.deliveryMode || stock?.type || order.productSnapshot?.deliveryMode || 'credentials',
    instruction,
    instructions: payload?.instructions || instruction,
    videoUrl: payload?.videoUrl || order.productSnapshot?.deliveryVideoUrl || product?.deliveryVideoUrl || '',
    imageUrl: payload?.imageUrl || order.productSnapshot?.deliveryImageUrl || product?.deliveryImageUrl || ''
  };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripHtml(value = '') {
  return String(value)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLoginCode(message) {
  const bodyContent = message?.body?.content ? stripHtml(message.body.content) : '';
  const text = [
    message?.subject || '',
    message?.bodyPreview || '',
    bodyContent
  ].join(' ');

  const patterns = [
    /\b(?:verification|security|login|sign[-\s]?in|one[-\s]?time|otp|code)\D{0,60}([0-9]{4,8})\b/i,
    /\b([0-9]{4,8})\D{0,60}(?:verification|security|login|sign[-\s]?in|one[-\s]?time|otp|code)\b/i,
    /\b(?:verification|security|login|sign[-\s]?in|one[-\s]?time|otp|code)\D{0,60}((?=[A-Z0-9]{6,10}\b)(?=[A-Z0-9]*[0-9])[A-Z0-9]+)\b/i,
    /\b((?=[A-Z0-9]{6,10}\b)(?=[A-Z0-9]*[0-9])[A-Z0-9]+)\b/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

async function requestMicrosoftAccessToken(account) {
  const body = new URLSearchParams({
    client_id: account.clientId,
    refresh_token: account.refreshToken,
    grant_type: 'refresh_token',
    redirect_uri: 'https://login.live.com/oauth20_desktop.srf'
  });

  const endpoints = [
    'https://login.live.com/oauth20_token.srf',
    'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
    'https://login.microsoftonline.com/common/oauth2/v2.0/token'
  ];

  let lastError = 'Microsoft token refresh failed';
  for (const endpoint of endpoints) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const json = await response.json().catch(() => ({}));
    if (response.ok && json.access_token) return json.access_token;
    lastError = json.error_description || json.error || lastError;
  }

  const err = new Error(lastError);
  err.status = 502;
  err.publicMessage = 'Could not connect to this mailbox. Check the TXT refresh token/client id.';
  throw err;
}

async function fetchLatestMailboxMessages(account) {
  const accessToken = await requestMicrosoftAccessToken(account);
  const url = new URL('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages');
  url.searchParams.set('$top', '10');
  url.searchParams.set('$orderby', 'receivedDateTime desc');
  url.searchParams.set('$select', 'id,sender,toRecipients,ccRecipients,bccRecipients,subject,receivedDateTime,bodyPreview,body');

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(json.error?.message || 'Microsoft inbox read failed');
    err.status = 502;
    err.publicMessage = 'Could not read the mailbox inbox right now.';
    throw err;
  }
  return Array.isArray(json.value) ? json.value : [];
}

function normalizeMailTxtLookupEmail(email) {
  const clean = String(email || '').toLowerCase().trim();
  const atIndex = clean.indexOf('@');
  if (atIndex <= 0) return clean;

  const localPart = clean.slice(0, atIndex);
  const domain = clean.slice(atIndex);
  const plusIndex = localPart.indexOf('+');
  const normalizedLocalPart = plusIndex >= 0 ? localPart.slice(0, plusIndex) : localPart;
  return `${normalizedLocalPart}${domain}`;
}

function normalizeExactRecipientEmail(email) {
  return String(email || '').toLowerCase().trim();
}

function messageWasSentToEmail(message, email) {
  const targetEmail = normalizeExactRecipientEmail(email);
  if (!targetEmail) return false;

  const recipients = [
    ...(Array.isArray(message?.toRecipients) ? message.toRecipients : []),
    ...(Array.isArray(message?.ccRecipients) ? message.ccRecipients : []),
    ...(Array.isArray(message?.bccRecipients) ? message.bccRecipients : [])
  ];

  return recipients.some((recipient) => {
    const address = recipient?.emailAddress?.address || recipient?.address || '';
    return normalizeExactRecipientEmail(address) === targetEmail;
  });
}

async function findMailTxtAccount(email) {
  const targetEmail = normalizeMailTxtLookupEmail(email);
  if (!targetEmail) return null;

  const files = await MailTxtFile.find().sort({ createdAt: -1 }).lean();
  for (const file of files) {
    let accounts = [];
    try {
      accounts = decryptJson(file.encryptedAccounts);
    } catch {
      accounts = [];
    }

    const account = Array.isArray(accounts)
      ? accounts.find((item) => normalizeMailTxtLookupEmail(item.email) === targetEmail)
      : null;
    if (account) return { ...account, fileName: file.name };
  }
  return null;
}

publicRouter.post('/track-orders', asyncHandler(async (req, res) => {
  const { code } = z.object({ code: z.string().min(3).max(160) }).parse(req.body);
  const clean = code.trim();
  const exact = new RegExp(`^${escapeRegex(clean)}$`, 'i');
  const orders = await Order.find({
    $or: [
      { orderId: exact },
      { transactionId: exact },
      { customerOrderRef: exact }
    ]
  }).sort({ createdAt: -1 }).limit(10);

  const results = [];
  for (const order of orders) {
    await latchManualDeliveryMode(order);
    let delivery = null;
    if (['approved', 'delivered'].includes(order.status) && order.assignedStockItemId) {
      const stock = await StockItem.findById(order.assignedStockItemId).lean();
      if (stock) {
        try { delivery = loginCodeAccessState(order, stock, await deliveryWithProductDefaults(order, stock, decryptJson(stock.encryptedPayload))); } catch { delivery = null; }
      }
    }
    results.push(publicOrderPayload(order, delivery));
  }

  res.json({ orders: results });
}));

publicRouter.post('/orders/:orderId/login-code', orderLimiter, asyncHandler(async (req, res) => {
  const token = req.query.token;
  if (!token || typeof token !== 'string') return res.status(401).json({ error: 'Order access token required' });

  const order = await Order.findOne({ orderId: req.params.orderId, accessTokenHash: sha256(token) });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!['approved', 'delivered'].includes(order.status) || !order.assignedStockItemId) {
    return res.status(403).json({ error: 'Delivery is not available yet' });
  }

  const stock = await StockItem.findById(order.assignedStockItemId).lean();
  if (!stock) return res.status(404).json({ error: 'Delivery stock not found' });

  const payload = decryptJson(stock.encryptedPayload);
  const deliveryMode = payload.deliveryMode || stock.type;
  if (deliveryMode !== 'login_code') {
    return res.status(400).json({ error: 'This delivery does not use login-code automation' });
  }
  const access = loginCodeAccessState(order, stock, payload);
  if (!access.canFetchLoginCode) return res.status(403).json({ error: 'Get code access has expired for this order.' });

  const account = await findMailTxtAccount(payload.email);
  if (!account) {
    return res.status(404).json({ error: 'Delivered email was not found in uploaded Mail TXT files' });
  }

  const messages = await fetchLatestMailboxMessages(account);
  for (const message of messages) {
    if (!messageWasSentToEmail(message, payload.email)) continue;

    const code = extractLoginCode(message);
    if (code) {
      return res.json({
        code,
        subject: message.subject || '',
        receivedAt: message.receivedDateTime || null,
        preview: message.bodyPreview || ''
      });
    }
  }

  res.status(404).json({ error: 'No login code found for this exact delivered email. Send the code to the same email shown in your delivery, then refresh.' });
}));

function customerOrderAccessQuery(customer, orderId = null) {
  const query = {
    $or: [
      { customerId: customer._id },
      { 'customer.email': customer.email }
    ]
  };
  if (orderId) query.orderId = orderId;
  return query;
}

publicRouter.get('/customer/orders', requireCustomer, asyncHandler(async (req, res) => {
  const orders = await Order.find(customerOrderAccessQuery(req.customer))
    .populate('productId', 'title slug')
    .sort({ createdAt: -1 })
    .limit(200);

  await Promise.all(orders.map((order) => latchManualDeliveryMode(order)));

  res.json({ orders: orders.map((order) => publicOrderPayload(order, null)) });
}));

// A manual-delivery product is activated on the customer's own account. The
// password is encrypted separately and is never returned through public APIs.
publicRouter.post('/customer/orders/:orderId/manual-activation', orderLimiter, requireCustomer, asyncHandler(async (req, res) => {
  const data = manualActivationSchema.parse(req.body);
  const order = await Order.findOne(customerOrderAccessQuery(req.customer, req.params.orderId));
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'pending') return res.status(409).json({ error: 'This order is already ' + order.status });
  await latchManualDeliveryMode(order);
  if (order.productSnapshot?.deliveryMode !== 'manual') return res.status(400).json({ error: 'This product does not need manual activation details' });

  const validationError = validateManualActivation(data, [order.productSnapshot]);
  if (validationError) return res.status(400).json({ error: validationError });

  order.manualActivationEncrypted = encryptJson({ email: data.email.toLowerCase().trim(), password: data.password || '', mode: manualInputMode(order.productSnapshot) });
  order.manualActivationSubmittedAt = new Date();
  order.manualActivationActivatedAt = null;
  order.manualActivationActivatedBy = null;
  order.manualActivationActivatedByNickname = '';
  await order.save();
  await notifyManualActivationSubmitted(order, { email: data.email.toLowerCase().trim(), password: data.password || '', mode: manualInputMode(order.productSnapshot) });
  res.json({ message: 'Activation details submitted. Waiting for subscription activation.', order: publicOrderPayload(order, null) });
}));

publicRouter.get('/customer/orders/:orderId/delivery', requireCustomer, asyncHandler(async (req, res) => {
  const order = await Order.findOne(customerOrderAccessQuery(req.customer, req.params.orderId));
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!['approved', 'delivered'].includes(order.status) || !order.assignedStockItemId) {
    return res.status(403).json({ error: 'Delivery is not available yet' });
  }

  const stock = await StockItem.findById(order.assignedStockItemId).lean();
  if (!stock) return res.status(404).json({ error: 'Delivery stock not found' });

  const payload = loginCodeAccessState(order, stock, await deliveryWithProductDefaults(order, stock, decryptJson(stock.encryptedPayload)));
  if (!order.deliveryViewedAt) order.deliveryViewedAt = new Date();
  await order.save();

  res.json({
    orderId: order.orderId,
    product: order.productSnapshot,
    delivery: payload,
    warning: 'Keep this information private. Do not share your order link or token.'
  });
}));

publicRouter.post('/customer/orders/:orderId/login-code', orderLimiter, requireCustomer, asyncHandler(async (req, res) => {
  const order = await Order.findOne(customerOrderAccessQuery(req.customer, req.params.orderId));
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!['approved', 'delivered'].includes(order.status) || !order.assignedStockItemId) {
    return res.status(403).json({ error: 'Delivery is not available yet' });
  }

  const stock = await StockItem.findById(order.assignedStockItemId).lean();
  if (!stock) return res.status(404).json({ error: 'Delivery stock not found' });

  const payload = decryptJson(stock.encryptedPayload);
  const deliveryMode = payload.deliveryMode || stock.type;
  if (deliveryMode !== 'login_code') {
    return res.status(400).json({ error: 'This delivery does not use login-code automation' });
  }
  const access = loginCodeAccessState(order, stock, payload);
  if (!access.canFetchLoginCode) return res.status(403).json({ error: 'Get code access has expired for this order.' });

  const account = await findMailTxtAccount(payload.email);
  if (!account) {
    return res.status(404).json({ error: 'Delivered email was not found in uploaded Mail TXT files' });
  }

  const messages = await fetchLatestMailboxMessages(account);
  for (const message of messages) {
    if (!messageWasSentToEmail(message, payload.email)) continue;

    const code = extractLoginCode(message);
    if (code) {
      return res.json({
        code,
        subject: message.subject || '',
        receivedAt: message.receivedDateTime || null,
        preview: message.bodyPreview || ''
      });
    }
  }

  res.status(404).json({ error: 'No login code found for this exact delivered email. Send the code to the same email shown in your delivery, then refresh.' });
}));

publicRouter.get('/orders/:orderId/status', asyncHandler(async (req, res) => {
  const token = req.query.token;
  if (!token || typeof token !== 'string') return res.status(401).json({ error: 'Order access token required' });

  const order = await Order.findOne({ orderId: req.params.orderId, accessTokenHash: sha256(token) });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  await latchManualDeliveryMode(order);

  res.json({
    order: {
      orderId: order.orderId,
      status: order.status,
      product: order.productSnapshot,
      paymentMethod: order.paymentMethod,
      priceRegion: order.priceRegion,
      detectedCountry: order.detectedCountry,
      transactionId: order.transactionId,
      customerOrderRef: order.customerOrderRef,
      createdAt: order.createdAt,
      reviewedAt: order.reviewedAt,
      reviewedByNickname: order.reviewedByNickname || order.approvedByNickname || order.deliveredByNickname || order.rejectedByNickname || '',
      approvedByNickname: order.approvedByNickname || '',
      deliveredByNickname: order.deliveredByNickname || '',
      rejectedByNickname: order.rejectedByNickname || '',
      cancelledByNickname: order.cancelledByNickname || '',
      rejectReason: order.rejectReason || null,
      cancelReason: order.cancelReason || null,
      cancelledAt: order.cancelledAt || null,
      manualActivationRequired: order.productSnapshot?.deliveryMode === 'manual',
      manualActivationSubmitted: Boolean(order.manualActivationSubmittedAt),
      manualActivationActivated: Boolean(order.manualActivationActivatedAt),
      deliveryAvailable: ['approved', 'delivered'].includes(order.status) && !!order.assignedStockItemId
    }
  });
}));

publicRouter.get('/orders/:orderId/delivery', asyncHandler(async (req, res) => {
  const token = req.query.token;
  if (!token || typeof token !== 'string') return res.status(401).json({ error: 'Order access token required' });

  const order = await Order.findOne({ orderId: req.params.orderId, accessTokenHash: sha256(token) });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!['approved', 'delivered'].includes(order.status) || !order.assignedStockItemId) {
    return res.status(403).json({ error: 'Delivery is not available yet' });
  }

  const stock = await StockItem.findById(order.assignedStockItemId).lean();
  if (!stock) return res.status(404).json({ error: 'Delivery stock not found' });

  const payload = loginCodeAccessState(order, stock, await deliveryWithProductDefaults(order, stock, decryptJson(stock.encryptedPayload)));
  if (!order.deliveryViewedAt) order.deliveryViewedAt = new Date();
  await order.save();

  res.json({
    orderId: order.orderId,
    product: order.productSnapshot,
    delivery: payload,
    warning: 'Keep this information private. Do not share your order link or token.'
  });
}));

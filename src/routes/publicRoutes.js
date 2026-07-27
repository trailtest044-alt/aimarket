import express from 'express';
import { z } from 'zod';
import validator from 'validator';
import { Product } from '../models/Product.js';
import { PaymentMethod } from '../models/PaymentMethod.js';
import { Order } from '../models/Order.js';
import { StockItem } from '../models/StockItem.js';
import { MailTxtFile } from '../models/MailTxtFile.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { createAccessToken, createOrderId, sha256 } from '../utils/tokens.js';
import { decryptJson } from '../utils/cryptoBox.js';
import { orderLimiter } from '../middleware/rateLimits.js';
import { detectRegion, priceForRegion, allowedPaymentMethods, priceRegionForPaymentMethod } from '../utils/region.js';

export const publicRouter = express.Router();

const createOrderSchema = z.object({
  productId: z.string().min(1),
  customer: z.object({
    name: z.string().min(2).max(80),
    email: z.string().email().max(120),
    whatsapp: z.string().max(40).optional().default('')
  }),
  paymentMethod: z.enum(['bangladesh', 'pakistan', 'binance']),
  priceRegion: z.enum(['bd', 'pk', 'world']).optional().default('world'),
  transactionId: z.string().min(4).max(120),
  customerOrderRef: z.string().max(120).optional().default(''),
  paymentNote: z.string().max(500).optional().default('')
});

function publicProduct(p, availableStock, region = 'world') {
  const displayPrice = priceForRegion(p, region);
  return {
    ...p,
    pricing: {
      bd: { amount: Number(p.priceBDT || 0), currency: 'BDT', originalAmount: Number(p.originalPriceBDT || 0) },
      pk: { amount: Number(p.pricePKR || 0), currency: 'PKR', originalAmount: Number(p.originalPricePKR || 0) },
      world: { amount: Number(p.priceUSDT || 0), currency: p.worldwideCurrency || 'USDT', originalAmount: Number(p.originalPriceUSDT || 0) }
    },
    displayPrice: { ...displayPrice, region },
    availableStock: availableStock || 0
  };
}

publicRouter.get('/health', (req, res) => {
  res.json({ ok: true, service: 'ai-digital-marketplace-api' });
});

publicRouter.get('/region', (req, res) => {
  const { country, region } = detectRegion(req, req.query.region);
  res.json({ country, region });
});

publicRouter.get('/products', asyncHandler(async (req, res) => {
  const { region } = detectRegion(req, req.query.region);
  const products = await Product.find({ isActive: true }).sort({ sortOrder: 1, createdAt: -1 }).lean();

  const stockCounts = await StockItem.aggregate([
    { $match: { status: 'available' } },
    { $group: { _id: '$productId', count: { $sum: 1 } } }
  ]);
  const stockMap = new Map(stockCounts.map((item) => [item._id.toString(), item.count]));

  res.json({ products: products.map((p) => publicProduct(p, stockMap.get(p._id.toString()) || 0, region)), region });
}));

publicRouter.get('/products/:slug', asyncHandler(async (req, res) => {
  const { region } = detectRegion(req, req.query.region);
  const product = await Product.findOne({ slug: req.params.slug, isActive: true }).lean();
  if (!product) return res.status(404).json({ error: 'Product not found' });
  const availableStock = await StockItem.countDocuments({ productId: product._id, status: 'available' });
  res.json({ product: publicProduct(product, availableStock, region), region });
}));

publicRouter.get('/payment-methods', asyncHandler(async (req, res) => {
  const methods = await PaymentMethod.find({ isActive: true }).sort({ key: 1 }).lean();
  res.json({ methods });
}));

publicRouter.post('/orders', orderLimiter, asyncHandler(async (req, res) => {
  const data = createOrderSchema.parse(req.body);

  if (!validator.isMongoId(data.productId)) {
    return res.status(400).json({ error: 'Invalid product ID' });
  }

  const product = await Product.findOne({ _id: data.productId, isActive: true }).lean();
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const available = await StockItem.countDocuments({ productId: product._id, status: 'available' });
  if (available <= 0) return res.status(409).json({ error: 'This product is out of stock' });

  const { country, region: detectedRegion } = detectRegion(req, data.priceRegion);
  const allowedMethods = allowedPaymentMethods(detectedRegion);
  if (!allowedMethods.includes(data.paymentMethod)) {
    return res.status(400).json({ error: `This region can use only: ${allowedMethods.join(', ')}` });
  }

  const duplicateQuery = [
    { transactionId: data.transactionId.trim() }
  ];
  if (data.customerOrderRef?.trim()) duplicateQuery.push({ customerOrderRef: data.customerOrderRef.trim() });
  const duplicate = await Order.findOne({ $or: duplicateQuery }).lean();
  if (duplicate) {
    return res.status(409).json({ error: 'This transaction/order reference is already submitted. Use Track Your Orders to check status.' });
  }

  const finalPriceRegion = priceRegionForPaymentMethod(data.paymentMethod, detectedRegion);
  const method = await PaymentMethod.findOne({ key: data.paymentMethod, isActive: true }).lean();
  if (!method) return res.status(400).json({ error: 'Payment method is not active' });

  const price = priceForRegion(product, finalPriceRegion);
  const accessToken = createAccessToken();
  const order = await Order.create({
    orderId: createOrderId(),
    productId: product._id,
    productSnapshot: { title: product.title, price: price.amount, currency: price.currency, priceRegion: finalPriceRegion },
    customer: {
      name: data.customer.name.trim(),
      email: data.customer.email.toLowerCase().trim(),
      whatsapp: data.customer.whatsapp?.trim() || ''
    },
    paymentMethod: data.paymentMethod,
    priceRegion: finalPriceRegion,
    detectedCountry: country,
    transactionId: data.transactionId.trim(),
    customerOrderRef: data.customerOrderRef?.trim() || '',
    paymentNote: data.paymentNote,
    status: 'pending',
    accessTokenHash: sha256(accessToken),
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'] || ''
  });

  res.status(201).json({
    message: 'Order submitted. Waiting for admin approval.',
    order: {
      orderId: order.orderId,
      status: order.status,
      productTitle: product.title,
      amount: price.amount,
      currency: price.currency,
      priceRegion: finalPriceRegion,
      paymentMethod: data.paymentMethod,
      transactionId: order.transactionId,
      customerOrderRef: order.customerOrderRef
    },
    accessToken
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
    reviewedByNickname: order.reviewedByNickname || '',
    rejectReason: order.rejectReason || null,
    deliveryAvailable: ['approved', 'delivered'].includes(order.status) && !!order.assignedStockItemId,
    delivery
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
  url.searchParams.set('$select', 'id,sender,subject,receivedDateTime,bodyPreview,body');

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

async function findMailTxtAccount(email) {
  const targetEmail = String(email || '').toLowerCase().trim();
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
      ? accounts.find((item) => String(item.email || '').toLowerCase().trim() === targetEmail)
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
    let delivery = null;
    if (['approved', 'delivered'].includes(order.status) && order.assignedStockItemId) {
      const stock = await StockItem.findById(order.assignedStockItemId).lean();
      if (stock) {
        try { delivery = decryptJson(stock.encryptedPayload); } catch { delivery = null; }
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

  const account = await findMailTxtAccount(payload.email);
  if (!account) {
    return res.status(404).json({ error: 'Delivered email was not found in uploaded Mail TXT files' });
  }

  const messages = await fetchLatestMailboxMessages(account);
  for (const message of messages) {
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

  res.status(404).json({ error: 'No login code found in the latest inbox messages. Try refresh after a moment.' });
}));

publicRouter.get('/orders/:orderId/status', asyncHandler(async (req, res) => {
  const token = req.query.token;
  if (!token || typeof token !== 'string') return res.status(401).json({ error: 'Order access token required' });

  const order = await Order.findOne({ orderId: req.params.orderId, accessTokenHash: sha256(token) }).lean();
  if (!order) return res.status(404).json({ error: 'Order not found' });

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
      rejectReason: order.rejectReason || null,
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

  const payload = decryptJson(stock.encryptedPayload);
  if (!order.deliveryViewedAt) order.deliveryViewedAt = new Date();
  await order.save();

  res.json({
    orderId: order.orderId,
    product: order.productSnapshot,
    delivery: payload,
    warning: 'Keep this information private. Do not share your order link or token.'
  });
}));

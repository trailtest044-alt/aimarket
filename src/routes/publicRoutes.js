import express from 'express';
import { z } from 'zod';
import validator from 'validator';
import { Product } from '../models/Product.js';
import { PaymentMethod } from '../models/PaymentMethod.js';
import { Order } from '../models/Order.js';
import { StockItem } from '../models/StockItem.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { createAccessToken, createOrderId, sha256 } from '../utils/tokens.js';
import { decryptJson } from '../utils/cryptoBox.js';
import { orderLimiter } from '../middleware/rateLimits.js';
import { detectRegion, priceForRegion, expectedPaymentMethod } from '../utils/region.js';

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

  const { country, region } = detectRegion(req, data.priceRegion);
  const expectedMethod = expectedPaymentMethod(region);
  if (data.paymentMethod !== expectedMethod) {
    return res.status(400).json({ error: `This region must use ${expectedMethod} payment.` });
  }

  const method = await PaymentMethod.findOne({ key: data.paymentMethod, isActive: true }).lean();
  if (!method) return res.status(400).json({ error: 'Payment method is not active' });

  const price = priceForRegion(product, region);
  const accessToken = createAccessToken();
  const order = await Order.create({
    orderId: createOrderId(),
    productId: product._id,
    productSnapshot: { title: product.title, price: price.amount, currency: price.currency, priceRegion: region },
    customer: {
      name: data.customer.name.trim(),
      email: data.customer.email.toLowerCase().trim(),
      whatsapp: data.customer.whatsapp?.trim() || ''
    },
    paymentMethod: data.paymentMethod,
    priceRegion: region,
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
      priceRegion: region,
      paymentMethod: data.paymentMethod,
      transactionId: order.transactionId,
      customerOrderRef: order.customerOrderRef
    },
    accessToken
  });
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

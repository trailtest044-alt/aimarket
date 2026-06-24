import express from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import validator from 'validator';
import { Admin } from '../models/Admin.js';
import { Product } from '../models/Product.js';
import { PaymentMethod } from '../models/PaymentMethod.js';
import { StockItem } from '../models/StockItem.js';
import { Order } from '../models/Order.js';
import { requireAdmin, signAdminToken } from '../middleware/auth.js';
import { adminLoginLimiter } from '../middleware/rateLimits.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { encryptJson, decryptJson } from '../utils/cryptoBox.js';

export const adminRouter = express.Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8)
});

const productSchema = z.object({
  title: z.string().min(2).max(120),
  slug: z.string().min(2).max(140).regex(/^[a-z0-9-]+$/),
  description: z.string().max(5000).optional().default(''),
  shortDescription: z.string().max(300).optional().default(''),
  category: z.string().max(80).optional().default('AI Tools'),
  imageUrl: z.string().max(1000).optional().default(''),
  priceBDT: z.number().min(0),
  pricePKR: z.number().min(0),
  priceUSDT: z.number().min(0),
  features: z.array(z.string().max(160)).optional().default([]),
  isActive: z.boolean().optional().default(true),
  sortOrder: z.number().optional().default(0)
});

const paymentMethodSchema = z.object({
  key: z.enum(['bangladesh', 'pakistan', 'binance']),
  title: z.string().min(2).max(80),
  instructions: z.string().min(5).max(3000),
  accounts: z.array(z.object({
    label: z.string().max(80).optional().default(''),
    value: z.string().max(200).optional().default(''),
    note: z.string().max(200).optional().default('')
  })).optional().default([]),
  isActive: z.boolean().optional().default(true)
});

const stockSchema = z.object({
  productId: z.string().min(1),
  type: z.enum(['credentials', 'instruction']),
  payload: z.object({
    email: z.string().max(200).optional(),
    password: z.string().max(500).optional(),
    instruction: z.string().max(5000).optional(),
    extra: z.record(z.any()).optional()
  }),
  adminNote: z.string().max(500).optional().default('')
});

adminRouter.post('/auth/login', adminLoginLimiter, asyncHandler(async (req, res) => {
  const data = loginSchema.parse(req.body);
  const admin = await Admin.findOne({ email: data.email.toLowerCase().trim(), isActive: true });
  if (!admin) return res.status(401).json({ error: 'Invalid login' });

  const ok = await bcrypt.compare(data.password, admin.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid login' });

  admin.lastLoginAt = new Date();
  await admin.save();

  res.json({
    token: signAdminToken(admin),
    admin: { name: admin.name, email: admin.email, role: admin.role }
  });
}));

adminRouter.use(requireAdmin);

adminRouter.get('/me', (req, res) => {
  res.json({ admin: req.admin });
});

adminRouter.get('/dashboard', asyncHandler(async (req, res) => {
  const [pendingOrders, products, availableStock, deliveredOrders] = await Promise.all([
    Order.countDocuments({ status: 'pending' }),
    Product.countDocuments(),
    StockItem.countDocuments({ status: 'available' }),
    Order.countDocuments({ status: 'delivered' })
  ]);
  res.json({ stats: { pendingOrders, products, availableStock, deliveredOrders } });
}));

// Products
adminRouter.get('/products', asyncHandler(async (req, res) => {
  const products = await Product.find().sort({ sortOrder: 1, createdAt: -1 }).lean();
  res.json({ products });
}));

adminRouter.post('/products', asyncHandler(async (req, res) => {
  const data = productSchema.parse(req.body);
  const product = await Product.create(data);
  res.status(201).json({ product });
}));

adminRouter.patch('/products/:id', asyncHandler(async (req, res) => {
  if (!validator.isMongoId(req.params.id)) return res.status(400).json({ error: 'Invalid product ID' });
  const data = productSchema.partial().parse(req.body);
  const product = await Product.findByIdAndUpdate(req.params.id, data, { new: true, runValidators: true });
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json({ product });
}));

adminRouter.delete('/products/:id', asyncHandler(async (req, res) => {
  if (!validator.isMongoId(req.params.id)) return res.status(400).json({ error: 'Invalid product ID' });
  // Safer than hard delete: deactivate product so old orders remain valid.
  const product = await Product.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json({ product, message: 'Product deactivated' });
}));

// Payment methods
adminRouter.get('/payment-methods', asyncHandler(async (req, res) => {
  const methods = await PaymentMethod.find().sort({ key: 1 }).lean();
  res.json({ methods });
}));

adminRouter.put('/payment-methods/:key', asyncHandler(async (req, res) => {
  const data = paymentMethodSchema.parse({ ...req.body, key: req.params.key });
  const method = await PaymentMethod.findOneAndUpdate({ key: data.key }, data, { upsert: true, new: true, runValidators: true });
  res.json({ method });
}));

// Stock
adminRouter.get('/stock', asyncHandler(async (req, res) => {
  const query = {};
  if (req.query.productId && validator.isMongoId(req.query.productId)) query.productId = req.query.productId;
  if (req.query.status) query.status = req.query.status;
  const stock = await StockItem.find(query).populate('productId', 'title slug').sort({ createdAt: -1 }).limit(200).lean();
  res.json({ stock });
}));

adminRouter.post('/stock', asyncHandler(async (req, res) => {
  const data = stockSchema.parse(req.body);
  if (!validator.isMongoId(data.productId)) return res.status(400).json({ error: 'Invalid product ID' });
  const product = await Product.findById(data.productId).lean();
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const stock = await StockItem.create({
    productId: data.productId,
    type: data.type,
    encryptedPayload: encryptJson(data.payload),
    adminNote: data.adminNote
  });
  res.status(201).json({ stock: { ...stock.toObject(), encryptedPayload: undefined } });
}));

adminRouter.get('/stock/:id/reveal', asyncHandler(async (req, res) => {
  if (!validator.isMongoId(req.params.id)) return res.status(400).json({ error: 'Invalid stock ID' });
  const stock = await StockItem.findById(req.params.id).populate('productId', 'title slug').lean();
  if (!stock) return res.status(404).json({ error: 'Stock item not found' });
  res.json({ stock: { ...stock, payload: decryptJson(stock.encryptedPayload), encryptedPayload: undefined } });
}));

adminRouter.patch('/stock/:id/disable', asyncHandler(async (req, res) => {
  if (!validator.isMongoId(req.params.id)) return res.status(400).json({ error: 'Invalid stock ID' });
  const stock = await StockItem.findOneAndUpdate(
    { _id: req.params.id, status: { $in: ['available', 'disabled'] } },
    { status: req.body.enable ? 'available' : 'disabled' },
    { new: true }
  );
  if (!stock) return res.status(404).json({ error: 'Stock item not found or already delivered' });
  res.json({ stock });
}));

// Orders
adminRouter.get('/orders', asyncHandler(async (req, res) => {
  const status = req.query.status;
  const query = status ? { status } : {};
  const orders = await Order.find(query)
    .populate('productId', 'title slug')
    .sort({ createdAt: -1 })
    .limit(300)
    .lean();
  res.json({ orders });
}));

adminRouter.post('/orders/:orderId/approve', asyncHandler(async (req, res) => {
  const order = await Order.findOne({ orderId: req.params.orderId });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'pending') return res.status(409).json({ error: `Order is already ${order.status}` });

  // Atomic stock assignment: one stock item can only be delivered once.
  const stock = await StockItem.findOneAndUpdate(
    { productId: order.productId, status: 'available' },
    { status: 'delivered', assignedOrderId: order._id, deliveredAt: new Date() },
    { new: true, sort: { createdAt: 1 } }
  );

  if (!stock) return res.status(409).json({ error: 'No available stock for this product' });

  order.status = 'approved';
  order.assignedStockItemId = stock._id;
  order.reviewedBy = req.admin._id;
  order.reviewedAt = new Date();
  await order.save();

  res.json({
    message: 'Order approved. Customer can now view delivery using their order token.',
    order
  });
}));

adminRouter.post('/orders/:orderId/reject', asyncHandler(async (req, res) => {
  const reason = z.object({ reason: z.string().min(2).max(500) }).parse(req.body).reason;
  const order = await Order.findOne({ orderId: req.params.orderId });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'pending') return res.status(409).json({ error: `Order is already ${order.status}` });

  order.status = 'rejected';
  order.rejectReason = reason;
  order.reviewedBy = req.admin._id;
  order.reviewedAt = new Date();
  await order.save();

  res.json({ message: 'Order rejected', order });
}));

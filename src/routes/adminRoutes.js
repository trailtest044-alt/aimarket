import express from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import validator from 'validator';
import { Admin } from '../models/Admin.js';
import { Product } from '../models/Product.js';
import { PaymentMethod } from '../models/PaymentMethod.js';
import { StockItem } from '../models/StockItem.js';
import { Order } from '../models/Order.js';
import { ActivityLog } from '../models/ActivityLog.js';
import { requireAdmin, requireOwner, signAdminToken } from '../middleware/auth.js';
import { adminLoginLimiter } from '../middleware/rateLimits.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { encryptJson, decryptJson } from '../utils/cryptoBox.js';
import { logActivity } from '../utils/activity.js';

export const adminRouter = express.Router();

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(8) });
const adminCreateSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10),
  nickname: z.string().min(2).max(50),
  name: z.string().max(80).optional().default(''),
  role: z.enum(['admin', 'owner']).optional().default('admin')
});
const passwordSchema = z.object({ password: z.string().min(10) });


const productReorderSchema = z.object({
  items: z.array(z.object({
    id: z.string().min(1),
    sortOrder: z.number().int().min(1).max(100000)
  })).min(1).max(1000)
});

const productSchema = z.object({
  title: z.string().min(2).max(120),
  slug: z.string().min(2).max(140).regex(/^[a-z0-9-]+$/),
  description: z.string().max(5000).optional().default(''),
  shortDescription: z.string().max(300).optional().default(''),
  category: z.string().max(80).optional().default('AI Tools'),
  imageUrl: z.string().max(1000).optional().default(''),
  badge: z.string().max(60).optional().default(''),
  icon: z.string().max(10).optional().default('✨'),
  priceBDT: z.number().min(0),
  pricePKR: z.number().min(0),
  priceUSDT: z.number().min(0),
  worldwideCurrency: z.enum(['USDT', 'USD']).optional().default('USDT'),
  originalPriceBDT: z.number().min(0).optional().default(0),
  originalPricePKR: z.number().min(0).optional().default(0),
  originalPriceUSDT: z.number().min(0).optional().default(0),
  features: z.array(z.string().max(160)).optional().default([]),
  deliveryMethod: z.string().max(300).optional().default('Account login details will be delivered after admin approval.'),
  terms: z.string().max(2000).optional().default(''),
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
    email: z.string().max(200).optional().default(''),
    password: z.string().max(500).optional().default(''),
    instruction: z.string().max(8000).optional().default(''),
    videoUrl: z.string().max(1000).optional().default(''),
    imageUrl: z.string().max(1000).optional().default(''),
    extra: z.record(z.any()).optional()
  }),
  adminNote: z.string().max(500).optional().default('')
});

function adminSafe(a) {
  return {
    id: a._id?.toString?.() || a.id,
    name: a.name,
    nickname: a.nickname || a.name,
    email: a.email,
    role: a.role,
    isActive: a.isActive,
    createdByNickname: a.createdByNickname || '',
    lastLoginAt: a.lastLoginAt,
    createdAt: a.createdAt
  };
}

adminRouter.post('/auth/login', adminLoginLimiter, asyncHandler(async (req, res) => {
  const data = loginSchema.parse(req.body);
  const admin = await Admin.findOne({ email: data.email.toLowerCase().trim(), isActive: true });
  if (!admin) return res.status(401).json({ error: 'Invalid login' });

  const ok = await bcrypt.compare(data.password, admin.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid login' });

  // One-time friendly migration for the owner account.
  if (admin.email === 'shahriarshimul044@gmail.com' && (!admin.nickname || admin.nickname.toLowerCase() === 'owner' || admin.name.toLowerCase() === 'owner')) {
    admin.name = 'shimul';
    admin.nickname = 'shimul';
    admin.role = 'owner';
  }
  if (!admin.nickname) admin.nickname = admin.name;
  admin.lastLoginAt = new Date();
  await admin.save();

  res.json({ token: signAdminToken(admin), admin: adminSafe(admin) });
}));

adminRouter.use(requireAdmin);

adminRouter.get('/me', (req, res) => res.json({ admin: req.admin }));

adminRouter.get('/dashboard', asyncHandler(async (req, res) => {
  const [totalProducts, pendingOrders, approvedOrders, deliveredOrders, rejectedOrders, availableStock, lowStockAgg, productSales, recentOrders, recentActivity] = await Promise.all([
    Product.countDocuments({ isActive: true }),
    Order.countDocuments({ status: 'pending' }),
    Order.countDocuments({ status: 'approved' }),
    Order.countDocuments({ status: 'delivered' }),
    Order.countDocuments({ status: 'rejected' }),
    StockItem.countDocuments({ status: 'available' }),
    StockItem.aggregate([
      { $match: { status: 'available' } },
      { $group: { _id: '$productId', available: { $sum: 1 } } },
      { $match: { available: { $lte: 2 } } },
      { $limit: 10 }
    ]),
    Order.aggregate([
      { $match: { status: { $in: ['approved', 'delivered'] } } },
      { $group: {
        _id: '$productId',
        sold: { $sum: 1 },
        revenueBDT: { $sum: { $cond: [{ $eq: ['$productSnapshot.currency', 'BDT'] }, '$productSnapshot.price', 0] } },
        revenuePKR: { $sum: { $cond: [{ $eq: ['$productSnapshot.currency', 'PKR'] }, '$productSnapshot.price', 0] } },
        revenueWorld: { $sum: { $cond: [{ $in: ['$productSnapshot.currency', ['USDT', 'USD']] }, '$productSnapshot.price', 0] } }
      } },
      { $sort: { sold: -1 } },
      { $limit: 20 }
    ]),
    Order.find().populate('productId', 'title slug').sort({ createdAt: -1 }).limit(8).lean(),
    ActivityLog.find().sort({ createdAt: -1 }).limit(12).lean()
  ]);

  const products = await Product.find({ _id: { $in: productSales.map(x => x._id).concat(lowStockAgg.map(x => x._id)) } }).lean();
  const productMap = new Map(products.map(p => [p._id.toString(), p]));

  const salesByProduct = productSales.map(item => ({
    productId: item._id?.toString(),
    productName: productMap.get(item._id?.toString())?.title || 'Unknown product',
    sold: item.sold,
    revenueBDT: item.revenueBDT,
    revenuePKR: item.revenuePKR,
    revenueWorld: item.revenueWorld,
    availableStock: lowStockAgg.find(x => String(x._id) === String(item._id))?.available ?? null
  }));

  res.json({
    stats: { totalProducts, pendingOrders, approvedOrders, deliveredOrders, rejectedOrders, soldOrders: approvedOrders + deliveredOrders, availableStock },
    salesByProduct,
    lowStock: lowStockAgg.map(x => ({ productId: x._id?.toString(), productName: productMap.get(x._id?.toString())?.title || 'Unknown product', available: x.available })),
    recentOrders,
    recentActivity
  });
}));

// Owner-only admin management
adminRouter.get('/users', requireOwner, asyncHandler(async (req, res) => {
  const admins = await Admin.find().sort({ role: -1, createdAt: -1 }).select('-passwordHash').lean();
  res.json({ admins: admins.map(adminSafe) });
}));

adminRouter.post('/users', requireOwner, asyncHandler(async (req, res) => {
  const data = adminCreateSchema.parse(req.body);
  const passwordHash = await bcrypt.hash(data.password, 12);
  const admin = await Admin.create({
    email: data.email.toLowerCase().trim(),
    passwordHash,
    name: data.name || data.nickname,
    nickname: data.nickname,
    role: data.role,
    isActive: true,
    createdByAdminId: req.admin._id,
    createdByNickname: req.admin.nickname || req.admin.name
  });
  await logActivity(req.admin, 'admin.created', 'admin', admin._id, `${req.admin.nickname || req.admin.name} added admin ${admin.nickname}`);
  res.status(201).json({ admin: adminSafe(admin) });
}));

adminRouter.patch('/users/:id/password', requireOwner, asyncHandler(async (req, res) => {
  if (!validator.isMongoId(req.params.id)) return res.status(400).json({ error: 'Invalid admin ID' });
  const { password } = passwordSchema.parse(req.body);
  const admin = await Admin.findByIdAndUpdate(req.params.id, { passwordHash: await bcrypt.hash(password, 12) }, { new: true });
  if (!admin) return res.status(404).json({ error: 'Admin not found' });
  await logActivity(req.admin, 'admin.password_reset', 'admin', admin._id, `${req.admin.nickname || req.admin.name} reset password for ${admin.nickname || admin.name}`);
  res.json({ admin: adminSafe(admin) });
}));

adminRouter.patch('/users/me/password', asyncHandler(async (req, res) => {
  const { password } = passwordSchema.parse(req.body);
  const admin = await Admin.findByIdAndUpdate(req.admin._id, { passwordHash: await bcrypt.hash(password, 12) }, { new: true });
  res.json({ admin: adminSafe(admin) });
}));

adminRouter.patch('/users/:id/status', requireOwner, asyncHandler(async (req, res) => {
  if (!validator.isMongoId(req.params.id)) return res.status(400).json({ error: 'Invalid admin ID' });
  if (String(req.admin._id) === req.params.id) return res.status(400).json({ error: 'Owner cannot disable own account here' });
  const isActive = !!req.body.isActive;
  const admin = await Admin.findByIdAndUpdate(req.params.id, { isActive }, { new: true });
  if (!admin) return res.status(404).json({ error: 'Admin not found' });
  await logActivity(req.admin, isActive ? 'admin.enabled' : 'admin.disabled', 'admin', admin._id, `${req.admin.nickname || req.admin.name} ${isActive ? 'enabled' : 'disabled'} admin ${admin.nickname || admin.name}`);
  res.json({ admin: adminSafe(admin) });
}));

// Products
adminRouter.get('/products', asyncHandler(async (req, res) => {
  const products = await Product.find().sort({ sortOrder: 1, createdAt: -1 }).lean();
  res.json({ products });
}));


adminRouter.patch('/products/reorder', asyncHandler(async (req, res) => {
  const { items } = productReorderSchema.parse(req.body);

  const validItems = items.filter((item) => validator.isMongoId(item.id));
  if (validItems.length !== items.length) {
    return res.status(400).json({ error: 'Invalid product ID in reorder list' });
  }

  const ops = validItems.map((item) => ({
    updateOne: {
      filter: { _id: item.id },
      update: {
        $set: {
          sortOrder: item.sortOrder,
          updatedByAdminId: req.admin._id,
          updatedByNickname: req.admin.nickname || req.admin.name,
        },
      },
    },
  }));

  if (ops.length) await Product.bulkWrite(ops, { ordered: false });

  await logActivity(
    req.admin,
    'product.reordered',
    'product',
    'display-order',
    `${req.admin.nickname || req.admin.name} updated product display order`
  );

  const products = await Product.find().sort({ sortOrder: 1, createdAt: -1 }).lean();
  res.json({ products });
}));

adminRouter.post('/products', asyncHandler(async (req, res) => {
  const data = productSchema.parse(req.body);
  const product = await Product.create({ ...data, createdByAdminId: req.admin._id, createdByNickname: req.admin.nickname || req.admin.name });
  await logActivity(req.admin, 'product.created', 'product', product._id, `${req.admin.nickname || req.admin.name} added product ${product.title}`);
  res.status(201).json({ product });
}));

adminRouter.patch('/products/:id', asyncHandler(async (req, res) => {
  if (!validator.isMongoId(req.params.id)) return res.status(400).json({ error: 'Invalid product ID' });
  const data = productSchema.partial().parse(req.body);
  const product = await Product.findByIdAndUpdate(req.params.id, { ...data, updatedByAdminId: req.admin._id, updatedByNickname: req.admin.nickname || req.admin.name }, { new: true, runValidators: true });
  if (!product) return res.status(404).json({ error: 'Product not found' });
  await logActivity(req.admin, 'product.updated', 'product', product._id, `${req.admin.nickname || req.admin.name} updated product ${product.title}`);
  res.json({ product });
}));

adminRouter.delete('/products/:id', asyncHandler(async (req, res) => {
  if (!validator.isMongoId(req.params.id)) return res.status(400).json({ error: 'Invalid product ID' });
  const product = await Product.findByIdAndUpdate(req.params.id, { isActive: false, updatedByAdminId: req.admin._id, updatedByNickname: req.admin.nickname || req.admin.name }, { new: true });
  if (!product) return res.status(404).json({ error: 'Product not found' });
  await logActivity(req.admin, 'product.disabled', 'product', product._id, `${req.admin.nickname || req.admin.name} disabled product ${product.title}`);
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
  await logActivity(req.admin, 'payment.updated', 'paymentMethod', data.key, `${req.admin.nickname || req.admin.name} updated ${data.title} payment settings`);
  res.json({ method });
}));

// Stock
adminRouter.get('/stock', asyncHandler(async (req, res) => {
  const query = {};
  if (req.query.productId && validator.isMongoId(req.query.productId)) query.productId = req.query.productId;
  if (req.query.status) query.status = req.query.status;
  const stock = await StockItem.find(query).populate('productId', 'title slug').sort({ createdAt: -1 }).limit(300).lean();
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
    adminNote: data.adminNote || data.payload.instruction || '',
    createdByAdminId: req.admin._id,
    createdByNickname: req.admin.nickname || req.admin.name
  });
  await logActivity(req.admin, 'stock.created', 'stock', stock._id, `${req.admin.nickname || req.admin.name} added stock for ${product.title}`);
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
  await logActivity(req.admin, req.body.enable ? 'stock.enabled' : 'stock.disabled', 'stock', stock._id, `${req.admin.nickname || req.admin.name} ${req.body.enable ? 'enabled' : 'disabled'} stock item`);
  res.json({ stock });
}));

// Orders
adminRouter.get('/orders', asyncHandler(async (req, res) => {
  const status = req.query.status;
  const query = status ? { status } : {};
  const orders = await Order.find(query)
    .populate('productId', 'title slug')
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();
  res.json({ orders });
}));

function searchRegex(value) {
  return new RegExp(String(value).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

adminRouter.get('/orders/search', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const status = String(req.query.status || '').trim();
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const query = {};
  if (status && ['pending', 'approved', 'delivered', 'rejected'].includes(status)) query.status = status;
  if (q) {
    const re = searchRegex(q);
    query.$or = [
      { orderId: re },
      { transactionId: re },
      { customerOrderRef: re },
      { 'customer.name': re },
      { 'customer.email': re },
      { 'customer.whatsapp': re },
      { 'productSnapshot.title': re },
      { paymentMethod: re },
      { approvedByNickname: re },
      { deliveredByNickname: re },
      { rejectedByNickname: re },
      { reviewedByNickname: re }
    ];
  }
  const orders = await Order.find(query)
    .populate('productId', 'title slug')
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  res.json({ orders });
}));

adminRouter.post('/orders/:orderId/approve', asyncHandler(async (req, res) => {
  const order = await Order.findOne({ orderId: req.params.orderId });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'pending') return res.status(409).json({ error: `Order is already ${order.status}` });

  const stock = await StockItem.findOneAndUpdate(
    { productId: order.productId, status: 'available' },
    { status: 'delivered', assignedOrderId: order._id, deliveredAt: new Date() },
    { new: true, sort: { createdAt: 1 } }
  );
  if (!stock) return res.status(409).json({ error: 'No available stock for this product' });

  const nick = req.admin.nickname || req.admin.name;
  order.status = 'approved';
  order.assignedStockItemId = stock._id;
  order.reviewedBy = req.admin._id;
  order.reviewedByNickname = nick;
  order.reviewedAt = new Date();
  order.approvedBy = req.admin._id;
  order.approvedByNickname = nick;
  order.approvedAt = new Date();
  await order.save();

  await logActivity(req.admin, 'order.approved', 'order', order.orderId, `${nick} approved order ${order.orderId}`);
  res.json({ message: 'Order approved. Customer can now view delivery using their order token.', order });
}));

adminRouter.post('/orders/:orderId/reject', asyncHandler(async (req, res) => {
  const reason = z.object({ reason: z.string().min(2).max(500) }).parse(req.body).reason;
  const order = await Order.findOne({ orderId: req.params.orderId });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'pending') return res.status(409).json({ error: `Order is already ${order.status}` });

  const nick = req.admin.nickname || req.admin.name;
  order.status = 'rejected';
  order.rejectReason = reason;
  order.reviewedBy = req.admin._id;
  order.reviewedByNickname = nick;
  order.reviewedAt = new Date();
  order.rejectedBy = req.admin._id;
  order.rejectedByNickname = nick;
  order.rejectedAt = new Date();
  await order.save();

  await logActivity(req.admin, 'order.rejected', 'order', order.orderId, `${nick} rejected order ${order.orderId}`);
  res.json({ message: 'Order rejected', order });
}));

adminRouter.post('/orders/:orderId/mark-delivered', asyncHandler(async (req, res) => {
  const order = await Order.findOne({ orderId: req.params.orderId });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!['pending', 'approved', 'delivered'].includes(order.status)) return res.status(409).json({ error: `Order is ${order.status}` });
  const nick = req.admin.nickname || req.admin.name;

  if (order.status === 'pending' && !order.assignedStockItemId) {
    const stock = await StockItem.findOneAndUpdate(
      { productId: order.productId, status: 'available' },
      { status: 'delivered', assignedOrderId: order._id, deliveredAt: new Date() },
      { new: true, sort: { createdAt: 1 } }
    );
    if (!stock) return res.status(409).json({ error: 'No available stock for this product' });
    order.assignedStockItemId = stock._id;
    order.approvedBy = req.admin._id;
    order.approvedByNickname = nick;
    order.approvedAt = new Date();
    order.reviewedBy = req.admin._id;
    order.reviewedByNickname = nick;
    order.reviewedAt = new Date();
  }

  order.status = 'delivered';
  order.deliveredBy = req.admin._id;
  order.deliveredByNickname = nick;
  order.deliveredAt = new Date();
  await order.save();
  await logActivity(req.admin, 'order.delivered', 'order', order.orderId, `${nick} approved and delivered order ${order.orderId}`);
  res.json({ message: 'Order marked delivered', order });
}));

adminRouter.get('/activity', asyncHandler(async (req, res) => {
  const logs = await ActivityLog.find().sort({ createdAt: -1 }).limit(200).lean();
  res.json({ logs });
}));

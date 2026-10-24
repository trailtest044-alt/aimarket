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
import { MailTxtFile } from '../models/MailTxtFile.js';
import { PromoCode } from '../models/PromoCode.js';
import { Customer } from '../models/Customer.js';
import { Visitor } from '../models/Visitor.js';
import { Reseller } from '../models/Reseller.js';
import { ResellerProductAccess } from '../models/ResellerProductAccess.js';
import { ResellerLedger } from '../models/ResellerLedger.js';
import { ResellerInvoice } from '../models/ResellerInvoice.js';
import { ResellerPaymentRequest } from '../models/ResellerPaymentRequest.js';
import { requireAdmin, requireOwner, signAdminToken } from '../middleware/auth.js';
import { adminLoginLimiter } from '../middleware/rateLimits.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { encryptJson, decryptJson } from '../utils/cryptoBox.js';
import { logActivity } from '../utils/activity.js';
import { sendDeliveryEmail, sendResellerPaymentReceipt } from '../services/notificationEmail.js';
import { notifyOrderApproved, notifyOrderDelivered, notifyResellerPaymentApproved } from '../services/telegramBot.js';
import { approveOrder, markOrderDelivered, cancelApprovedOrder } from '../services/orderWorkflow.js';
import { settleResellerPayment } from '../services/resellerPaymentSettlement.js';
import { getLatestMailTxtLoginCode } from '../services/mailTxtLoginCode.js';
import { runSupplierSync } from '../services/supplierSync.js';
import { SupplierSyncState } from '../models/SupplierSyncState.js';
import { supplierEnabled } from '../services/plandawSupplier.js';

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

const productSchema = z.object({
  title: z.string().min(2).max(120),
  slug: z.string().min(2).max(140).regex(/^[a-z0-9-]+$/),
  description: z.string().max(5000).optional().default(''),
  shortDescription: z.string().max(300).optional().default(''),
  category: z.string().max(80).optional().default('AI Tools'),
  imageUrl: z.string().max(1000).optional().default(''),
  badge: z.string().max(60).optional().default(''),
  icon: z.string().max(10).optional().default('✨'),
  supplierProductId: z.string().max(80).optional().default(''),
  supplierPackageId: z.string().max(80).optional().default(''),
  priceBDT: z.number().min(0).optional().default(0),
  pricePKR: z.number().positive(),
  priceUSDT: z.number().min(0).optional().default(0),
  isFree: z.literal(false).optional().default(false),
  worldwideCurrency: z.literal('USDT').optional().default('USDT'),
  originalPriceBDT: z.number().min(0).optional().default(0),
  originalPricePKR: z.number().min(0).optional().default(0),
  originalPriceUSDT: z.number().min(0).optional().default(0),
  purchaseCostBDT: z.number().min(0).optional().default(0),
  purchaseCostPKR: z.number().min(0).optional().default(0),
  purchaseCostUSDT: z.number().min(0).optional().default(0),
  accountCostBDT: z.number().min(0).optional().default(0),
  accountCostPKR: z.number().min(0).optional().default(0),
  accountCostUSDT: z.number().min(0).optional().default(0),
  paymentGatewayFeeBDT: z.number().min(0).optional().default(0),
  paymentGatewayFeePKR: z.number().min(0).optional().default(0),
  paymentGatewayFeeUSDT: z.number().min(0).optional().default(0),
  otherExpenseBDT: z.number().min(0).optional().default(0),
  otherExpensePKR: z.number().min(0).optional().default(0),
  otherExpenseUSDT: z.number().min(0).optional().default(0),
  features: z.array(z.string().max(160)).optional().default([]),
  deliveryMethod: z.string().max(300).optional().default('Account login details will be delivered after admin approval.'),
  deliveryMode: z.enum(['credentials', 'activation_code', 'login_code', 'manual']).optional().default('credentials'),
  deliveryInstruction: z.string().max(8000).optional().default(''),
  deliveryVideoUrl: z.string().max(1000).optional().default(''),
  deliveryImageUrl: z.string().max(1000).optional().default(''),
  passwordInstructionVideoUrl: z.string().max(1000).optional().default(''),
  manualInputMode: z.enum(['ideogram_credentials', 'email_password', 'email_only']).optional().default('ideogram_credentials'),
  backorderStock: z.number().int().min(0).max(10000).optional().default(0),
  terms: z.string().max(2000).optional().default(''),
  isActive: z.boolean().optional().default(true),
  sortOrder: z.number().optional().default(0)
});

const productResellerAssignmentSchema = z.object({
  resellerId: z.string().refine((value) => validator.isMongoId(value), { message: 'Invalid reseller ID' }),
  priceBDT: z.number().min(0).nullable().optional().default(null),
  pricePKR: z.number().min(0).nullable().optional().default(null),
  priceUSDT: z.number().min(0).nullable().optional().default(null)
});

const createProductSchema = productSchema.extend({
  resellerAssignments: z.array(productResellerAssignmentSchema).max(500).optional().default([])
});

const paymentMethodSchema = z.object({
  key: z.literal('pakistan'),
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
  type: z.enum(['credentials', 'activation_code', 'login_code', 'manual', 'instruction']),
  payload: z.object({
    deliveryMode: z.enum(['credentials', 'activation_code', 'login_code', 'manual']).optional(),
    email: z.string().max(200).optional().default(''),
    password: z.string().max(500).optional().default(''),
    activationCode: z.string().max(1000).optional().default(''),
    instruction: z.string().max(8000).optional().default(''),
    videoUrl: z.string().max(1000).optional().default(''),
    imageUrl: z.string().max(1000).optional().default(''),
    getCodeAccessDays: z.number().int().min(1).max(3650).optional().default(25),
    extra: z.record(z.any()).optional()
  }),
  adminNote: z.string().max(500).optional().default('')
});

const mailAccountSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().max(500).optional().default(''),
  refreshToken: z.string().min(10).max(5000),
  clientId: z.string().min(10).max(500)
});

const mailTxtFileSchema = z.object({
  name: z.string().min(1).max(160),
  accounts: z.array(mailAccountSchema).min(1).max(5000)
});

const promoSchema = z.object({
  code: z.string().min(2).max(40).regex(/^[A-Za-z0-9_-]+$/),
  description: z.string().max(300).optional().default(''),
  discountType: z.enum(['percent', 'fixed']),
  percentOff: z.number().min(0).max(100).optional().default(0),
  fixedBDT: z.number().min(0).optional().default(0),
  fixedPKR: z.number().min(0).optional().default(0),
  fixedUSDT: z.number().min(0).optional().default(0),
  maxUses: z.number().min(0).optional().default(0),
  minAmountBDT: z.number().min(0).optional().default(0),
  minAmountPKR: z.number().min(0).optional().default(0),
  minAmountUSDT: z.number().min(0).optional().default(0),
  productIds: z.array(z.string().refine((value) => validator.isMongoId(value), { message: 'Invalid product ID' })).optional().default([]),
  startsAt: z.string().nullable().optional().default(null),
  expiresAt: z.string().nullable().optional().default(null),
  isActive: z.boolean().optional().default(true),
  showOnHomepage: z.boolean().optional().default(false),
  allowResellers: z.boolean().optional().default(false)
});

function promoPayload(data) {
  return {
    ...data,
    code: data.code.toUpperCase().trim(),
    startsAt: data.startsAt ? new Date(data.startsAt) : null,
    expiresAt: data.expiresAt ? new Date(data.expiresAt) : null
  };
}

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

const DASHBOARD_TZ_OFFSET_MS = 6 * 60 * 60 * 1000;
const MONEY_CODES = ['BDT', 'PKR', 'USDT', 'USD'];
const SOLD_STATUSES = new Set(['approved', 'delivered']);

function blankMoney() {
  return { BDT: 0, PKR: 0, USDT: 0, USD: 0 };
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function addMoney(target, currency, amount) {
  const key = MONEY_CODES.includes(currency) ? currency : 'USDT';
  target[key] = roundMoney(Number(target[key] || 0) + Number(amount || 0));
  return target;
}

function bdDateParts(date) {
  const shifted = new Date(new Date(date).getTime() + DASHBOARD_TZ_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    date: shifted.getUTCDate()
  };
}

function bdDateFromParts(year, month, date, endOfDay = false) {
  return new Date(Date.UTC(year, month, date, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0) - DASHBOARD_TZ_OFFSET_MS);
}

function startOfBdDay(date = new Date()) {
  const p = bdDateParts(date);
  return bdDateFromParts(p.year, p.month, p.date);
}

function endOfBdDay(date = new Date()) {
  const p = bdDateParts(date);
  return bdDateFromParts(p.year, p.month, p.date, true);
}

function parseBdDate(value, fallback, endOfDay = false) {
  const raw = String(value || '').slice(0, 10);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return fallback;
  return bdDateFromParts(Number(match[1]), Number(match[2]) - 1, Number(match[3]), endOfDay);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function dashboardPeriod(mode, query) {
  const todayEnd = endOfBdDay(new Date());
  let start = startOfBdDay(addDays(todayEnd, -6));
  let end = todayEnd;

  if (mode === 'monthly') {
    const now = bdDateParts(new Date());
    const year = Number(query.year || now.year);
    const month = Math.max(1, Math.min(12, Number(query.month || now.month + 1))) - 1;
    start = bdDateFromParts(year, month, 1);
    end = bdDateFromParts(year, month + 1, 0, true);
  } else if (mode === 'custom') {
    start = parseBdDate(query.start, start);
    end = parseBdDate(query.end, end, true);
    if (start > end) [start, end] = [endOfBdDay(end), startOfBdDay(start)];
  } else if (mode === 'lifetime') {
    start = null;
    end = null;
  } else {
    end = parseBdDate(query.end, todayEnd, true);
    start = query.start ? parseBdDate(query.start, start) : startOfBdDay(addDays(end, -6));
  }

  let previousStart = null;
  let previousEnd = null;
  if (start && end) {
    const durationMs = end.getTime() - start.getTime() + 1;
    previousEnd = new Date(start.getTime() - 1);
    previousStart = new Date(previousEnd.getTime() - durationMs + 1);
  }
  return { start, end, previousStart, previousEnd, mode };
}

function publicPeriod(period, mode) {
  return {
    mode,
    start: period.start?.toISOString?.() || null,
    end: period.end?.toISOString?.() || null,
    previousStart: period.previousStart?.toISOString?.() || null,
    previousEnd: period.previousEnd?.toISOString?.() || null
  };
}

function inDashboardPeriod(createdAt, period) {
  if (!period.start || !period.end) return true;
  const date = new Date(createdAt || 0);
  if (Number.isNaN(date.getTime())) return false;
  return date >= period.start && date <= period.end;
}

function isSoldOrder(order) {
  return SOLD_STATUSES.has(order.status);
}

function adminSaleValues(order, product = null) {
  const sellingPrice = roundMoney(order.productSnapshot?.price || 0);
  const snapshotBuying = Number(order.productSnapshot?.purchaseCost || 0);
  const buyingPrice = roundMoney(snapshotBuying > 0 ? snapshotBuying : Number(product?.purchaseCostPKR || 0));
  return {
    sellingPrice,
    buyingPrice,
    profit: roundMoney(sellingPrice - buyingPrice)
  };
}

async function adminDueSummary(adminId, recentLimit = 10) {
  const orders = await Order.find({
    approvedBy: adminId,
    status: { $in: ['approved', 'delivered'] },
    adminDueSettledAt: null
  }).sort({ approvedAt: -1, createdAt: -1 }).lean();
  const productIds = [...new Set(orders.map((order) => String(order.productId || '')).filter(Boolean))];
  const products = productIds.length ? await Product.find({ _id: { $in: productIds } }).select('purchaseCostPKR').lean() : [];
  const productMap = new Map(products.map((product) => [String(product._id), product]));

  const totals = orders.reduce((sum, order) => {
    const values = adminSaleValues(order, productMap.get(String(order.productId || '')));
    sum.totalSalesPKR += values.sellingPrice;
    sum.duePKR += values.buyingPrice;
    sum.profitPKR += values.profit;
    return sum;
  }, { totalSalesPKR: 0, duePKR: 0, profitPKR: 0 });

  return {
    currency: 'PKR',
    ...Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, roundMoney(value)])),
    orderCount: orders.length,
    recentSales: orders.slice(0, recentLimit).map((order) => ({
      id: order.orderId,
      productName: order.productSnapshot?.title || 'Product',
      customerName: order.customer?.name || '',
      customerEmail: order.customer?.email || '',
      status: order.status,
      approvedAt: order.approvedAt || order.createdAt,
      ...adminSaleValues(order, productMap.get(String(order.productId || '')))
    }))
  };
}

function normalizeCurrency(value) {
  const upper = String(value || 'USDT').toUpperCase();
  return MONEY_CODES.includes(upper) ? upper : 'USDT';
}

function priceRegion(order) {
  return order.priceRegion || order.productSnapshot?.priceRegion || 'world';
}

function suffixForRegion(region) {
  if (region === 'bd') return 'BDT';
  if (region === 'pk') return 'PKR';
  return 'USDT';
}

function productCost(product, region, baseName) {
  const suffix = suffixForRegion(region);
  return Number(product?.[`${baseName}${suffix}`] || 0);
}

function orderCurrency(order) {
  return normalizeCurrency(order.productSnapshot?.currency || order.currency);
}

function orderFinalAmount(order) {
  return Number(order.productSnapshot?.price ?? order.amount ?? 0);
}

function orderDiscount(order) {
  const snapshot = order.productSnapshot || {};
  const discount = Number(order.discountAmount ?? snapshot.discountAmount ?? 0);
  if (discount > 0) return discount;
  const original = Number(order.originalAmount ?? snapshot.originalAmount ?? 0);
  const final = orderFinalAmount(order);
  return original > final ? roundMoney(original - final) : 0;
}

function orderCostBreakdown(order, productMap) {
  const product = productMap.get(String(order.productId || ''));
  const region = priceRegion(order);
  const snapshot = order.productSnapshot || {};
  const purchaseCost = Number(snapshot.purchaseCost ?? productCost(product, region, 'purchaseCost'));
  const accountCost = Number(snapshot.accountCost ?? productCost(product, region, 'accountCost'));
  const paymentGatewayFee = Number(snapshot.paymentGatewayFee ?? productCost(product, region, 'paymentGatewayFee'));
  const otherExpense = Number(snapshot.otherExpense ?? productCost(product, region, 'otherExpense'));
  return { purchaseCost, accountCost, paymentGatewayFee, otherExpense };
}

function summarizeMoney(orders, productMap) {
  const revenue = blankMoney();
  const profit = blankMoney();
  const discount = blankMoney();
  const costs = {
    purchaseCost: blankMoney(),
    accountCost: blankMoney(),
    paymentGatewayFee: blankMoney(),
    otherExpense: blankMoney()
  };

  for (const order of orders) {
    const currency = orderCurrency(order);
    const amount = orderFinalAmount(order);
    const itemDiscount = orderDiscount(order);
    const itemCosts = orderCostBreakdown(order, productMap);
    const totalCost = Number(itemCosts.purchaseCost || 0);
    addMoney(revenue, currency, amount);
    addMoney(profit, currency, amount - totalCost);
    addMoney(discount, currency, itemDiscount);
    addMoney(costs.purchaseCost, currency, itemCosts.purchaseCost);
    addMoney(costs.accountCost, currency, itemCosts.accountCost);
    addMoney(costs.paymentGatewayFee, currency, itemCosts.paymentGatewayFee);
    addMoney(costs.otherExpense, currency, itemCosts.otherExpense);
  }

  return { revenue, profit, discount, costs };
}

function averageMoney(money, count) {
  if (!count) return blankMoney();
  return Object.fromEntries(MONEY_CODES.map((code) => [code, roundMoney(Number(money[code] || 0) / count)]));
}

function primaryTotal(money) {
  return Number(money.BDT || money.PKR || money.USDT || money.USD || 0);
}

function changePercent(current, previous) {
  if (!previous && !current) return 0;
  if (!previous) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function countStatuses(orders) {
  return orders.reduce((acc, order) => {
    const status = order.status || 'pending';
    acc[status] = Number(acc[status] || 0) + 1;
    return acc;
  }, { pending: 0, approved: 0, delivered: 0, rejected: 0, cancelled: 0, refunded: 0 });
}

function hoursSince(date) {
  const time = new Date(date || 0).getTime();
  if (!time) return 0;
  return (Date.now() - time) / (60 * 60 * 1000);
}

function chartKey(date, mode) {
  const parts = bdDateParts(date);
  if (mode === 'lifetime') return `${parts.year}-${String(parts.month + 1).padStart(2, '0')}`;
  return `${parts.year}-${String(parts.month + 1).padStart(2, '0')}-${String(parts.date).padStart(2, '0')}`;
}

function chartLabel(key, mode) {
  if (mode === 'lifetime') {
    const [year, month] = key.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  }
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function buildChartRows(orders, productMap, period) {
  const rows = new Map();
  for (const order of orders) {
    const key = chartKey(order.createdAt, period.mode);
    if (!rows.has(key)) rows.set(key, { key, label: chartLabel(key, period.mode), revenue: blankMoney(), profit: blankMoney(), orders: 0 });
    const row = rows.get(key);
    const money = summarizeMoney([order], productMap);
    for (const code of MONEY_CODES) {
      row.revenue[code] = roundMoney(row.revenue[code] + money.revenue[code]);
      row.profit[code] = roundMoney(row.profit[code] + money.profit[code]);
    }
    row.orders += 1;
  }

  return [...rows.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function summarizeCustomers(orders, productMap) {
  const customers = new Map();
  for (const order of orders) {
    const email = String(order.customer?.email || '').toLowerCase().trim();
    if (!email) continue;
    if (!customers.has(email)) {
      customers.set(email, {
        id: email,
        name: order.customer?.name || email.split('@')[0],
        email,
        phone: order.customer?.whatsapp || '',
        totalOrders: 0,
        totalProducts: 0,
        totalSpent: blankMoney(),
        totalProfit: blankMoney(),
        pendingOrders: 0,
        deliveredOrders: 0,
        rejectedOrders: 0,
        lastOrderAt: order.createdAt,
        products: {}
      });
    }
    const customer = customers.get(email);
    customer.totalOrders += 1;
    customer.totalProducts += isSoldOrder(order) ? 1 : 0;
    if (new Date(order.createdAt || 0) > new Date(customer.lastOrderAt || 0)) customer.lastOrderAt = order.createdAt;
    if (order.status === 'pending') customer.pendingOrders += 1;
    if (order.status === 'delivered') customer.deliveredOrders += 1;
    if (order.status === 'rejected') customer.rejectedOrders += 1;
    if (isSoldOrder(order)) {
      const currency = orderCurrency(order);
      const money = summarizeMoney([order], productMap);
      addMoney(customer.totalSpent, currency, money.revenue[currency]);
      addMoney(customer.totalProfit, currency, money.profit[currency]);
      const productName = order.productSnapshot?.title || productMap.get(String(order.productId || ''))?.title || 'Product';
      customer.products[productName] = Number(customer.products[productName] || 0) + 1;
    }
  }

  const list = [...customers.values()]
    .map((customer) => ({
      ...customer,
      products: Object.entries(customer.products).map(([name, quantity]) => ({ name, quantity })),
      status: customer.rejectedOrders > 0 ? 'Needs review' : customer.pendingOrders > 0 ? 'Pending' : 'Good'
    }))
    .sort((a, b) => primaryTotal(b.totalSpent) - primaryTotal(a.totalSpent));

  const returningCustomers = list.filter((customer) => customer.totalOrders > 1).length;
  const totalOrders = list.reduce((sum, customer) => sum + customer.totalOrders, 0);

  return {
    totalCustomers: list.length,
    newCustomers: list.filter((customer) => customer.totalOrders === 1).length,
    returningCustomers,
    repeatPurchaseRate: list.length ? Math.round((returningCustomers / list.length) * 1000) / 10 : 0,
    averagePurchasesPerCustomer: list.length ? Math.round((totalOrders / list.length) * 10) / 10 : 0,
    highestValueCustomer: list[0] || null,
    topCustomers: list.slice(0, 10)
  };
}

function buildProductPerformance(products, soldOrders, productMap, availableStockMap) {
  const rows = new Map(products.map((product) => [String(product._id), {
    productId: String(product._id),
    productName: product.title,
    category: product.category || 'AI Tools',
    unitsSold: 0,
    revenue: blankMoney(),
    purchaseCost: blankMoney(),
    netProfit: blankMoney(),
    profitMargin: 0,
    remainingStock: Number(availableStockMap.get(String(product._id)) || 0),
    status: Number(availableStockMap.get(String(product._id)) || 0) <= 0 ? 'Out of stock' : Number(availableStockMap.get(String(product._id)) || 0) <= 2 ? 'Low stock' : 'In stock',
    performanceTrend: []
  }]));

  for (const order of soldOrders) {
    const productId = String(order.productId || '');
    if (!rows.has(productId)) {
      const product = productMap.get(productId);
      rows.set(productId, {
        productId,
        productName: order.productSnapshot?.title || product?.title || 'Unknown product',
        category: product?.category || 'AI Tools',
        unitsSold: 0,
        revenue: blankMoney(),
        purchaseCost: blankMoney(),
        netProfit: blankMoney(),
        profitMargin: 0,
        remainingStock: Number(availableStockMap.get(productId) || 0),
        status: 'Sold',
        performanceTrend: []
      });
    }
    const row = rows.get(productId);
    const currency = orderCurrency(order);
    const money = summarizeMoney([order], productMap);
    row.unitsSold += 1;
    addMoney(row.revenue, currency, money.revenue[currency]);
    addMoney(row.netProfit, currency, money.profit[currency]);
    addMoney(row.purchaseCost, currency, money.costs.purchaseCost[currency]);
  }

  for (const row of rows.values()) {
    const revenue = primaryTotal(row.revenue);
    const profit = primaryTotal(row.netProfit);
    row.profitMargin = revenue ? Math.round((profit / revenue) * 1000) / 10 : 0;
  }

  return [...rows.values()].sort((a, b) => b.unitsSold - a.unitsSold || primaryTotal(b.revenue) - primaryTotal(a.revenue));
}

function orderStatusRows(counts, total) {
  return [
    { status: 'pending', label: 'Pending', count: counts.pending, color: '#f59e0b', to: '/admin/orders/pending' },
    { status: 'approved', label: 'Approved', count: counts.approved, color: '#6366f1', to: '/admin/orders/approved' },
    { status: 'delivered', label: 'Delivered', count: counts.delivered, color: '#10b981', to: '/admin/orders/delivered' },
    { status: 'rejected', label: 'Rejected', count: counts.rejected, color: '#ef4444', to: '/admin/orders/rejected' },
    { status: 'cancelled', label: 'Cancelled', count: counts.cancelled || 0, color: '#b91c1c', to: '/admin/orders/cancel' },
    { status: 'refunded', label: 'Refunded', count: counts.refunded || 0, color: '#94a3b8', to: '/admin/orders/rejected' }
  ].map((item) => ({ ...item, percent: total ? Math.round((item.count / total) * 1000) / 10 : 0 }));
}

function buildAttentionPanel({ pendingOrders, pendingOverOneHour, lowStock, outOfStock, rejectedAmount }) {
  const alerts = [];
  if (pendingOrders > 0) alerts.push({ type: 'pending_orders', priority: 'warning', title: `${pendingOrders} pending order${pendingOrders === 1 ? '' : 's'}`, description: 'Need approval or rejection', actionLabel: 'View', to: '/admin/orders/pending' });
  if (pendingOverOneHour > 0) alerts.push({ type: 'old_pending', priority: 'danger', title: `${pendingOverOneHour} order${pendingOverOneHour === 1 ? '' : 's'} waiting > 1 hour`, description: 'Customer may need a faster update', actionLabel: 'Review', to: '/admin/orders/pending' });
  if (lowStock.length > 0) alerts.push({ type: 'low_stock', priority: 'warning', title: `${lowStock.length} product${lowStock.length === 1 ? '' : 's'} low stock`, description: 'Add delivery stock soon', actionLabel: 'Add stock', to: '/admin/stock' });
  if (outOfStock.length > 0) alerts.push({ type: 'out_of_stock', priority: 'danger', title: `${outOfStock.length} product${outOfStock.length === 1 ? '' : 's'} out of stock`, description: 'Buy button is blocked for customers', actionLabel: 'Restock', to: '/admin/stock' });
  if (primaryTotal(rejectedAmount) > 0) alerts.push({ type: 'rejected_amount', priority: 'danger', title: 'Rejected order amount exists', description: 'Check failed/rejected payments', actionLabel: 'Open', to: '/admin/orders/rejected' });
  return alerts.slice(0, 6);
}

function dashboardKpis(scopedOrders, soldOrders, currentMoney, previousMoney, customerStats, orderCounts, rejectedOrders, productMap, chart) {
  const rejectedMoney = summarizeMoney(rejectedOrders, productMap);
  return [
    { key: 'revenue', title: 'Total Revenue', value: currentMoney.revenue, previous: previousMoney.revenue, changePct: changePercent(primaryTotal(currentMoney.revenue), primaryTotal(previousMoney.revenue)), sparkline: chart.map((row) => primaryTotal(row.revenue)) },
    { key: 'profit', title: 'Net Profit', value: currentMoney.profit, previous: previousMoney.profit, changePct: changePercent(primaryTotal(currentMoney.profit), primaryTotal(previousMoney.profit)), sparkline: chart.map((row) => primaryTotal(row.profit)) },
    { key: 'orders', title: 'Total Orders', value: scopedOrders.length, previous: 0, changePct: 0, sparkline: chart.map((row) => row.orders) },
    { key: 'customers', title: 'Total Customers', value: customerStats.totalCustomers, previous: 0, changePct: 0, sparkline: [] },
    { key: 'aov', title: 'Average Order Value', value: averageMoney(currentMoney.revenue, soldOrders.length), previous: averageMoney(previousMoney.revenue, 1), changePct: 0, sparkline: [] },
    { key: 'pending', title: 'Pending Orders', value: orderCounts.pending, previous: 0, changePct: 0, sparkline: [] },
    { key: 'delivered', title: 'Delivered Orders', value: orderCounts.delivered, previous: 0, changePct: 0, sparkline: [] },
    { key: 'rejected_amount', title: 'Rejected Amount', value: rejectedMoney.revenue, previous: blankMoney(), changePct: 0, sparkline: [] }
  ];
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
adminRouter.get('/supplier-sync', asyncHandler(async (req, res) => {
  res.json({ configured: supplierEnabled(), state: await SupplierSyncState.findById('plandaw').lean() });
}));
adminRouter.post('/supplier-sync/retry', requireOwner, asyncHandler(async (req, res) => {
  res.json(await runSupplierSync({ force: true }));
}));

adminRouter.use(['/resellers', '/reseller-payment-requests'], (req, res) => {
  res.status(404).json({ error: 'Reseller features are not available.' });
});

adminRouter.get('/me', (req, res) => res.json({ admin: req.admin }));

adminRouter.get('/dashboard', asyncHandler(async (req, res) => {
  const mode = ['weekly', 'monthly', 'lifetime', 'custom'].includes(req.query.mode) ? req.query.mode : 'weekly';
  const period = dashboardPeriod(mode, req.query);

  if (req.admin.role !== 'owner') {
    const [staffSummary, pendingOrders] = await Promise.all([
      adminDueSummary(req.admin._id, 25),
      Order.countDocuments({ status: 'pending' })
    ]);
    return res.json({
      mode: 'staff',
      period: publicPeriod(period, mode),
      staffSummary,
      stats: { pendingOrders }
    });
  }

  const [products, orders, stockItems, recentActivity, signedUpUsers, visitors] = await Promise.all([
    Product.find({ isDeleted: { $ne: true } }).sort({ sortOrder: 1, createdAt: -1 }).lean(),
    Order.find().sort({ createdAt: -1 }).lean(),
    StockItem.find().lean(),
    ActivityLog.find().sort({ createdAt: -1 }).limit(50).lean(),
    Customer.countDocuments(),
    Visitor.find().lean()
  ]);

  const activeProducts = products.filter((product) => product.isActive !== false);
  const productMap = new Map(products.map((product) => [String(product._id), product]));
  const availableStockMap = stockItems
    .filter((item) => item.status === 'available')
    .reduce((map, item) => {
      const key = String(item.productId || '');
      if (!key) return map;
      map.set(key, Number(map.get(key) || 0) + 1);
      return map;
    }, new Map());

  const scopedOrders = orders.filter((order) => inDashboardPeriod(order.createdAt, period));
  const previousOrders = period.previousStart && period.previousEnd
    ? orders.filter((order) => inDashboardPeriod(order.createdAt, { start: period.previousStart, end: period.previousEnd }))
    : [];
  const soldOrders = scopedOrders.filter(isSoldOrder);
  const rejectedInPeriod = scopedOrders.filter((order) => order.status === 'rejected');

  const currentMoney = summarizeMoney(soldOrders, productMap);
  const previousMoney = summarizeMoney(previousOrders.filter(isSoldOrder), productMap);
  const customerStats = summarizeCustomers(scopedOrders, productMap);
  const orderCounts = countStatuses(scopedOrders);
  const pendingOverOneHour = scopedOrders.filter((order) => order.status === 'pending' && hoursSince(order.createdAt) >= 1).length;
  const lowStock = activeProducts
    .map((product) => ({ productId: String(product._id), productName: product.title, available: Number(availableStockMap.get(String(product._id)) || 0) }))
    .filter((item) => item.available > 0 && item.available <= 2)
    .slice(0, 10);
  const outOfStock = activeProducts
    .filter((product) => Number(availableStockMap.get(String(product._id)) || 0) <= 0)
    .map((product) => ({ productId: String(product._id), productName: product.title, available: 0 }))
    .slice(0, 10);

  const chart = buildChartRows(soldOrders, productMap, period);
  const productPerformance = buildProductPerformance(activeProducts, soldOrders, productMap, availableStockMap);
  const salesByProduct = productPerformance.map((row) => ({
    productId: row.productId,
    productName: row.productName,
    sold: row.unitsSold,
    revenueBDT: row.revenue.BDT,
    revenuePKR: row.revenue.PKR,
    revenueWorld: row.revenue.USDT + row.revenue.USD,
    availableStock: row.remainingStock
  }));

  const attention = buildAttentionPanel({
    pendingOrders: orderCounts.pending,
    pendingOverOneHour,
    lowStock,
    outOfStock,
    rejectedAmount: summarizeMoney(rejectedInPeriod, productMap).revenue
  });
  const todayStart = startOfBdDay(new Date());
  const uniqueVisitors = visitors.length;
  const totalVisits = visitors.reduce((sum, visitor) => sum + Number(visitor.visitCount || 0), 0);
  const visitsToday = visitors.filter((visitor) => new Date(visitor.lastSeenAt || 0) >= todayStart).length;

  res.json({
    period: publicPeriod(period, mode),
    stats: {
      totalProducts: activeProducts.length,
      totalCustomers: customerStats.totalCustomers,
      signedUpUsers,
      uniqueVisitors,
      totalVisits,
      visitsToday,
      newCustomers: customerStats.newCustomers,
      returningCustomers: customerStats.returningCustomers,
      repeatPurchaseRate: customerStats.repeatPurchaseRate,
      averagePurchasesPerCustomer: customerStats.averagePurchasesPerCustomer,
      pendingOrders: orderCounts.pending,
      approvedOrders: orderCounts.approved,
      deliveredOrders: orderCounts.delivered,
      rejectedOrders: orderCounts.rejected,
      refundedOrders: 0,
      soldOrders: orderCounts.approved + orderCounts.delivered,
      totalOrders: scopedOrders.length,
      availableStock: [...availableStockMap.values()].reduce((sum, count) => sum + Number(count || 0), 0),
      lowStockProducts: lowStock.length,
      outOfStockProducts: outOfStock.length,
      pendingOverOneHour,
      revenue: currentMoney.revenue,
      profit: currentMoney.profit,
      costs: currentMoney.costs,
      discounts: currentMoney.discount,
      rejectedAmount: summarizeMoney(rejectedInPeriod, productMap).revenue,
      averageOrderValue: averageMoney(currentMoney.revenue, soldOrders.length),
      previousRevenue: previousMoney.revenue,
      previousProfit: previousMoney.profit,
      revenueChangePct: changePercent(primaryTotal(currentMoney.revenue), primaryTotal(previousMoney.revenue)),
      profitChangePct: changePercent(primaryTotal(currentMoney.profit), primaryTotal(previousMoney.profit)),
      orderChangePct: changePercent(soldOrders.length, previousOrders.filter(isSoldOrder).length)
    },
    kpis: dashboardKpis(scopedOrders, soldOrders, currentMoney, previousMoney, customerStats, orderCounts, rejectedInPeriod, productMap, chart),
    chart,
    orderStatus: orderStatusRows(orderCounts, scopedOrders.length),
    salesByProduct,
    productPerformance,
    topCustomers: customerStats.topCustomers,
    lowStock,
    outOfStock,
    attention,
    recentOrders: scopedOrders.slice(0, 10),
    recentActivity: recentActivity.slice(0, 12)
  });
}));

function customerOrderSafe(order) {
  return {
    id: order.orderId,
    productName: order.productSnapshot?.title || order.productId?.title || 'Product',
    productLogoUrl: order.productSnapshot?.logoUrl || '',
    productIcon: order.productSnapshot?.icon || '✨',
    batchId: order.batchId || '',
    amount: order.productSnapshot?.price || 0,
    currency: order.productSnapshot?.currency || 'USDT',
    status: order.status,
    paymentMethod: order.paymentMethod,
    transactionId: order.transactionId || '',
    customerOrderRef: order.customerOrderRef || '',
    createdAt: order.createdAt,
    reviewedAt: order.reviewedAt || null,
    approvedAt: order.approvedAt || null,
    deliveredAt: order.deliveredAt || null,
    rejectedAt: order.rejectedAt || null,
    cancelledAt: order.cancelledAt || null,
    approvedByNickname: order.approvedByNickname || '',
    deliveredByNickname: order.deliveredByNickname || '',
    rejectedByNickname: order.rejectedByNickname || '',
    cancelledByNickname: order.cancelledByNickname || '',
    rejectReason: order.rejectReason || '',
    cancelReason: order.cancelReason || ''
  };
}

function customerSummary(customer, orders) {
  const email = customer?.email || orders[0]?.customer?.email || '';
  const name = customer?.name || orders[0]?.customer?.name || email;
  return {
    id: customer?._id?.toString() || '',
    key: customer?._id?.toString() || email,
    name,
    email,
    whatsapp: orders.find((order) => order.customer?.whatsapp)?.customer?.whatsapp || '',
    picture: customer?.picture || '',
    orderCount: orders.length,
    lastOrderAt: orders[0]?.createdAt || null,
    joinedAt: customer?.createdAt || null,
    lastLoginAt: customer?.lastLoginAt || null
  };
}

function ledgerBalance(entries) {
  return entries.reduce((balances, entry) => {
    const currency = String(entry.currency || 'BDT');
    balances[currency] = Math.round(((balances[currency] || 0) + Number(entry.amount || 0)) * 100) / 100;
    return balances;
  }, {});
}

// A rejected credit order must never remain in a reseller's payable balance.
// Keep the original charge and add a matching reversal instead of deleting
// financial history, so the statement stays auditable.
async function voidRejectedResellerDue(order, resellerId, { reason = '', admin = null } = {}) {
  if (order?.paymentMethod !== 'reseller_due' || !resellerId) return false;

  const invoice = await ResellerInvoice.findOne({ resellerId, orderId: order.orderId }).lean();
  if (!invoice || invoice.status === 'void') return false;

  const [charge, existingReversal] = await Promise.all([
    ResellerLedger.findOne({ resellerId, orderId: order.orderId, kind: 'order_charge' }).lean(),
    ResellerLedger.findOne({ resellerId, orderId: order.orderId, kind: 'order_reversal' }).lean()
  ]);
  const reverseAmount = Math.abs(Number(charge?.amount || invoice.originalAmount || invoice.remainingAmount || 0));
  const actor = admin?.nickname || admin?.name || 'System';

  if (reverseAmount > 0 && !existingReversal) {
    await ResellerLedger.create({
      resellerId,
      orderId: order.orderId,
      kind: 'order_reversal',
      currency: charge?.currency || invoice.currency || 'BDT',
      amount: -reverseAmount,
      note: `Rejected order reversal${reason ? `: ${reason}` : ''}`,
      createdByAdminId: admin?._id || null,
      createdByNickname: actor
    });
  }

  await ResellerInvoice.findByIdAndUpdate(invoice._id, { $set: {
    remainingAmount: 0,
    status: 'void',
    voidedAt: new Date(),
    voidReason: reason || order.rejectReason || 'Order rejected',
    voidedByAdminId: admin?._id || null,
    voidedByNickname: actor
  } }, { new: true });
  return true;
}

// Repairs invoices created before the rejection reversal existed. This is
// idempotent and runs only when that reseller's profile is opened.
async function reconcileRejectedResellerInvoices(reseller) {
  const invoices = await ResellerInvoice.find({ resellerId: reseller._id }).lean();
  for (const invoice of invoices) {
    if (invoice.status === 'void') continue;
    const order = await Order.findOne({
      orderId: invoice.orderId,
      paymentMethod: 'reseller_due',
      status: 'rejected'
    }).lean();
    if (order) await voidRejectedResellerDue(order, reseller._id, { reason: order.rejectReason || 'Order rejected' });
  }
}

async function emailDeliveryReceiptOnce(order) {
  if (!order?.assignedStockItemId || order.deliveryEmailSentAt) return { sent: false, status: 'already_sent_or_unavailable' };
  const stock = await StockItem.findById(order.assignedStockItemId).lean();
  if (!stock) return { sent: false, status: 'missing_stock' };
  const delivery = decryptJson(stock.encryptedPayload);
  const result = await sendDeliveryEmail({ order, delivery });
  if (result.sent) {
    order.deliveryEmailSentAt = new Date();
    await order.save();
  }
  return result;
}

async function resellerWithBalance(reseller) {
  const [entries, accesses, invoices] = await Promise.all([
    ResellerLedger.find({ resellerId: reseller._id }).sort({ createdAt: -1 }).lean(),
    ResellerProductAccess.find({ resellerId: reseller._id, isVisible: true }).lean(),
    ResellerInvoice.find({ resellerId: reseller._id }).lean()
  ]);
  const balances = ledgerBalance(entries);
  const bdtDue = Number(balances.BDT || 0);
  return {
    id: reseller._id,
    customerId: reseller.customerId || null,
    name: reseller.name || reseller.email.split('@')[0],
    email: reseller.email,
    status: reseller.status || 'invited',
    creditLimitBDT: Number(reseller.creditLimitBDT || 0),
    internalNote: reseller.internalNote || '',
    joinedAt: reseller.createdAt || null,
    balances,
    visibleProductCount: accesses.length,
    openInvoiceCount: invoices.filter((invoice) => Number(invoice.remainingAmount || 0) > 0).length,
    creditUsedBDT: Math.max(0, bdtDue),
    creditAvailableBDT: Number(reseller.creditLimitBDT || 0) > 0 ? Math.max(0, Number(reseller.creditLimitBDT) - Math.max(0, bdtDue)) : null,
    lastEntryAt: entries[0]?.createdAt || null,
    transactionCount: entries.length
  };
}

// Signed-up Google users, with reseller status where one has been assigned.
adminRouter.get('/customers', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const re = q ? searchRegex(q) : null;
  const query = re ? { $or: [{ name: re }, { email: re }] } : {};
  const [customers, resellers] = await Promise.all([
    Customer.find(query).sort({ lastLoginAt: -1, createdAt: -1 }).limit(500).lean(),
    Reseller.find().lean()
  ]);
  const resellerByEmail = new Map(resellers.map((reseller) => [String(reseller.email || '').toLowerCase(), reseller]));
  res.json({ users: customers.map((customer) => {
    const reseller = resellerByEmail.get(String(customer.email || '').toLowerCase());
    return {
      id: customer._id,
      name: customer.name || '',
      email: customer.email || '',
      picture: customer.picture || '',
      joinedAt: customer.createdAt || null,
      lastLoginAt: customer.lastLoginAt || null,
      reseller: reseller ? { id: reseller._id, status: reseller.status || 'invited' } : null
    };
  }) });
}));

adminRouter.get('/resellers', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const re = q ? searchRegex(q) : null;
  const resellers = await Reseller.find(re ? { $or: [{ name: re }, { email: re }, { status: re }] } : {}).sort({ createdAt: -1 }).limit(500).lean();
  res.json({ resellers: await Promise.all(resellers.map(resellerWithBalance)) });
}));

adminRouter.get('/resellers/overview', asyncHandler(async (req, res) => {
  const resellers = await Reseller.find().sort({ createdAt: -1 }).limit(500).lean();
  const rows = await Promise.all(resellers.map(resellerWithBalance));
  const totalDueBDT = rows.reduce((sum, row) => sum + Math.max(0, Number(row.balances.BDT || 0)), 0);
  const active = rows.filter((row) => row.status === 'active').length;
  const invited = rows.filter((row) => row.status === 'invited').length;
  const suspended = rows.filter((row) => row.status === 'suspended').length;
  const creditAtRisk = rows.filter((row) => row.creditLimitBDT > 0 && Number(row.balances.BDT || 0) / row.creditLimitBDT >= 0.8).length;
  res.json({ summary: { total: rows.length, active, invited, suspended, totalDueBDT, creditAtRisk }, resellers: rows });
}));

adminRouter.post('/resellers', requireOwner, asyncHandler(async (req, res) => {
  const data = z.object({ email: z.string().email(), name: z.string().max(80).optional().default(''), creditLimitBDT: z.number().min(0).max(100000000).optional().default(0), internalNote: z.string().max(2000).optional().default('') }).parse(req.body);
  const email = data.email.toLowerCase().trim();
  const existing = await Reseller.findOne({ email });
  const customer = await Customer.findOne({ email }).lean();
  if (existing) return res.status(409).json({ error: 'This email is already in the reseller list' });
  const reseller = await Reseller.create({
    email,
    name: data.name || customer?.name || email.split('@')[0],
    customerId: customer?._id || null,
    status: customer ? 'active' : 'invited',
    creditLimitBDT: data.creditLimitBDT,
    internalNote: data.internalNote,
    createdByAdminId: req.admin._id,
    createdByNickname: req.admin.nickname || req.admin.name
  });
  await logActivity(req.admin, 'reseller.created', 'reseller', reseller._id, `${req.admin.nickname || req.admin.name} added reseller ${email}`);
  res.status(201).json({ reseller: await resellerWithBalance(reseller.toObject()) });
}));

adminRouter.get('/resellers/:id', asyncHandler(async (req, res) => {
  if (!validator.isMongoId(req.params.id)) return res.status(400).json({ error: 'Invalid reseller ID' });
  const reseller = await Reseller.findById(req.params.id).lean();
  if (!reseller) return res.status(404).json({ error: 'Reseller not found' });
  await reconcileRejectedResellerInvoices(reseller);
  const [products, accesses, entries, invoices, paymentRequests] = await Promise.all([
    Product.find({ isDeleted: { $ne: true } }).sort({ sortOrder: 1, createdAt: -1 }).lean(),
    ResellerProductAccess.find({ resellerId: reseller._id }).lean(),
    ResellerLedger.find({ resellerId: reseller._id }).sort({ createdAt: -1 }).limit(1000).lean(),
    ResellerInvoice.find({ resellerId: reseller._id }).sort({ createdAt: -1 }).limit(1000).lean(),
    ResellerPaymentRequest.find({ resellerId: reseller._id }).sort({ createdAt: -1 }).limit(100).lean()
  ]);
  const accessMap = new Map(accesses.map((access) => [String(access.productId), access]));
  res.json({
    reseller: await resellerWithBalance(reseller),
    products: products.map((product) => ({ product, access: accessMap.get(String(product._id)) || null })),
    statement: entries,
    invoices,
    paymentRequests,
    balances: ledgerBalance(entries)
  });
}));

adminRouter.get('/reseller-payment-requests', asyncHandler(async (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(String(req.query.status)) ? String(req.query.status) : 'pending';
  const requests = await ResellerPaymentRequest.find({ status }).sort({ createdAt: -1 }).limit(250).lean();
  const resellerIds = [...new Set(requests.map((request) => String(request.resellerId)))];
  const resellers = await Reseller.find({ _id: { $in: resellerIds } }).lean();
  const byId = new Map(resellers.map((reseller) => [String(reseller._id), reseller]));
  res.json({ requests: requests.map((request) => ({ ...request, reseller: byId.get(String(request.resellerId)) || null })) });
}));

adminRouter.post('/reseller-payment-requests/:id/approve', requireOwner, asyncHandler(async (req, res) => {
  if (!validator.isMongoId(req.params.id)) return res.status(400).json({ error: 'Invalid payment request ID' });
  const request = await ResellerPaymentRequest.findById(req.params.id).lean();
  if (!request) return res.status(404).json({ error: 'Payment request not found' });
  if (request.status !== 'pending') return res.status(409).json({ error: 'This payment request was already reviewed.' });
  let settlement;
  try { settlement = await settleResellerPayment({ resellerId: request.resellerId, amount: request.amount, currency: request.currency, paymentReference: request.transactionId, note: request.note || `Reseller ${request.channel} payment`, admin: req.admin }); }
  catch (error) { return res.status(409).json({ error: error.message || 'Could not settle payment.' }); }
  const updated = await ResellerPaymentRequest.findByIdAndUpdate(request._id, { $set: { status: 'approved', approvedAt: new Date(), approvedByAdminId: req.admin._id, approvedByNickname: req.admin.nickname || req.admin.name, receiptNo: settlement.receiptNo } }, { new: true });
  await logActivity(req.admin, 'reseller.payment_request_approved', 'reseller', request.resellerId, `${req.admin.nickname || req.admin.name} approved reseller payment ${request.transactionId}`, { receiptNo: settlement.receiptNo });
  await notifyResellerPaymentApproved(updated.toObject(), settlement.reseller, settlement);
  res.json({ request: updated.toObject(), ...settlement, entries: settlement.records.map((record) => record.toObject()) });
}));

adminRouter.post('/reseller-payment-requests/:id/reject', requireOwner, asyncHandler(async (req, res) => {
  if (!validator.isMongoId(req.params.id)) return res.status(400).json({ error: 'Invalid payment request ID' });
  const data = z.object({ reason: z.string().max(500).optional().default('') }).parse(req.body);
  const request = await ResellerPaymentRequest.findById(req.params.id).lean();
  if (!request) return res.status(404).json({ error: 'Payment request not found' });
  if (request.status !== 'pending') return res.status(409).json({ error: 'This payment request was already reviewed.' });
  const updated = await ResellerPaymentRequest.findByIdAndUpdate(request._id, { $set: { status: 'rejected', rejectedAt: new Date(), rejectedByAdminId: req.admin._id, rejectedByNickname: req.admin.nickname || req.admin.name, rejectReason: data.reason } }, { new: true });
  res.json({ request: updated.toObject() });
}));

adminRouter.patch('/resellers/:id', requireOwner, asyncHandler(async (req, res) => {
  if (!validator.isMongoId(req.params.id)) return res.status(400).json({ error: 'Invalid reseller ID' });
  const data = z.object({ name: z.string().max(80).optional(), status: z.enum(['invited', 'active', 'suspended']).optional(), creditLimitBDT: z.number().min(0).max(100000000).optional(), internalNote: z.string().max(2000).optional() }).parse(req.body);
  const reseller = await Reseller.findByIdAndUpdate(req.params.id, { $set: data }, { new: true });
  if (!reseller) return res.status(404).json({ error: 'Reseller not found' });
  await logActivity(req.admin, 'reseller.updated', 'reseller', reseller._id, `${req.admin.nickname || req.admin.name} updated reseller ${reseller.email}`);
  res.json({ reseller: await resellerWithBalance(reseller.toObject()) });
}));

adminRouter.put('/resellers/:id/products/:productId', requireOwner, asyncHandler(async (req, res) => {
  if (!validator.isMongoId(req.params.id) || !validator.isMongoId(req.params.productId)) return res.status(400).json({ error: 'Invalid reseller or product ID' });
  const data = z.object({ isVisible: z.boolean(), priceBDT: z.number().min(0).nullable().optional(), pricePKR: z.number().min(0).nullable().optional(), priceUSDT: z.number().min(0).nullable().optional(), priceUSD: z.number().min(0).nullable().optional(), note: z.string().max(500).optional().default('') }).parse(req.body);
  const [reseller, product] = await Promise.all([Reseller.findById(req.params.id).lean(), Product.findById(req.params.productId).lean()]);
  if (!reseller || !product) return res.status(404).json({ error: 'Reseller or product not found' });
  const access = await ResellerProductAccess.findOneAndUpdate(
    { resellerId: reseller._id, productId: product._id },
    { ...data, resellerId: reseller._id, productId: product._id, updatedByAdminId: req.admin._id, updatedByNickname: req.admin.nickname || req.admin.name },
    { upsert: true, new: true }
  );
  await logActivity(req.admin, 'reseller.product_access_updated', 'reseller', reseller._id, `${req.admin.nickname || req.admin.name} updated ${product.title} access for ${reseller.email}`);
  res.json({ access });
}));

adminRouter.post('/resellers/:id/payments', requireOwner, asyncHandler(async (req, res) => {
  if (!validator.isMongoId(req.params.id)) return res.status(400).json({ error: 'Invalid reseller ID' });
  const data = z.object({ amount: z.number().positive().max(100000000), currency: z.enum(['BDT', 'PKR', 'USDT', 'USD']).default('BDT'), discount: z.number().min(0).max(100000000).optional().default(0), paymentReference: z.string().max(200).optional().default(''), note: z.string().max(1000).optional().default('') }).parse(req.body);
  const reseller = await Reseller.findById(req.params.id).lean();
  if (!reseller) return res.status(404).json({ error: 'Reseller not found' });
  const receiptNo = `RSL-${Date.now()}-${String(reseller._id).slice(-4).toUpperCase()}`;
  const actor = req.admin.nickname || req.admin.name;
  const invoices = await ResellerInvoice.find({ resellerId: reseller._id, currency: data.currency, status: { $in: ['open', 'partial'] } }).sort({ createdAt: 1 }).lean();
  const outstanding = invoices.reduce((sum, invoice) => sum + Number(invoice.remainingAmount || 0), 0);
  if (!invoices.length || outstanding <= 0) return res.status(409).json({ error: `There is no open ${data.currency} due to settle.` });
  // "amount" is the invoice settlement total. A discount is included inside
  // that total, so 300 due with settlement 300 and discount 10 means 290 cash
  // received + 10 discount = 300 cleared. This avoids accidental credit.
  if (data.amount > outstanding + 0.01) return res.status(409).json({ error: `Settlement amount is more than the open ${data.currency} due (${outstanding}).` });
  if (data.discount > data.amount + 0.01) return res.status(400).json({ error: 'Discount cannot be greater than the settlement amount.' });
  const settlementAmount = Math.min(data.amount, outstanding);
  const discountAppliedTotal = Math.min(data.discount, settlementAmount);
  const paymentReceived = Math.max(0, Math.round((settlementAmount - discountAppliedTotal) * 100) / 100);
  const records = [];
  if (paymentReceived > 0) records.push(await ResellerLedger.create({ resellerId: reseller._id, kind: 'payment', currency: data.currency, amount: -paymentReceived, paymentReference: data.paymentReference, note: data.note || `Manual payment (${receiptNo})`, receiptNo, createdByAdminId: req.admin._id, createdByNickname: actor }));
  if (discountAppliedTotal > 0) records.push(await ResellerLedger.create({ resellerId: reseller._id, kind: 'discount', currency: data.currency, amount: -discountAppliedTotal, note: `Admin discount (${receiptNo})`, receiptNo, createdByAdminId: req.admin._id, createdByNickname: actor }));
  let paymentLeft = paymentReceived;
  let discountLeft = discountAppliedTotal;
  const allocations = [];
  for (const invoice of invoices) {
    const remaining = Number(invoice.remainingAmount || 0);
    if (remaining <= 0 || paymentLeft + discountLeft <= 0) continue;
    const paymentApplied = Math.min(remaining, paymentLeft);
    const discountApplied = Math.min(remaining - paymentApplied, discountLeft);
    const nextRemaining = Math.max(0, Math.round((remaining - paymentApplied - discountApplied) * 100) / 100);
    paymentLeft = Math.max(0, paymentLeft - paymentApplied);
    discountLeft = Math.max(0, discountLeft - discountApplied);
    await ResellerInvoice.findByIdAndUpdate(invoice._id, { $set: {
      paidAmount: Number(invoice.paidAmount || 0) + paymentApplied,
      discountAmount: Number(invoice.discountAmount || 0) + discountApplied,
      remainingAmount: nextRemaining,
      status: nextRemaining === 0 ? 'paid' : 'partial',
      lastReceiptNo: receiptNo
    } }, { new: true });
    allocations.push({ invoiceNo: invoice.orderId, paymentApplied, discountApplied, remainingAmount: nextRemaining });
  }
  const allEntries = await ResellerLedger.find({ resellerId: reseller._id }).sort({ createdAt: -1 }).lean();
  const balances = ledgerBalance(allEntries);
  const remainingDue = Math.max(0, Number(balances[data.currency] || 0));
  const mail = await sendResellerPaymentReceipt({ reseller, receiptNo, currency: data.currency, paymentReceived, discountApplied: discountAppliedTotal, allocations, remainingDue });
  await logActivity(req.admin, 'reseller.payment_recorded', 'reseller', reseller._id, `${actor} recorded ${paymentReceived} ${data.currency} payment for ${reseller.email}`, { receiptNo, settlementAmount, discount: discountAppliedTotal, emailStatus: mail.status });
  res.status(201).json({ receiptNo, settlementAmount, paymentReceived, discountApplied: discountAppliedTotal, entries: records.map((record) => record.toObject()), allocations, balances, emailStatus: mail.status });
}));

adminRouter.get('/customers/search', asyncHandler(async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (query.length < 2) return res.json({ customers: [] });
  const re = searchRegex(query);
  const [customers, orderMatches] = await Promise.all([
    Customer.find({ $or: [{ name: re }, { email: re }] }).sort({ lastLoginAt: -1, createdAt: -1 }).limit(20).lean(),
    Order.find({ $or: [{ 'customer.name': re }, { 'customer.email': re }, { 'customer.whatsapp': re }, { orderId: re }, { transactionId: re }, { customerOrderRef: re }] }).sort({ createdAt: -1 }).limit(80).lean()
  ]);
  const ordersByEmail = new Map();
  for (const order of orderMatches) {
    const email = String(order.customer?.email || '').toLowerCase();
    if (!email) continue;
    if (!ordersByEmail.has(email)) ordersByEmail.set(email, []);
    ordersByEmail.get(email).push(order);
  }
  const result = new Map();
  for (const customer of customers) {
    const email = String(customer.email || '').toLowerCase();
    result.set(email, customerSummary(customer, ordersByEmail.get(email) || []));
  }
  for (const [email, orders] of ordersByEmail) {
    if (!result.has(email)) result.set(email, customerSummary(null, orders));
  }
  res.json({ customers: Array.from(result.values()).sort((a, b) => String(b.lastOrderAt || b.lastLoginAt || b.joinedAt || '').localeCompare(String(a.lastOrderAt || a.lastLoginAt || a.joinedAt || ''))).slice(0, 20) });
}));

adminRouter.get('/customers/:key', asyncHandler(async (req, res) => {
  const key = decodeURIComponent(String(req.params.key || '')).trim();
  let customer = null;
  if (validator.isMongoId(key)) customer = await Customer.findById(key).lean();
  if (!customer && validator.isEmail(key)) customer = await Customer.findOne({ email: key.toLowerCase() }).lean();
  const email = String(customer?.email || (validator.isEmail(key) ? key.toLowerCase() : '')).toLowerCase();
  if (!email) return res.status(404).json({ error: 'Customer not found' });
  const orderOwnerFilters = [{ 'customer.email': email }];
  if (customer?._id) orderOwnerFilters.unshift({ customerId: customer._id });
  const orders = await Order.find({ $or: orderOwnerFilters }).populate('productId', 'title slug').sort({ createdAt: -1 }).limit(200).lean();
  if (!customer && !orders.length) return res.status(404).json({ error: 'Customer not found' });

  const history = [];
  if (customer?.createdAt) history.push({ type: 'signup', at: customer.createdAt, title: 'Customer account created', detail: 'Google sign-in account created.' });
  if (customer?.lastLoginAt) history.push({ type: 'login', at: customer.lastLoginAt, title: 'Last sign-in', detail: 'Customer last signed in with Google.' });
  for (const order of orders) {
    history.push({ type: 'order', at: order.createdAt, title: `Order ${order.orderId} submitted`, detail: order.productSnapshot?.title || 'Product order' });
    if (order.approvedAt) history.push({ type: 'approved', at: order.approvedAt, title: `Order ${order.orderId} approved`, detail: order.approvedByNickname ? `Approved by ${order.approvedByNickname}` : '' });
    if (order.deliveredAt) history.push({ type: 'delivered', at: order.deliveredAt, title: `Order ${order.orderId} delivered`, detail: order.deliveredByNickname ? `Delivered by ${order.deliveredByNickname}` : '' });
    if (order.rejectedAt) history.push({ type: 'rejected', at: order.rejectedAt, title: `Order ${order.orderId} rejected`, detail: order.rejectReason || '' });
    if (order.cancelledAt) history.push({ type: 'cancelled', at: order.cancelledAt, title: `Order ${order.orderId} cancelled`, detail: order.cancelReason || '' });
  }
  history.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  res.json({
    customer: customerSummary(customer, orders),
    orders: orders.map(customerOrderSafe),
    summary: {
      totalOrders: orders.length,
      pendingOrders: orders.filter((order) => order.status === 'pending').length,
      approvedOrders: orders.filter((order) => order.status === 'approved').length,
      deliveredOrders: orders.filter((order) => order.status === 'delivered').length,
      rejectedOrders: orders.filter((order) => order.status === 'rejected').length,
      cancelledOrders: orders.filter((order) => order.status === 'cancelled').length
    },
    history: history.slice(0, 250)
  });
}));

// Delivery credentials are revealed only for a selected order and each view is audited.
adminRouter.get('/customers/orders/:orderId/delivery', asyncHandler(async (req, res) => {
  const order = await Order.findOne({ orderId: req.params.orderId }).lean();
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status === 'cancelled') return res.status(410).json({ error: 'Delivery access was removed because this order is cancelled.' });
  if (!order.assignedStockItemId) return res.status(404).json({ error: 'No delivery details are assigned to this order yet' });
  const stock = await StockItem.findById(order.assignedStockItemId).lean();
  if (!stock) return res.status(404).json({ error: 'Delivery item not found' });
  const payload = decryptJson(stock.encryptedPayload);
  await logActivity(req.admin, 'customer.delivery_revealed', 'order', order.orderId, `${req.admin.nickname || req.admin.name} viewed delivery details for ${order.orderId}`, { customerEmail: order.customer?.email || '' });
  res.json({ delivery: { orderId: order.orderId, deliveryMode: payload.deliveryMode || stock.type, email: payload.email || '', password: payload.password || '', activationCode: payload.activationCode || '', instruction: payload.instruction || '', videoUrl: payload.videoUrl || '', imageUrl: payload.imageUrl || '' } });
}));

// Owner-only admin management
adminRouter.get('/users', requireOwner, asyncHandler(async (req, res) => {
  const admins = await Admin.find().sort({ role: -1, createdAt: -1 }).select('-passwordHash').lean();
  const rows = await Promise.all(admins.map(async (admin) => ({
    ...adminSafe(admin),
    ...(admin.role === 'owner' ? { currency: 'PKR', totalSalesPKR: 0, duePKR: 0, profitPKR: 0, orderCount: 0 } : await adminDueSummary(admin._id, 0))
  })));
  res.json({ admins: rows });
}));

adminRouter.post('/users/:id/due/clear', requireOwner, asyncHandler(async (req, res) => {
  if (!validator.isMongoId(req.params.id)) return res.status(400).json({ error: 'Invalid admin ID' });
  const admin = await Admin.findById(req.params.id).lean();
  if (!admin) return res.status(404).json({ error: 'Admin not found' });
  if (admin.role === 'owner') return res.status(400).json({ error: 'Owner does not have an admin due balance.' });

  const settledAt = new Date();
  const settlementId = `ADMIN-${Date.now()}-${String(admin._id).slice(-6)}`;
  const filter = {
    approvedBy: admin._id,
    status: { $in: ['approved', 'delivered'] },
    adminDueSettledAt: null
  };
  await Order.updateMany(filter, { $set: {
    adminSettlementId: settlementId,
    adminDueSettledAt: settledAt,
    adminDueSettledBy: req.admin._id,
    adminDueSettledByNickname: req.admin.nickname || req.admin.name
  } });

  const settledOrders = await Order.find({ adminSettlementId: settlementId }).lean();
  const productIds = [...new Set(settledOrders.map((order) => String(order.productId || '')).filter(Boolean))];
  const products = productIds.length ? await Product.find({ _id: { $in: productIds } }).select('purchaseCostPKR').lean() : [];
  const productMap = new Map(products.map((product) => [String(product._id), product]));
  const totals = settledOrders.reduce((sum, order) => {
    const values = adminSaleValues(order, productMap.get(String(order.productId || '')));
    sum.totalSalesPKR += values.sellingPrice;
    sum.duePKR += values.buyingPrice;
    sum.profitPKR += values.profit;
    return sum;
  }, { totalSalesPKR: 0, duePKR: 0, profitPKR: 0 });
  Object.keys(totals).forEach((key) => { totals[key] = roundMoney(totals[key]); });

  await logActivity(req.admin, 'admin.due_cleared', 'admin', admin._id, `${req.admin.nickname || req.admin.name} cleared ${admin.nickname || admin.name}'s PKR ${totals.duePKR} due`, {
    settlementId,
    orderCount: settledOrders.length,
    ...totals
  });
  res.json({ settlementId, settledAt, orderCount: settledOrders.length, ...totals });
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

adminRouter.patch('/products/reorder', asyncHandler(async (req, res) => {
  const data = z.object({
    products: z.array(z.object({
      id: z.string().refine((value) => validator.isMongoId(value), { message: 'Invalid product ID' }),
      sortOrder: z.number().int().min(1).max(100000)
    })).min(1).max(500)
  }).parse(req.body);

  const session = await Product.startSession();
  try {
    await session.withTransaction(async () => {
      for (const item of data.products) {
        await Product.updateOne(
          { _id: item.id },
          {
            $set: {
              sortOrder: item.sortOrder,
              updatedByAdminId: req.admin._id,
              updatedByNickname: req.admin.nickname || req.admin.name
            }
          },
          { session }
        );
      }
    });
  } finally {
    await session.endSession();
  }

  await logActivity(req.admin, 'product.reordered', 'product', req.admin._id, `${req.admin.nickname || req.admin.name} updated product display order`);
  const products = await Product.find({ isDeleted: { $ne: true } }).sort({ sortOrder: 1, createdAt: -1 }).lean();
  res.json({ products });
}));

adminRouter.get('/products', asyncHandler(async (req, res) => {
  const products = await Product.find({ isDeleted: { $ne: true } }).sort({ sortOrder: 1, createdAt: -1 }).lean();
  res.json({ products });
}));

adminRouter.post('/products', asyncHandler(async (req, res) => {
  const { resellerAssignments, ...data } = createProductSchema.parse(req.body);
  const resellerIds = [...new Set(resellerAssignments.map((item) => item.resellerId))];
  const resellers = resellerIds.length ? await Reseller.find({ _id: { $in: resellerIds } }).lean() : [];
  if (resellers.length !== resellerIds.length) {
    return res.status(400).json({ error: 'One or more selected resellers no longer exist. Refresh the list and try again.' });
  }
  const suspended = resellers.find((reseller) => reseller.status === 'suspended');
  if (suspended) {
    return res.status(400).json({ error: `${suspended.email} is suspended and cannot receive product access.` });
  }
  const product = await Product.create({ ...data, createdByAdminId: req.admin._id, createdByNickname: req.admin.nickname || req.admin.name });
  for (const assignment of resellerAssignments) {
    await ResellerProductAccess.findOneAndUpdate(
      { resellerId: assignment.resellerId, productId: product._id },
      {
        resellerId: assignment.resellerId,
        productId: product._id,
        isVisible: true,
        priceBDT: assignment.priceBDT,
        pricePKR: assignment.pricePKR,
        priceUSDT: assignment.priceUSDT,
        updatedByAdminId: req.admin._id,
        updatedByNickname: req.admin.nickname || req.admin.name
      },
      { upsert: true, new: true }
    );
  }
  await logActivity(req.admin, 'product.created', 'product', product._id, `${req.admin.nickname || req.admin.name} added product ${product.title}`);
  res.status(201).json({ product, resellerAssignmentCount: resellerAssignments.length });
}));

adminRouter.patch('/products/:id', asyncHandler(async (req, res) => {
  if (!validator.isMongoId(req.params.id)) return res.status(400).json({ error: 'Invalid product ID' });
  const data = productSchema.partial().parse(req.body);
  const product = await Product.findOneAndUpdate(
    { _id: req.params.id, isDeleted: { $ne: true } },
    { ...data, updatedByAdminId: req.admin._id, updatedByNickname: req.admin.nickname || req.admin.name },
    { new: true, runValidators: true }
  );
  if (!product) return res.status(404).json({ error: 'Product not found' });
  await logActivity(req.admin, 'product.updated', 'product', product._id, `${req.admin.nickname || req.admin.name} updated product ${product.title}`);
  res.json({ product });
}));

adminRouter.delete('/products/:id', asyncHandler(async (req, res) => {
  if (!validator.isMongoId(req.params.id)) return res.status(400).json({ error: 'Invalid product ID' });
  const product = await Product.findByIdAndUpdate(req.params.id, { isActive: false, isDeleted: true, deletedAt: new Date(), updatedByAdminId: req.admin._id, updatedByNickname: req.admin.nickname || req.admin.name }, { new: true });
  if (!product) return res.status(404).json({ error: 'Product not found' });
  await logActivity(req.admin, 'product.disabled', 'product', product._id, `${req.admin.nickname || req.admin.name} disabled product ${product.title}`);
  res.json({ product, message: 'Product deleted' });
}));

// Payment methods
adminRouter.get('/payment-methods', asyncHandler(async (req, res) => {
  const methods = await PaymentMethod.find({ key: 'pakistan' }).sort({ key: 1 }).lean();
  res.json({ methods });
}));

adminRouter.put('/payment-methods/:key', asyncHandler(async (req, res) => {
  const data = paymentMethodSchema.parse({ ...req.body, key: req.params.key });
  const method = await PaymentMethod.findOneAndUpdate({ key: data.key }, data, { upsert: true, new: true, runValidators: true });
  await logActivity(req.admin, 'payment.updated', 'paymentMethod', data.key, `${req.admin.nickname || req.admin.name} updated ${data.title} payment settings`);
  res.json({ method });
}));

// Promo codes
adminRouter.get('/promo-codes', asyncHandler(async (req, res) => {
  const promos = await PromoCode.find().sort({ createdAt: -1 }).lean();
  res.json({ promos });
}));

adminRouter.post('/promo-codes', asyncHandler(async (req, res) => {
  const data = promoPayload(promoSchema.parse(req.body));
  const promo = await PromoCode.create({
    ...data,
    createdByAdminId: req.admin._id,
    createdByNickname: req.admin.nickname || req.admin.name
  });
  await logActivity(req.admin, 'promo.created', 'promoCode', promo._id, `${req.admin.nickname || req.admin.name} created promo ${promo.code}`);
  res.status(201).json({ promo });
}));

adminRouter.put('/promo-codes/:id', asyncHandler(async (req, res) => {
  if (!validator.isMongoId(req.params.id)) return res.status(400).json({ error: 'Invalid promo ID' });
  const data = promoPayload(promoSchema.parse(req.body));
  const promo = await PromoCode.findByIdAndUpdate(
    req.params.id,
    { ...data, updatedByAdminId: req.admin._id, updatedByNickname: req.admin.nickname || req.admin.name },
    { new: true, runValidators: true }
  );
  if (!promo) return res.status(404).json({ error: 'Promo code not found' });
  await logActivity(req.admin, 'promo.updated', 'promoCode', promo._id, `${req.admin.nickname || req.admin.name} updated promo ${promo.code}`);
  res.json({ promo });
}));

adminRouter.patch('/promo-codes/:id/status', asyncHandler(async (req, res) => {
  if (!validator.isMongoId(req.params.id)) return res.status(400).json({ error: 'Invalid promo ID' });
  const promo = await PromoCode.findByIdAndUpdate(
    req.params.id,
    { isActive: !!req.body.isActive, updatedByAdminId: req.admin._id, updatedByNickname: req.admin.nickname || req.admin.name },
    { new: true, runValidators: true }
  );
  if (!promo) return res.status(404).json({ error: 'Promo code not found' });
  res.json({ promo });
}));

adminRouter.delete('/promo-codes/:id', asyncHandler(async (req, res) => {
  if (!validator.isMongoId(req.params.id)) return res.status(400).json({ error: 'Invalid promo ID' });
  const promo = await PromoCode.findByIdAndDelete(req.params.id);
  if (!promo) return res.status(404).json({ error: 'Promo code not found' });
  await logActivity(req.admin, 'promo.deleted', 'promoCode', promo._id, `${req.admin.nickname || req.admin.name} deleted promo ${promo.code}`);
  res.json({ message: 'Promo code deleted' });
}));

// Stock
adminRouter.get('/stock', asyncHandler(async (req, res) => {
  const query = {};
  if (req.query.productId && validator.isMongoId(req.query.productId)) query.productId = req.query.productId;
  if (req.query.status) query.status = req.query.status;
  const stock = await StockItem.find(query).populate('productId', 'title slug').sort({ createdAt: -1 }).limit(300).lean();
  res.json({
    stock: stock.map((item) => ({
      ...item,
      status: item.status || 'available',
      payload: item.encryptedPayload ? decryptJson(item.encryptedPayload) : undefined,
      encryptedPayload: undefined
    }))
  });
}));

// Mail TXT files used by login-code delivery. Accounts stay encrypted at rest.
adminRouter.get('/mail-txt-files', asyncHandler(async (req, res) => {
  const files = await MailTxtFile.find()
    .sort({ createdAt: -1 })
    .limit(200)
    .select('-encryptedAccounts')
    .lean();

  res.json({
    files: files.map((file) => ({
      id: file._id?.toString(),
      _id: file._id,
      name: file.name,
      accountCount: file.accountCount || 0,
      uploadedByNickname: file.uploadedByNickname || '',
      createdAt: file.createdAt,
      updatedAt: file.updatedAt
    }))
  });
}));

adminRouter.post('/mail-txt-files', asyncHandler(async (req, res) => {
  const data = mailTxtFileSchema.parse(req.body);
  const accounts = data.accounts.map((account) => ({
    email: account.email.toLowerCase().trim(),
    password: account.password || '',
    refreshToken: account.refreshToken.trim(),
    clientId: account.clientId.trim()
  }));

  const file = await MailTxtFile.create({
    name: data.name.trim(),
    accountCount: accounts.length,
    encryptedAccounts: encryptJson(accounts),
    uploadedByAdminId: req.admin._id,
    uploadedByNickname: req.admin.nickname || req.admin.name
  });

  await logActivity(req.admin, 'mail_txt.uploaded', 'mailTxtFile', file._id, `${req.admin.nickname || req.admin.name} uploaded ${accounts.length} mail accounts`);
  res.status(201).json({
    file: {
      id: file._id?.toString(),
      _id: file._id,
      name: file.name,
      accountCount: file.accountCount,
      uploadedByNickname: file.uploadedByNickname,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt
    }
  });
}));

adminRouter.delete('/mail-txt-files/:id', asyncHandler(async (req, res) => {
  if (!validator.isMongoId(req.params.id)) return res.status(400).json({ error: 'Invalid TXT file ID' });
  const file = await MailTxtFile.findByIdAndDelete(req.params.id);
  if (!file) return res.status(404).json({ error: 'TXT file not found' });
  await logActivity(req.admin, 'mail_txt.deleted', 'mailTxtFile', file._id, `${req.admin.nickname || req.admin.name} deleted mail TXT ${file.name}`);
  res.json({ message: 'TXT file deleted' });
}));

adminRouter.post('/mail-txt/login-code', asyncHandler(async (req, res) => {
  const { email } = z.object({ email: z.string().email().max(200) }).parse(req.body);
  const result = await getLatestMailTxtLoginCode(email);
  await logActivity(req.admin, 'mail_txt.code_read', 'mailTxtAccount', email.toLowerCase().trim(), `${req.admin.nickname || req.admin.name} read the latest login code for ${email.toLowerCase().trim()}`);
  res.json(result);
}));

adminRouter.post('/stock', asyncHandler(async (req, res) => {
  const data = stockSchema.parse(req.body);
  if (!validator.isMongoId(data.productId)) return res.status(400).json({ error: 'Invalid product ID' });
  const product = await Product.findById(data.productId).lean();
  if (!product) return res.status(404).json({ error: 'Product not found' });
  const effectiveDeliveryMode = data.payload.deliveryMode || (data.type === 'instruction' ? 'manual' : data.type);
  const getCodeAccessExpiresAt = effectiveDeliveryMode === 'login_code'
    ? new Date(Date.now() + data.payload.getCodeAccessDays * 24 * 60 * 60 * 1000).toISOString()
    : '';

  const stock = await StockItem.create({
    productId: data.productId,
    type: data.type === 'instruction' ? 'manual' : data.type,
    status: 'available',
    encryptedPayload: encryptJson({
      ...data.payload,
      deliveryMode: effectiveDeliveryMode,
      getCodeAccessExpiresAt,
      instruction: data.payload.instruction || product.deliveryInstruction || '',
      videoUrl: data.payload.videoUrl || product.deliveryVideoUrl || '',
      imageUrl: data.payload.imageUrl || product.deliveryImageUrl || ''
    }),
    adminNote: data.adminNote || data.payload.instruction || '',
    createdByAdminId: req.admin._id,
    createdByNickname: req.admin.nickname || req.admin.name
  });
  if (effectiveDeliveryMode === 'manual') {
    // Manual stock means the product must use the customer-login activation
    // flow. Also repair any pending order created from an older snapshot.
    await Product.updateOne({ _id: product._id }, { $set: { deliveryMode: 'manual' } });
    await Order.updateMany(
      { productId: product._id, status: 'pending', 'productSnapshot.deliveryMode': { $ne: 'manual' } },
      { $set: { 'productSnapshot.deliveryMode': 'manual' } }
    );
  }
  await logActivity(req.admin, 'stock.created', 'stock', stock._id, `${req.admin.nickname || req.admin.name} added stock for ${product.title}`);
  res.status(201).json({
    stock: {
      ...stock.toObject(),
      status: stock.status || 'available',
      payload: decryptJson(stock.encryptedPayload),
      encryptedPayload: undefined
    }
  });
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
    .limit(500);
  await Promise.all(orders.map((order) => ensureManualActivationMode(order)));
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
  if (status && ['pending', 'approved', 'delivered', 'rejected', 'cancelled'].includes(status)) query.status = status;
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
    .limit(limit);
  await Promise.all(orders.map((order) => ensureManualActivationMode(order)));
  res.json({ orders });
}));

// Admin-only sold-account check. Delivery credentials stay encrypted at rest;
// this endpoint decrypts them server-side and returns only the email needed to
// detect accidental stock reuse. Passwords, keys and instructions never leave.
adminRouter.get('/orders/delivered-product-search', asyncHandler(async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!validator.isEmail(email)) return res.status(400).json({ error: 'Enter a valid delivered account email.' });

  const orders = await Order.find({ status: 'delivered' }).sort({ deliveredAt: -1, createdAt: -1 }).limit(1000).lean();
  const stockIds = [...new Set(orders.map((order) => String(order.assignedStockItemId || '')).filter(Boolean))];
  const stock = stockIds.length ? await StockItem.find({ _id: { $in: stockIds } }).lean() : [];
  const stockById = new Map(stock.map((item) => [String(item._id), item]));
  const matches = [];

  for (const order of orders) {
    const item = stockById.get(String(order.assignedStockItemId || ''));
    if (!item?.encryptedPayload) continue;
    try {
      const payload = decryptJson(item.encryptedPayload);
      const deliveredEmail = String(payload?.email || '').trim().toLowerCase();
      if (deliveredEmail !== email) continue;
      matches.push({
        orderId: order.orderId,
        productTitle: order.productSnapshot?.title || 'Product',
        deliveryEmail: deliveredEmail,
        deliveredAt: order.deliveredAt || item.deliveredAt || order.updatedAt || order.createdAt,
        customerEmail: order.customer?.email || '',
        resellerOrder: order.paymentMethod === 'reseller_due'
      });
      if (matches.length >= 50) break;
    } catch {
      // A damaged legacy payload should not prevent checking other deliveries.
    }
  }

  res.json({ email, sold: matches.length > 0, matches });
}));

// Owner-only cancellation preview. An exact order ID is required so a money-
// affecting action can never target an ambiguous search result.
adminRouter.get('/orders/:orderId/cancellation-preview', requireOwner, asyncHandler(async (req, res) => {
  const orderId = String(req.params.orderId || '').trim();
  const order = await Order.findOne({ orderId }).lean();
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!['approved', 'delivered', 'cancelled'].includes(order.status)) {
    return res.status(409).json({ error: `Only approved or delivered orders can be cancelled (current: ${order.status}).` });
  }

  let resellerAdjustment = null;
  if (order.paymentMethod === 'reseller_due') {
    const reseller = await Reseller.findOne({ email: String(order.customer?.email || '').toLowerCase() }).lean();
    if (reseller) {
      const [invoice, entries] = await Promise.all([
        ResellerInvoice.findOne({ resellerId: reseller._id, orderId: order.orderId }).lean(),
        ResellerLedger.find({ resellerId: reseller._id }).lean()
      ]);
      const balances = ledgerBalance(entries);
      const currency = invoice?.currency || order.productSnapshot?.currency || 'BDT';
      const reversalAmount = Math.abs(Number(invoice?.originalAmount || order.productSnapshot?.price || 0));
      resellerAdjustment = {
        currency,
        reversalAmount,
        currentDue: Number(balances[currency] || 0),
        dueAfterCancellation: Math.round((Number(balances[currency] || 0) - (order.status === 'cancelled' ? 0 : reversalAmount)) * 100) / 100,
        invoiceStatus: invoice?.status || 'missing'
      };
    }
  }

  res.json({
    order: {
      ...customerOrderSafe(order),
      customerName: order.customer?.name || '',
      customerEmail: order.customer?.email || '',
      paymentMethod: order.paymentMethod,
      assignedDelivery: Boolean(order.assignedStockItemId)
    },
    eligible: ['approved', 'delivered'].includes(order.status),
    resellerAdjustment
  });
}));

adminRouter.post('/orders/:orderId/cancel', requireOwner, asyncHandler(async (req, res) => {
  const data = z.object({ reason: z.string().trim().min(2).max(500) }).parse(req.body);
  try {
    const result = await cancelApprovedOrder({ orderId: req.params.orderId, admin: req.admin, reason: data.reason, source: 'admin' });
    res.json({
      message: result.alreadyCancelled ? 'Order was already cancelled.' : 'Order cancelled. Delivery access was revoked.',
      order: result.order,
      alreadyCancelled: result.alreadyCancelled,
      dueAdjustment: result.dueAdjustment
    });
  } catch (error) {
    res.status(error.message === 'Order not found' ? 404 : 409).json({ error: error.message });
  }
}));

async function ensureManualActivationMode(order) {
  if (!order || order.productSnapshot?.deliveryMode === 'manual') return true;
  const [product, manualStock] = await Promise.all([
    Product.findById(order.productId).select('deliveryMode').lean(),
    StockItem.countDocuments({ productId: order.productId, status: 'available', type: 'manual' })
  ]);
  if (product?.deliveryMode !== 'manual' && !manualStock) return false;
  order.productSnapshot = { ...(order.productSnapshot || {}), deliveryMode: 'manual' };
  if (typeof order.save === 'function') await order.save();
  else await Order.updateOne({ _id: order._id }, { $set: { productSnapshot: order.productSnapshot } });
  return true;
}

async function requiresManualActivation(order) {
  return ensureManualActivationMode(order);
}

adminRouter.get('/orders/:orderId/manual-activation', asyncHandler(async (req, res) => {
  const order = await Order.findOne({ orderId: req.params.orderId }).lean();
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!await requiresManualActivation(order)) return res.status(400).json({ error: 'This order is not a manual-delivery product' });
  const details = order.manualActivationEncrypted ? decryptJson(order.manualActivationEncrypted) : null;
  res.json({
    orderId: order.orderId,
    submitted: Boolean(order.manualActivationSubmittedAt),
    activated: Boolean(order.manualActivationActivatedAt),
    submittedAt: order.manualActivationSubmittedAt || null,
    activatedAt: order.manualActivationActivatedAt || null,
    activatedByNickname: order.manualActivationActivatedByNickname || '',
    details: details ? { email: details.email || '', password: details.password || '' } : null
  });
}));

adminRouter.post('/orders/:orderId/manual-activation/complete', asyncHandler(async (req, res) => {
  const order = await Order.findOne({ orderId: req.params.orderId });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!await requiresManualActivation(order)) return res.status(400).json({ error: 'This order is not a manual-delivery product' });
  if (!order.manualActivationSubmittedAt || !order.manualActivationEncrypted) return res.status(409).json({ error: 'Customer login details have not been submitted yet' });
  if (!order.manualActivationActivatedAt) {
    const nick = req.admin.nickname || req.admin.name;
    order.manualActivationActivatedAt = new Date();
    order.manualActivationActivatedBy = req.admin._id;
    order.manualActivationActivatedByNickname = nick;
    await order.save();
    await logActivity(req.admin, 'order.manual_activation.completed', 'order', order.orderId, `${nick} confirmed subscription activation for ${order.orderId}`);
  }
  res.json({ message: 'Subscription activation confirmed. Approve or deliver is now unlocked.', order });
}));

// Backorder records never borrow a random available account. The owner adds
// the exact credentials/key/manual note for this one customer first; only then
// can the normal approve/deliver actions use it.
adminRouter.post('/orders/:orderId/delivery-details', asyncHandler(async (req, res) => {
  const data = stockSchema.pick({ type: true, payload: true, adminNote: true }).parse(req.body);
  const order = await Order.findOne({ orderId: req.params.orderId });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'pending') return res.status(409).json({ error: `Delivery details can be added only while this order is pending (current: ${order.status}).` });
  if (order.assignedStockItemId) return res.status(409).json({ error: 'Delivery details are already assigned to this order.' });
  const product = await Product.findById(order.productId).lean();
  // Orders keep an immutable product snapshot, so an old/backorder delivery
  // must remain serviceable even if the catalog product was later removed or
  // recreated with a different ID. Never block customer delivery on the
  // current catalog row being present.
  const productDefaults = product || order.productSnapshot || {};

  const deliveryMode = data.payload.deliveryMode || (data.type === 'instruction' ? 'manual' : data.type);
  const getCodeAccessExpiresAt = deliveryMode === 'login_code'
    ? new Date(Date.now() + data.payload.getCodeAccessDays * 24 * 60 * 60 * 1000).toISOString()
    : '';
  const stock = await StockItem.create({
    productId: order.productId,
    type: data.type === 'instruction' ? 'manual' : data.type,
    status: 'reserved',
    assignedOrderId: order._id,
    encryptedPayload: encryptJson({
      ...data.payload,
      deliveryMode,
      getCodeAccessExpiresAt,
      instruction: data.payload.instruction || productDefaults.deliveryInstruction || '',
      videoUrl: data.payload.videoUrl || productDefaults.deliveryVideoUrl || '',
      imageUrl: data.payload.imageUrl || productDefaults.deliveryImageUrl || ''
    }),
    adminNote: data.adminNote || data.payload.instruction || '',
    createdByAdminId: req.admin._id,
    createdByNickname: req.admin.nickname || req.admin.name
  });
  // Persist the stock assignment and the UI unlock flag atomically. Besides
  // making the nested fulfillment fields reliable, the pending/null guard
  // prevents two admins from attaching different details at the same time.
  const updatedOrder = await Order.findOneAndUpdate(
    { _id: order._id, status: 'pending', assignedStockItemId: null },
    { $set: {
      assignedStockItemId: stock._id,
      'fulfillment.isBackorder': true,
      'fulfillment.deliveryDetailsAddedAt': new Date(),
      'fulfillment.deliveryDetailsAddedByNickname': req.admin.nickname || req.admin.name
    } },
    { new: true, runValidators: true }
  );
  if (!updatedOrder) {
    // This stock row was created by this request only and was never assigned.
    await StockItem.deleteOne({ _id: stock._id, status: 'reserved', assignedOrderId: order._id });
    return res.status(409).json({ error: 'This order changed while delivery details were being saved. Refresh and try again.' });
  }
  await logActivity(req.admin, 'order.delivery_details_added', 'order', order.orderId, `${req.admin.nickname || req.admin.name} added delivery details for ${order.orderId}`);
  res.status(201).json({ message: 'Delivery details added. Approval and delivery are now unlocked.', order: updatedOrder, stock: { ...stock.toObject(), encryptedPayload: undefined } });
}));

adminRouter.post('/orders/:orderId/approve', asyncHandler(async (req, res) => {
  try {
    const result = await approveOrder({ orderId: req.params.orderId, admin: req.admin, source: 'admin' });
    await notifyOrderApproved(result.order, result.email);
    res.json({ message: 'Order approved. Customer can now view delivery using their order token.', order: result.order });
  } catch (error) {
    res.status(error.message === 'Order not found' ? 404 : 409).json({ error: error.message });
  }
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

  if (order.paymentMethod === 'reseller_due') {
    const reseller = await Reseller.findOne({ email: String(order.customer?.email || '').toLowerCase() }).lean();
    if (reseller) await voidRejectedResellerDue(order, reseller._id, { reason, admin: req.admin });
  }

  await logActivity(req.admin, 'order.rejected', 'order', order.orderId, `${nick} rejected order ${order.orderId}`);
  res.json({ message: 'Order rejected', order });
}));

adminRouter.post('/orders/:orderId/mark-delivered', asyncHandler(async (req, res) => {
  try {
    const result = await markOrderDelivered({ orderId: req.params.orderId, admin: req.admin, source: 'admin' });
    await notifyOrderDelivered(result.order, result.email);
    res.json({ message: 'Order marked delivered', order: result.order });
  } catch (error) {
    res.status(error.message === 'Order not found' ? 404 : 409).json({ error: error.message });
  }
}));

adminRouter.get('/activity', asyncHandler(async (req, res) => {
  const logs = await ActivityLog.find().sort({ createdAt: -1 }).limit(200).lean();
  res.json({ logs });
}));

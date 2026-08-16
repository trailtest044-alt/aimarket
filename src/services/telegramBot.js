import { env } from '../config/env.js';
import { Admin } from '../models/Admin.js';
import { Product } from '../models/Product.js';
import { StockItem } from '../models/StockItem.js';
import { Order } from '../models/Order.js';
import { Reseller } from '../models/Reseller.js';
import { ResellerInvoice } from '../models/ResellerInvoice.js';
import { ResellerPaymentRequest } from '../models/ResellerPaymentRequest.js';
import { PromoCode } from '../models/PromoCode.js';
import { Customer } from '../models/Customer.js';
import { approveOrder, rejectOrder, markOrderDelivered } from './orderWorkflow.js';
import { encryptJson, decryptJson } from '../utils/cryptoBox.js';
import { logActivity } from '../utils/activity.js';
import { settleResellerPayment } from './resellerPaymentSettlement.js';
import { getLatestMailTxtLoginCode } from './mailTxtLoginCode.js';

// This is intentionally in-memory: a Telegram stock-entry draft expires whenever
// the service restarts and never stores a credential outside the encrypted stock item.
const stockDrafts = new Map();

function configured() {
  return Boolean(env.telegram.token && env.telegram.adminChatId && env.telegram.webhookSecret);
}

function apiUrl(method) {
  return 'https://api.telegram.org/bot' + env.telegram.token + '/' + method;
}

async function telegram(method, body = {}) {
  if (!configured()) return { ok: false, skipped: true };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(apiUrl(method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.description || 'Telegram request failed');
    return data;
  } catch (error) {
    console.error('Telegram ' + method + ' failed:', error.message);
    return { ok: false, error: error.message };
  } finally {
    clearTimeout(timeout);
  }
}

function button(text, callback_data) {
  return { text, callback_data: String(callback_data).slice(0, 64) };
}

function link(text, url) {
  return { text, url };
}

async function send(chatId, text, inline_keyboard = []) {
  return telegram('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    reply_markup: inline_keyboard.length ? { inline_keyboard } : undefined
  });
}

const mainKeyboard = [
  [{ text: '🏠 Dashboard' }, { text: '🧾 Orders' }],
  [{ text: '📦 Stock' }, { text: '🛍 Products' }],
  [{ text: '🤝 Resellers' }, { text: '💳 Payments' }],
  [{ text: '👥 Customers' }, { text: '🔐 Get Code' }],
  [{ text: '🏷 Promos' }, { text: '📊 Reports' }]
];

async function sendMenu(chatId, text) {
  return telegram('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    reply_markup: { keyboard: mainKeyboard, resize_keyboard: true, is_persistent: true }
  });
}

async function prepareBotUx() {
  await telegram('setMyCommands', {
    commands: [
      { command: 'menu', description: 'Open Ai Market control center' },
      { command: 'orders', description: 'Review pending orders' },
      { command: 'stock', description: 'Add or manage stock' },
      { command: 'cancel', description: 'Cancel the current action' }
    ]
  });
}

async function removeSensitiveMessage(message) {
  if (!message?.chat?.id || !message?.message_id) return;
  await telegram('deleteMessage', { chat_id: message.chat.id, message_id: message.message_id });
}

async function readTelegramTxtDocument(document) {
  const fileName = String(document?.file_name || '').toLowerCase();
  const size = Number(document?.file_size || 0);
  if (!fileName.endsWith('.txt')) throw new Error('Please attach a .txt file only.');
  if (!size || size > 1024 * 1024) throw new Error('TXT file must be smaller than 1 MB.');
  const file = await telegram('getFile', { file_id: document.file_id });
  const filePath = file?.result?.file_path;
  if (!filePath) throw new Error('Could not read that TXT file.');
  const response = await fetch('https://api.telegram.org/file/bot' + env.telegram.token + '/' + filePath);
  if (!response.ok) throw new Error('Could not download that TXT file.');
  const text = await response.text();
  if (!text.trim()) throw new Error('The TXT file is empty.');
  return text.trim();
}

function setDraft(chatId, draft) {
  stockDrafts.set(String(chatId), { ...draft, createdAt: Date.now() });
}

function takeDraft(chatId) {
  const key = String(chatId);
  const draft = stockDrafts.get(key);
  if (!draft || Date.now() - draft.createdAt > 20 * 60 * 1000) {
    stockDrafts.delete(key);
    return null;
  }
  return draft;
}

function clearDraft(chatId) {
  stockDrafts.delete(String(chatId));
}

function isAdminChat(chatId) {
  return String(chatId || '') === String(env.telegram.adminChatId || '');
}

function webBase() {
  return String(env.frontendUrl || 'http://localhost:5173').replace(/\/$/, '');
}

function money(order) {
  const amount = Number(order?.productSnapshot?.price || 0);
  const currency = order?.productSnapshot?.currency || 'BDT';
  return currency === 'BDT' ? '৳' + Math.round(amount) : String(amount) + ' ' + currency;
}

function orderText(order, heading = '🛒 New order') {
  const reseller = order.paymentMethod === 'reseller_due' ? '\n🏷️ Reseller credit order' : '';
  return heading + '\n\n' + (order.productSnapshot?.title || 'Product') + ' · ' + money(order) + reseller +
    '\nOrder: ' + order.orderId +
    '\nCustomer: ' + (order.customer?.name || '—') +
    '\nGmail: ' + (order.customer?.email || '—') +
    '\nPayment: ' + (order.paymentMethod || '—') +
    '\nTransaction: ' + (order.transactionId || '—');
}

function orderButtons(order) {
  const isManual = order.productSnapshot?.deliveryMode === 'manual';
  const needsDetails = Boolean(order.fulfillment?.isBackorder) && !order.assignedStockItemId;
  if (needsDetails) {
    return [
      [button('➕ Add delivery details', 'ad:' + order.orderId), button('❌ Reject', 'or:' + order.orderId)],
      [link('Open order ↗', webBase() + '/admin/orders')]
    ];
  }
  if (isManual && !order.manualActivationActivatedAt) {
    return [
      [button(order.manualActivationSubmittedAt ? 'View customer login' : 'Waiting for customer login', order.manualActivationSubmittedAt ? 'ma:' + order.orderId : 'noop'), button('Reject', 'or:' + order.orderId)],
      [link('Open order', webBase() + '/admin/orders')]
    ];
  }
  return [
    [button('✅ Approve', 'oa:' + order.orderId), button('❌ Reject', 'or:' + order.orderId)],
    [button('📦 Mark delivered', 'od:' + order.orderId)],
    [link('Open order ↗', webBase() + '/admin/orders')]
  ];
}

async function ownerAdmin() {
  return (await Admin.findOne({ role: 'owner', isActive: true })) || (await Admin.findOne({ isActive: true }));
}

async function activeProducts() {
  return Product.find({ isActive: true }).sort({ sortOrder: 1, title: 1 }).lean();
}

async function showHome(chatId, welcome = false) {
  if (welcome) await prepareBotUx();
  const [pending, products, lowStock, pendingPayments] = await Promise.all([
    Order.countDocuments({ status: 'pending' }),
    Product.countDocuments({ isActive: true }),
    StockItem.countDocuments({ status: 'available' }),
    ResellerPaymentRequest.countDocuments({ status: 'pending' })
  ]);
  await sendMenu(chatId,
    (welcome ? 'Welcome to Ai Market Control Center 👋' : 'Ai Market Control Center') +
      '\n\n🧾 Pending orders: ' + pending + '\n🛍 Active products: ' + products + '\n📦 Available stock items: ' + lowStock + '\n💳 Payment reviews: ' + pendingPayments + '\n\nUse the permanent buttons below. Typing is only needed when entering data.'
  );
  await send(chatId, 'Quick actions',
    [
      [button('📦 Add stock', 'stock'), button('📊 Stock status', 'stocks')],
      [button('🧾 Pending orders (' + pending + ')', 'pending'), button('📈 Today summary', 'summary')],
      [button('🤝 Resellers', 'resellers'), button('💳 Payment reviews', 'payments')],
      [button('👥 Find customer', 'customers'), button('🔐 Mail TXT Get Code', 'getcode')],
      [button('🛍 Products', 'products'), button('🏷️ Promo offers', 'promos')],
      [link('Open admin panel ↗', webBase() + '/admin')]
    ]
  );
}

async function showProductsDashboard(chatId) {
  const products = await Product.find({ isDeleted: { $ne: true } }).sort({ sortOrder: 1, title: 1 }).limit(30).lean();
  const rows = products.map((product) => [
    button((product.isActive ? '🟢 ' : '⚪ ') + String(product.title).slice(0, 32), 'pd:' + product._id)
  ]);
  rows.push([button('➕ Stock', 'stock'), button('🏠 Home', 'home')]);
  return send(chatId, '🛍 Products\n\nTap a product to view status, stock and safe controls.', rows);
}

async function showProductDetail(chatId, productId) {
  const product = await Product.findById(productId).lean();
  if (!product || product.isDeleted) return send(chatId, 'Product was not found.');
  const [available, reserved, delivered] = await Promise.all([
    StockItem.countDocuments({ productId, status: 'available' }),
    StockItem.countDocuments({ productId, status: 'reserved' }),
    StockItem.countDocuments({ productId, status: 'delivered' })
  ]);
  return send(chatId,
    '🛍 ' + product.title + '\n\nStatus: ' + (product.isActive ? 'Active' : 'Hidden') +
      '\nPrice: ' + Number(product.priceBDT || product.price || 0) + ' BDT' +
      '\nReal stock: ' + available + '\nReserved: ' + reserved + '\nDelivered: ' + delivered +
      '\nDisplay/backorder stock: ' + Number(product.backorderStock || 0),
    [
      [button('📦 Add/manage stock', 'sp:' + productId)],
      [button('🪄 Set display stock', 'pbs:' + productId)],
      [button(product.isActive ? '🙈 Hide product' : '👁 Show product', 'pc:' + (product.isActive ? '0' : '1') + ':' + productId)],
      [button('⬅️ Products', 'products'), button('🏠 Home', 'home')]
    ]
  );
}

async function showPaymentReviews(chatId) {
  const requests = await ResellerPaymentRequest.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(12).lean();
  if (!requests.length) return send(chatId, '✅ No reseller payment is waiting for review.', [[button('🏠 Home', 'home')]]);
  const rows = requests.map((request) => [button('💳 ' + request.amount + ' ' + request.currency + ' · ' + String(request.transactionId || '').slice(0, 18), 'rpr:' + request._id)]);
  rows.push([button('🏠 Home', 'home')]);
  return send(chatId, '💳 Payment reviews\n\nOpen a request to verify it before approval.', rows);
}

async function showPaymentReview(chatId, requestId) {
  const request = await ResellerPaymentRequest.findById(requestId).lean();
  if (!request) return send(chatId, 'Payment request was not found.');
  const reseller = await Reseller.findById(request.resellerId).lean();
  return send(chatId,
    '💳 Payment review\n\nReseller: ' + (reseller?.name || reseller?.email || 'Unknown') +
      '\nEmail: ' + (reseller?.email || '—') + '\nAmount: ' + request.amount + ' ' + request.currency +
      '\nChannel: ' + request.channel + '\nTransaction: ' + request.transactionId + '\nStatus: ' + request.status,
    request.status === 'pending' ? [[button('✅ Approve', 'rpa:' + request._id), button('❌ Reject', 'rpx:' + request._id)], [button('⬅️ Payments', 'payments')]] : [[button('⬅️ Payments', 'payments')]]
  );
}

function safeRegex(value) {
  return new RegExp(String(value || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

async function searchCustomers(chatId, term) {
  const re = safeRegex(term);
  const customers = await Customer.find({ $or: [{ name: re }, { email: re }] }).sort({ lastLoginAt: -1, createdAt: -1 }).limit(10).lean();
  if (!customers.length) return send(chatId, 'No customer matched “' + term + '”.', [[button('🔎 Search again', 'customers'), button('🏠 Home', 'home')]]);
  const rows = customers.map((customer) => [button('👤 ' + String(customer.name || customer.email).slice(0, 34), 'cu:' + customer._id)]);
  rows.push([button('🔎 Search again', 'customers'), button('🏠 Home', 'home')]);
  return send(chatId, '👥 Customer matches for “' + term + '”', rows);
}

async function showCustomerDetail(chatId, customerId) {
  const customer = await Customer.findById(customerId).lean();
  if (!customer) return send(chatId, 'Customer was not found.');
  const orders = await Order.find({ 'customer.email': String(customer.email || '').toLowerCase() }).sort({ createdAt: -1 }).limit(8).lean();
  const history = orders.map((order) => '• ' + order.orderId + ' · ' + (order.productSnapshot?.title || 'Product') + ' · ' + order.status).join('\n') || 'No order history.';
  return send(chatId,
    '👤 Customer profile\n\nName: ' + (customer.name || '—') + '\nGmail: ' + (customer.email || '—') +
      '\nJoined: ' + (customer.createdAt ? new Date(customer.createdAt).toLocaleDateString('en-GB') : '—') +
      '\nLast login: ' + (customer.lastLoginAt ? new Date(customer.lastLoginAt).toLocaleString('en-GB') : '—') +
      '\nOrders: ' + orders.length + '\n\nRecent history\n' + history,
    [[button('🔎 New search', 'customers'), button('🏠 Home', 'home')]]
  );
}

async function showProductPicker(chatId, page = 0) {
  const products = await activeProducts();
  const pageSize = 8;
  const totalPages = Math.max(1, Math.ceil(products.length / pageSize));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const rows = products.slice(safePage * pageSize, safePage * pageSize + pageSize)
    .map((product) => [button((product.icon || '📦') + ' ' + product.title, 'sp:' + product._id)]);
  if (products.length > pageSize) rows.push([
    button('◀️', 'stockpage:' + Math.max(0, safePage - 1)),
    button((safePage + 1) + '/' + totalPages, 'noop'),
    button('▶️', 'stockpage:' + Math.min(totalPages - 1, safePage + 1))
  ]);
  rows.push([button('⬅️ Home', 'home')]);
  await send(chatId, '📦 Choose a product to add or manage stock:', rows);
}

async function showProductStock(chatId, productId) {
  const product = await Product.findById(productId).lean();
  if (!product || product.isDeleted || !product.isActive) return send(chatId, 'That product is no longer available.');
  const [available, delivered, disabled] = await Promise.all([
    StockItem.countDocuments({ productId, status: 'available' }),
    StockItem.countDocuments({ productId, status: 'delivered' }),
    StockItem.countDocuments({ productId, status: 'disabled' })
  ]);
  await send(chatId,
    (product.icon || '📦') + ' ' + product.title + '\n\nAvailable: ' + available + '\nDelivered: ' + delivered + '\nDisabled: ' + disabled +
      '\n\nManage this product directly from Telegram.',
    [
      [button('🔑 Email + password', 'sa:' + productId), button('📚 Bulk accounts', 'sb:' + productId)],
      [button('🔢 Activation key', 'scd:' + productId), button('📨 Login with Get Code', 'sli:' + productId)],
      [button('📝 Manual delivery', 'sman:' + productId), button('🧰 Manage accounts', 'sm:' + productId)],
      [button('🔄 Refresh', 'ss:' + productId), button('⬅️ Products', 'stock')]
    ]
  );
}

async function showStockManager(chatId, productId) {
  const product = await Product.findById(productId).lean();
  if (!product || product.isDeleted) return send(chatId, 'Product was not found.');
  const [available, disabled] = await Promise.all([
    StockItem.find({ productId, status: 'available' }).sort({ createdAt: 1 }).limit(6).lean(),
    StockItem.find({ productId, status: 'disabled' }).sort({ createdAt: -1 }).limit(4).lean()
  ]);
  const rows = [];
  for (const item of available) {
    let label = 'Account';
    try { label = decryptJson(item.encryptedPayload)?.email || 'Account'; } catch {}
    rows.push([button('🚫 Disable ' + String(label).slice(0, 32), 'sd:' + item._id)]);
  }
  for (const item of disabled) {
    let label = 'Account';
    try { label = decryptJson(item.encryptedPayload)?.email || 'Account'; } catch {}
    rows.push([button('♻️ Enable ' + String(label).slice(0, 32), 'se:' + item._id)]);
  }
  rows.push([button('➕ Add account', 'sa:' + productId), button('📚 Bulk add', 'sb:' + productId)]);
  rows.push([button('⬅️ Back', 'sp:' + productId)]);
  await send(chatId,
    '🧰 ' + product.title + '\n\nAvailable accounts shown: ' + available.length + '\nDisabled accounts shown: ' + disabled.length +
      '\nTap an account to disable or restore it. Passwords are never shown in Telegram.',
    rows
  );
}

async function saveTelegramStock({ chatId, productId, type, payload, count = 1 }) {
  const product = await Product.findById(productId).lean();
  const admin = await ownerAdmin();
  if (!product || product.isDeleted || !admin) throw new Error('Product or admin account was not found.');
  const list = Array.isArray(payload) ? payload : [payload];
  for (const entry of list) {
    const delivery = {
      ...entry,
      deliveryMode: type,
      instruction: entry.instruction || product.deliveryInstruction || '',
      videoUrl: entry.videoUrl || product.deliveryVideoUrl || '',
      imageUrl: entry.imageUrl || product.deliveryImageUrl || '',
      getCodeAccessDays: type === 'login_code' ? Math.min(3650, Math.max(1, Math.floor(Number(entry.getCodeAccessDays || 25)))) : 25,
      getCodeAccessExpiresAt: type === 'login_code'
        ? new Date(Date.now() + Math.min(3650, Math.max(1, Math.floor(Number(entry.getCodeAccessDays || 25)))) * 24 * 60 * 60 * 1000).toISOString()
        : ''
    };
    await StockItem.create({
      productId,
      type,
      status: 'available',
      encryptedPayload: encryptJson(delivery),
      adminNote: delivery.instruction || '',
      createdByAdminId: admin._id,
      createdByNickname: admin.nickname || admin.name
    });
  }
  if (type === 'manual') {
    await Product.updateOne({ _id: productId }, { $set: { deliveryMode: 'manual' } });
    await Order.updateMany(
      { productId, status: 'pending', 'productSnapshot.deliveryMode': { $ne: 'manual' } },
      { $set: { 'productSnapshot.deliveryMode': 'manual' } }
    );
  }
  await logActivity(admin, 'stock.created.telegram', 'stock', productId, `${admin.nickname || admin.name} added ${count} ${product.title} stock item(s) from Telegram`);
  await send(chatId, '✅ Added ' + count + ' account' + (count === 1 ? '' : 's') + ' to ' + product.title + '.\nCredentials are encrypted on the server.', [[button('🧰 Manage accounts', 'sm:' + productId), button('➕ Add more', 'sa:' + productId), button('⬅️ Products', 'stock')]]);
}

async function showAddDetailsMethods(chatId, orderId) {
  const order = await Order.findOne({ orderId }).lean();
  if (!order || order.status !== 'pending') return send(chatId, 'This pending order was not found.');
  if (order.assignedStockItemId) return send(chatId, 'Delivery details are already assigned to this order.', orderButtons(order));
  return send(chatId,
    '➕ Add exact delivery details\n\nOrder: ' + order.orderId + '\nProduct: ' + (order.productSnapshot?.title || 'Product') +
      '\n\nChoose what this customer will receive. Approval stays locked until these details are saved.',
    [
      [button('🔑 Email + password', 'adc:' + orderId), button('🔢 Activation key', 'ada:' + orderId)],
      [button('📨 Login with Get Code', 'adl:' + orderId), button('📝 Manual note', 'adm:' + orderId)],
      [button('⬅️ Pending orders', 'pending')]
    ]
  );
}

async function addOrderDeliveryDetails({ chatId, orderId, type, payload }) {
  const admin = await ownerAdmin();
  if (!admin) throw new Error('No active admin account is configured.');
  const order = await Order.findOne({ orderId });
  if (!order) throw new Error('Order was not found.');
  if (order.status !== 'pending') throw new Error('Delivery details can be added only to a pending order.');
  if (order.assignedStockItemId) throw new Error('Delivery details are already assigned.');
  const product = await Product.findById(order.productId).lean();
  if (!product) throw new Error('Product was not found.');
  const days = Math.min(3650, Math.max(1, Math.floor(Number(payload.getCodeAccessDays || 25))));
  const delivery = {
    ...payload,
    deliveryMode: type,
    getCodeAccessDays: type === 'login_code' ? days : 25,
    getCodeAccessExpiresAt: type === 'login_code' ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() : '',
    instruction: payload.instruction || product.deliveryInstruction || '',
    videoUrl: payload.videoUrl || product.deliveryVideoUrl || '',
    imageUrl: payload.imageUrl || product.deliveryImageUrl || ''
  };
  const stock = await StockItem.create({
    productId: order.productId,
    type,
    status: 'reserved',
    assignedOrderId: order._id,
    encryptedPayload: encryptJson(delivery),
    adminNote: delivery.instruction || '',
    createdByAdminId: admin._id,
    createdByNickname: admin.nickname || admin.name
  });
  order.assignedStockItemId = stock._id;
  order.fulfillment = {
    ...(order.fulfillment || {}),
    isBackorder: Boolean(order.fulfillment?.isBackorder),
    deliveryDetailsAddedAt: new Date(),
    deliveryDetailsAddedByNickname: admin.nickname || admin.name
  };
  await order.save();
  await logActivity(admin, 'order.delivery_details_added.telegram', 'order', order.orderId, (admin.nickname || admin.name) + ' added exact delivery details from Telegram');
  return send(chatId, '✅ Delivery details added to ' + order.orderId + '. Approval and delivery are now unlocked.', orderButtons(order));
}

function parseLoginCodeInput(text) {
  const [emailPart, daysPart] = String(text || '').split('|').map((value) => value.trim());
  if (!emailPart || !emailPart.includes('@')) throw new Error('Enter a valid delivery email.');
  const days = daysPart ? Number(daysPart) : 25;
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('Access days must be a whole number from 1 to 3650.');
  return { email: emailPart.toLowerCase(), getCodeAccessDays: days };
}

async function showResellerDashboard(chatId) {
  const resellers = await Reseller.find().sort({ createdAt: -1 }).limit(60).lean();
  const rows = [];
  let totalDue = 0;
  for (const reseller of resellers) {
    const invoices = await ResellerInvoice.find({ resellerId: reseller._id, status: { $in: ['open', 'partial'] } }).lean();
    const due = invoices.reduce((sum, invoice) => sum + Number(invoice.remainingAmount || 0), 0);
    totalDue += due;
    rows.push({ reseller, due, open: invoices.length });
  }
  const buttons = rows.slice(0, 8).map((row) => [button((row.due > 0 ? '🟠 ' : '🟢 ') + (row.reseller.name || row.reseller.email).slice(0, 30), 'rs:' + row.reseller._id)]);
  buttons.push([button('➕ Add reseller', 'ra'), button('⬅️ Home', 'home')]);
  await send(chatId, '🤝 Reseller control\n\nPartners: ' + rows.length + '\nOpen BDT due: ৳' + Math.round(totalDue) + '\n\nTap a reseller for their current due and open invoices.', buttons);
}

async function showResellerDetail(chatId, resellerId) {
  const reseller = await Reseller.findById(resellerId).lean();
  if (!reseller) return send(chatId, 'Reseller was not found.');
  const invoices = await ResellerInvoice.find({ resellerId: reseller._id, status: { $in: ['open', 'partial'] } }).sort({ createdAt: 1 }).limit(10).lean();
  const due = invoices.reduce((sum, invoice) => sum + Number(invoice.remainingAmount || 0), 0);
  const currency = invoices[0]?.currency || 'BDT';
  const list = invoices.map((invoice) => '• ' + invoice.orderId + ' — ' + invoice.productTitle + ': ' + Number(invoice.remainingAmount || 0)).join('\n') || 'No open invoice.';
  await send(chatId, '🤝 ' + (reseller.name || reseller.email) + '\n' + reseller.email + '\nStatus: ' + (reseller.status || 'invited') + '\nCredit limit: ৳' + (reseller.creditLimitBDT || 0) + '\nOpen due: ' + Math.round(due) + ' ' + currency + '\n\n' + list, [
    [button('💰 Set credit limit', 'rcl:' + resellerId), button(reseller.status === 'suspended' ? '✅ Enable' : '⛔ Suspend', 'rst:' + resellerId)],
    [button('⬅️ Resellers', 'resellers'), button('🏠 Home', 'home')]
  ]);
}

async function showPromoDashboard(chatId) {
  const promos = await PromoCode.find({ isActive: true }).sort({ createdAt: -1 }).limit(12).lean();
  if (!promos.length) {
    return send(chatId, 'No active promo code yet. Create one in the admin panel first.', [[link('Open promo settings', webBase() + '/admin/promo-codes')], [button('Home', 'home')]]);
  }
  const lines = promos.map((promo) => {
    const saving = promo.discountType === 'percent' ? (promo.percentOff || 0) + '% off' : 'BDT ' + (promo.fixedBDT || 0) + ' off';
    const use = promo.maxUses ? String(promo.usedCount || 0) + '/' + promo.maxUses : String(promo.usedCount || 0) + '/unlimited';
    const audience = promo.allowResellers === true ? 'customers + resellers' : 'customers only';
    return (promo.showOnHomepage ? 'ON ' : 'OFF ') + promo.code + ' - ' + saving + ' - ' + audience + ' - uses ' + use;
  }).join('\n');
  const buttons = promos.map((promo) => [button((promo.showOnHomepage ? 'Hide ' : 'Show ') + promo.code + ' on home', 'pt:' + promo._id)]);
  buttons.push([link('Edit promo details', webBase() + '/admin/promo-codes'), button('Home', 'home')]);
  await send(chatId, 'Promo offers\n\n' + lines + '\n\nTap a code to show or hide it in the homepage offer bar.', buttons);
}

async function togglePromoHomepage(chatId, promoId) {
  const promo = await PromoCode.findOne({ _id: promoId, isActive: true });
  if (!promo) return send(chatId, 'Promo code was not found or is inactive.');
  const admin = await ownerAdmin();
  if (!admin) return send(chatId, 'No active admin account is configured.');
  promo.showOnHomepage = !promo.showOnHomepage;
  await promo.save();
  await logActivity(admin, 'promo.homepage_visibility.telegram', 'promo', promo._id, (admin.nickname || admin.name) + ' changed promo homepage visibility from Telegram');
  await send(chatId, (promo.showOnHomepage ? 'Homepage offer enabled: ' : 'Homepage offer hidden: ') + promo.code);
  return showPromoDashboard(chatId);
}

async function showManualActivation(chatId, orderId) {
  const order = await Order.findOne({ orderId }).lean();
  if (!order || order.productSnapshot?.deliveryMode !== 'manual') return send(chatId, 'Manual-delivery order was not found.');
  if (!order.manualActivationSubmittedAt || !order.manualActivationEncrypted) {
    return send(chatId, 'The customer has not submitted their login details yet.', [[button('Pending orders', 'pending')]]);
  }
  let login;
  try { login = decryptJson(order.manualActivationEncrypted); } catch { return send(chatId, 'Saved customer login details could not be opened.'); }
  const emailOnly = order.productSnapshot?.manualInputMode === 'email_only';
  const text = 'Manual subscription activation\n\nOrder: ' + order.orderId + '\nProduct: ' + (order.productSnapshot?.title || 'Product') + '\nCustomer email: ' + (login?.email || '—') + (emailOnly ? '' : '\nCustomer password: ' + (login?.password || '—')) + '\n\nOpen the subscription in this customer account, then tap Subscription activated. This unlocks approval and delivery.';
  const buttons = order.manualActivationActivatedAt
    ? [[button('Approve', 'oa:' + order.orderId), button('Mark delivered', 'od:' + order.orderId)]]
    : [[button('Subscription activated', 'mac:' + order.orderId), button('Reject', 'or:' + order.orderId)]];
  return send(chatId, text, buttons);
}

async function completeManualActivation(chatId, orderId) {
  const admin = await ownerAdmin();
  if (!admin) return send(chatId, 'No active admin account is configured yet.');
  const order = await Order.findOne({ orderId });
  if (!order || order.productSnapshot?.deliveryMode !== 'manual') return send(chatId, 'Manual-delivery order was not found.');
  if (!order.manualActivationSubmittedAt || !order.manualActivationEncrypted) return send(chatId, 'Customer login details have not been submitted yet.');
  if (!order.manualActivationActivatedAt) {
    order.manualActivationActivatedAt = new Date();
    order.manualActivationActivatedBy = admin._id;
    order.manualActivationActivatedByNickname = admin.nickname || admin.name || 'Admin';
    await order.save();
    await logActivity(admin, 'order.manual_activation_completed.telegram', 'order', order.orderId, (admin.nickname || admin.name || 'Admin') + ' confirmed manual subscription activation for ' + order.orderId);
  }
  return send(chatId, 'Subscription activation confirmed for ' + order.orderId + '. You can now approve or deliver it.', [[button('Approve', 'oa:' + order.orderId), button('Mark delivered', 'od:' + order.orderId)]]);
}

function parseCredentialRows(text) {
  const rows = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!rows.length || rows.length > 30) throw new Error('Send 1 to 30 lines only.');
  return rows.map((line) => {
    const divider = line.indexOf('|');
    if (divider < 1) throw new Error('Use this format: email | password');
    const email = line.slice(0, divider).trim();
    const password = line.slice(divider + 1).trim();
    if (!email.includes('@') || !password) throw new Error('Every line needs an email and password.');
    return { email, password };
  });
}

async function showStockSummary(chatId) {
  const products = await activeProducts();
  const rows = await Promise.all(products.map(async (product) => ({
    product,
    available: await StockItem.countDocuments({ productId: product._id, status: 'available' })
  })));
  const lines = rows.map((row) => (row.available <= env.telegram.lowStockLimit ? '⚠️ ' : '✅ ') + row.product.title + ': ' + row.available).join('\n') || 'No active products.';
  await send(chatId, '📊 Available stock\n\n' + lines, [[button('📦 Add stock', 'stock'), button('⬅️ Home', 'home')]]);
}

async function showPendingOrders(chatId) {
  const orders = await Order.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(8).lean();
  if (!orders.length) return send(chatId, '✅ No pending orders right now.', [[button('⬅️ Home', 'home')]]);
  await send(chatId, '🧾 Oldest pending orders', [[button('⬅️ Home', 'home')]]);
  for (const order of orders) await send(chatId, orderText(order), orderButtons(order));
}

function startOfBangladeshDay() {
  const shifted = new Date(Date.now() + 6 * 60 * 60 * 1000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 6 * 60 * 60 * 1000);
}

async function showTodaySummary(chatId) {
  const todayStart = startOfBangladeshDay().getTime();
  const orders = (await Order.find({}).lean()).filter((order) => new Date(order.createdAt).getTime() >= todayStart);
  const count = (status) => orders.filter((order) => order.status === status).length;
  const value = orders.filter((order) => ['approved', 'delivered'].includes(order.status)).reduce((sum, order) => sum + Number(order.productSnapshot?.price || 0), 0);
  await send(chatId,
    '📈 Today\n\nNew: ' + orders.length + '\nPending: ' + count('pending') + '\nApproved: ' + count('approved') + '\nDelivered: ' + count('delivered') + '\nRejected: ' + count('rejected') + '\nApproved/delivered value: ৳' + Math.round(value),
    [[button('⬅️ Home', 'home')]]
  );
}

async function confirmOrder(chatId, kind, orderId) {
  const order = await Order.findOne({ orderId }).lean();
  if (!order) return send(chatId, 'Order was not found.');
  const config = kind === 'approve'
    ? ['Approve this order? One stock account will be assigned and customer delivery email will be sent.', '✅ Confirm approval', 'coa']
    : kind === 'reject'
      ? ['Reject this order? Reseller due (if any) will reverse automatically.', '❌ Confirm rejection', 'cor']
      : ['Mark this order delivered? A stock account will be assigned if needed.', '📦 Confirm delivery', 'cod'];
  await send(chatId, config[0] + '\n\n' + orderText(order, 'Order review'), [[button(config[1], config[2] + ':' + orderId), button('Cancel', 'home')]]);
}

async function maybeNotifyLowStock(productId) {
  const product = await Product.findById(productId);
  if (!product || product.isDeleted) return;
  const available = await StockItem.countDocuments({ productId, status: 'available' });
  const previous = Number(product.telegramLowStockLastCount ?? -1);
  if (available > env.telegram.lowStockLimit || available === previous) return;
  product.telegramLowStockLastCount = available;
  await product.save();
  await send(env.telegram.adminChatId, '⚠️ Low stock: ' + product.title + '\nOnly ' + available + ' account(s) available.', [[button('📦 Manage stock', 'sp:' + productId)]]);
}

export async function notifyNewOrder(order) {
  if (configured()) await send(env.telegram.adminChatId, orderText(order), orderButtons(order));
}

export async function notifyResellerPaymentRequest(request, reseller) {
  if (!configured()) return;
  await send(env.telegram.adminChatId,
    '💳 Reseller payment waiting for review\n\nReseller: ' + (reseller?.name || reseller?.email || '—') +
    '\nAmount: ' + request.amount + ' ' + request.currency + '\nChannel: ' + request.channel + '\nTransaction: ' + request.transactionId,
    [[button('✅ Approve payment', 'rpa:' + request._id), button('❌ Reject', 'rpx:' + request._id)], [link('Open reseller panel', webBase() + '/admin/resellers/' + request.resellerId)]]
  );
}

export async function notifyResellerPaymentApproved(request, reseller, settlement) {
  if (!configured()) return;
  await send(env.telegram.adminChatId, '✅ Reseller payment approved\n\n' + (reseller?.name || reseller?.email || 'Reseller') + '\nReceipt: ' + settlement.receiptNo + '\nRemaining due: ' + settlement.remainingDue + ' ' + request.currency);
}

// Sent only to the configured owner chat after the customer explicitly submits
// manual activation details. The password remains encrypted in the database.
export async function notifyManualActivationSubmitted(order, login = {}) {
  if (!configured()) return;
  const emailOnly = order.productSnapshot?.manualInputMode === 'email_only';
  const text = '🔐 Customer login submitted\n\nOrder: ' + order.orderId +
    '\nProduct: ' + (order.productSnapshot?.title || 'Product') +
    '\nLogin email: ' + (login.email || '—') +
    (emailOnly ? '' : '\nLogin password: ' + (login.password || '—')) +
    '\n\nActivate the subscription in this account, then tap Subscription activated.';
  await send(env.telegram.adminChatId, text, [
    [button('Subscription activated', 'mac:' + order.orderId), button('Reject', 'or:' + order.orderId)],
    [link('Open order', webBase() + '/admin/orders')]
  ]);
}

export async function notifyOrderApproved(order, email = {}) {
  if (!configured()) return;
  await send(env.telegram.adminChatId,
    '✅ Approved · ' + order.orderId + '\n' + (order.productSnapshot?.title || 'Product') + '\nCustomer delivery ' + (email?.sent ? 'email sent.' : 'is ready.'),
    [[button('📦 Mark delivered', 'od:' + order.orderId)]]
  );
  await maybeNotifyLowStock(order.productId);
}

export async function notifyOrderDelivered(order, email = {}) {
  if (!configured()) return;
  await send(env.telegram.adminChatId,
    '📬 Delivery successful · ' + order.orderId + '\n' + (order.productSnapshot?.title || 'Product') + '\nCustomer: ' + (order.customer?.email || '—') + '\nEmail: ' + (email?.sent ? 'sent.' : 'already prepared.')
  );
  await maybeNotifyLowStock(order.productId);
}

async function handleCallback(query) {
  const chatId = query?.message?.chat?.id;
  if (!isAdminChat(chatId)) return telegram('answerCallbackQuery', { callback_query_id: query.id, text: 'Not authorized' });
  await telegram('answerCallbackQuery', { callback_query_id: query.id });
  const data = String(query?.data || '');
  if (data === 'noop') return;
  if (data === 'home') return showHome(chatId);
  if (data === 'stock') return showProductPicker(chatId);
  if (data === 'stocks') return showStockSummary(chatId);
  if (data === 'pending') return showPendingOrders(chatId);
  if (data === 'summary') return showTodaySummary(chatId);
  if (data === 'resellers') return showResellerDashboard(chatId);
  if (data === 'promos') return showPromoDashboard(chatId);
  if (data === 'products') return showProductsDashboard(chatId);
  if (data === 'payments') return showPaymentReviews(chatId);
  if (data === 'customers') {
    setDraft(chatId, { kind: 'customer_search' });
    return send(chatId, '🔎 Send a customer name or Gmail address.\n\nExample: customer@gmail.com\nUse /cancel to stop.');
  }
  if (data === 'getcode') {
    setDraft(chatId, { kind: 'admin_get_code' });
    return send(chatId, '🔐 Send the Mail TXT email address. I will fetch the latest code for the owner chat only.\n\nUse /cancel to stop.');
  }
  if (data.startsWith('cu:')) return showCustomerDetail(chatId, data.split(':')[1]);
  if (data.startsWith('pd:')) return showProductDetail(chatId, data.split(':')[1]);
  if (data.startsWith('rpr:')) return showPaymentReview(chatId, data.split(':')[1]);
  if (data === 'ra') {
    setDraft(chatId, { kind: 'reseller_add' });
    return send(chatId, '➕ Send the reseller Gmail address.\n\nIf that customer already signed in, the profile becomes active automatically. Otherwise it waits for their first login.');
  }
  if (data.startsWith('rcl:')) {
    const resellerId = data.split(':')[1];
    setDraft(chatId, { kind: 'reseller_credit', resellerId });
    return send(chatId, '💰 Send the new BDT credit limit as a whole number.\n\nUse 0 for no limit. Use /cancel to stop.');
  }
  if (data.startsWith('rst:')) {
    const resellerId = data.split(':')[1];
    const reseller = await Reseller.findById(resellerId).lean();
    if (!reseller) return send(chatId, 'Reseller was not found.');
    const next = reseller.status === 'suspended' ? (reseller.customerId ? 'active' : 'invited') : 'suspended';
    return send(chatId, (next === 'suspended' ? 'Suspend' : 'Enable') + ' ' + (reseller.name || reseller.email) + '?', [[button('Confirm', 'rstc:' + next + ':' + resellerId), button('Cancel', 'rs:' + resellerId)]]);
  }
  if (data.startsWith('rstc:')) {
    const [, status, resellerId] = data.split(':');
    const admin = await ownerAdmin();
    if (!admin) return send(chatId, 'No active admin account is configured.');
    const reseller = await Reseller.findByIdAndUpdate(resellerId, { $set: { status } }, { new: true });
    if (!reseller) return send(chatId, 'Reseller was not found.');
    await logActivity(admin, 'reseller.status.telegram', 'reseller', resellerId, (admin.nickname || admin.name) + ' changed reseller status to ' + status + ' from Telegram');
    return send(chatId, '✅ Reseller status changed to ' + status + '.', [[button('Open reseller', 'rs:' + resellerId), button('🏠 Home', 'home')]]);
  }
  if (data.startsWith('pbs:')) {
    const productId = data.split(':')[1];
    setDraft(chatId, { kind: 'product_backorder', productId });
    return send(chatId, '🪄 Send the display/backorder stock quantity.\n\nUse 0 to turn it off. Backorders stay pending until exact delivery details are added.');
  }
  if (data.startsWith('ad:')) return showAddDetailsMethods(chatId, data.slice(3));
  if (data.startsWith('adc:') || data.startsWith('ada:') || data.startsWith('adl:') || data.startsWith('adm:')) {
    const [action, ...rest] = data.split(':');
    const orderId = rest.join(':');
    const kind = action === 'adc' ? 'order_credentials' : action === 'ada' ? 'order_activation_code' : action === 'adl' ? 'order_login_code' : 'order_manual';
    setDraft(chatId, { kind, orderId });
    const prompt = kind === 'order_credentials'
      ? 'Send exact customer delivery details:\n\nemail | password'
      : kind === 'order_activation_code'
        ? 'Send the exact activation key for this order.'
        : kind === 'order_login_code'
          ? 'Send delivery email and access days:\n\nemail@example.com | 25\n\nDays start now and default to 25 when omitted.'
          : 'Send the exact manual delivery note for this order.';
    return send(chatId, prompt + '\n\nThe message will be removed after secure storage. Use /cancel to stop.');
  }
  if (data.startsWith('pc:')) {
    const [, enabled, productId] = data.split(':');
    const product = await Product.findById(productId).lean();
    if (!product || product.isDeleted) return send(chatId, 'Product was not found.');
    return send(chatId, (enabled === '1' ? 'Show' : 'Hide') + ' “' + product.title + '” on the website?', [[button('Confirm', 'pcc:' + enabled + ':' + productId), button('Cancel', 'pd:' + productId)]]);
  }
  if (data.startsWith('pcc:')) {
    const [, enabled, productId] = data.split(':');
    const admin = await ownerAdmin();
    if (!admin) return send(chatId, 'No active admin account is configured.');
    const product = await Product.findOneAndUpdate(
      { _id: productId, isDeleted: { $ne: true } },
      { $set: { isActive: enabled === '1' } },
      { new: true }
    );
    if (!product) return send(chatId, 'Product was not found.');
    await logActivity(admin, enabled === '1' ? 'product.enabled.telegram' : 'product.disabled.telegram', 'product', productId, (admin.nickname || admin.name) + ' changed product visibility from Telegram');
    return send(chatId, enabled === '1' ? '✅ Product is visible.' : '🙈 Product is hidden.', [[button('Open product', 'pd:' + productId), button('🏠 Home', 'home')]]);
  }
  if (data.startsWith('rpa:') || data.startsWith('rpx:')) {
    const requestId = data.split(':')[1];
    const request = await ResellerPaymentRequest.findById(requestId).lean();
    if (!request || request.status !== 'pending') return send(chatId, 'This payment request is no longer pending.');
    const approving = data.startsWith('rpa:');
    return send(chatId,
      (approving ? 'Approve' : 'Reject') + ' this reseller payment?\n\nAmount: ' + request.amount + ' ' + request.currency + '\nTransaction: ' + request.transactionId,
      [[button(approving ? '✅ Confirm approval' : '❌ Confirm rejection', (approving ? 'rpac:' : 'rpxc:') + requestId), button('Cancel', 'rpr:' + requestId)]]
    );
  }
  if (data.startsWith('rpac:') || data.startsWith('rpxc:')) {
    const request = await ResellerPaymentRequest.findById(data.split(':')[1]).lean();
    if (!request || request.status !== 'pending') return send(chatId, 'This payment request is no longer pending.');
    const admin = await ownerAdmin();
    if (!admin) return send(chatId, 'No active owner account found.');
    if (data.startsWith('rpxc:')) {
      await ResellerPaymentRequest.findByIdAndUpdate(request._id, { $set: { status: 'rejected', rejectedAt: new Date(), rejectedByAdminId: admin._id, rejectedByNickname: admin.nickname || admin.name, rejectReason: 'Rejected via Telegram' } });
      await logActivity(admin, 'reseller.payment_request.rejected.telegram', 'reseller_payment_request', request._id, (admin.nickname || admin.name) + ' rejected a reseller payment request from Telegram');
      return send(chatId, '❌ Reseller payment request rejected.');
    }
    try {
      const settled = await settleResellerPayment({ resellerId: request.resellerId, amount: request.amount, currency: request.currency, paymentReference: request.transactionId, note: request.note || 'Approved via Telegram', admin });
      await ResellerPaymentRequest.findByIdAndUpdate(request._id, { $set: { status: 'approved', approvedAt: new Date(), approvedByAdminId: admin._id, approvedByNickname: admin.nickname || admin.name, receiptNo: settled.receiptNo } });
      await logActivity(admin, 'reseller.payment_request.approved.telegram', 'reseller_payment_request', request._id, (admin.nickname || admin.name) + ' approved a reseller payment request from Telegram');
      return send(chatId, '✅ Payment approved. Receipt: ' + settled.receiptNo + '\nRemaining due: ' + settled.remainingDue + ' ' + request.currency);
    } catch (error) { return send(chatId, '⚠️ ' + error.message); }
  }
  if (data.startsWith('stockpage:')) return showProductPicker(chatId, Number(data.split(':')[1]) || 0);
  if (data.startsWith('sp:') || data.startsWith('ss:')) return showProductStock(chatId, data.split(':')[1]);
  if (data.startsWith('sm:')) return showStockManager(chatId, data.split(':')[1]);
  if (data.startsWith('rs:')) return showResellerDetail(chatId, data.split(':')[1]);
  if (data.startsWith('pt:')) return togglePromoHomepage(chatId, data.split(':')[1]);
  if (data.startsWith('ma:')) return showManualActivation(chatId, data.split(':')[1]);
  if (data.startsWith('mac:')) return completeManualActivation(chatId, data.split(':')[1]);
  if (data.startsWith('sa:')) {
    const productId = data.split(':')[1];
    setDraft(chatId, { kind: 'credentials', productId });
    return send(chatId, '🔐 Send one account in this format:\n\nemail | password\n\nI will add it directly to server stock and try to delete your credential message immediately.');
  }
  if (data.startsWith('sb:')) {
    const productId = data.split(':')[1];
    setDraft(chatId, { kind: 'bulk_credentials', productId });
    return send(chatId, '📚 Send up to 30 accounts, one per line:\n\nemail1 | password1\nemail2 | password2\n\nThey will be added directly to encrypted server stock.');
  }
  if (data.startsWith('scd:')) {
    const productId = data.split(':')[1];
    setDraft(chatId, { kind: 'activation_code', productId });
    return send(chatId, 'Send one activation key, or attach a TXT file with one key per line.\n\nOnly the key will be delivered to the customer. Product instruction and video will be added automatically.');
  }
  if (data.startsWith('sli:')) {
    const productId = data.split(':')[1];
    setDraft(chatId, { kind: 'login_code', productId });
    return send(chatId, 'Send one delivery email and optional access days:\n\nemail@example.com | 25\n\nAccess starts when you add this stock. Default: 25 days. For bulk TXT, use one email per line and the default will apply.');
  }
  if (data.startsWith('sman:')) {
    const productId = data.split(':')[1];
    setDraft(chatId, { kind: 'manual', productId });
    return send(chatId, '📝 Send the one-time manual delivery note. Product instruction/video will be added automatically too.');
  }
  if (data.startsWith('sd:') || data.startsWith('se:')) {
    const [action, stockId] = data.split(':');
    const enable = action === 'se';
    return send(chatId, (enable ? 'Enable' : 'Disable') + ' this stock account?', [[button(enable ? '♻️ Confirm enable' : '🚫 Confirm disable', 'sc:' + (enable ? '1' : '0') + ':' + stockId), button('Cancel', 'home')]]);
  }
  if (data.startsWith('sc:')) {
    const [, enabled, stockId] = data.split(':');
    const admin = await ownerAdmin();
    if (!admin) return send(chatId, 'No active admin account is configured yet.');
    const stock = await StockItem.findOneAndUpdate(
      { _id: stockId, status: { $in: ['available', 'disabled'] } },
      { status: enabled === '1' ? 'available' : 'disabled' },
      { new: true }
    );
    if (!stock) return send(chatId, 'This stock item cannot be changed (it may already be delivered).');
    await logActivity(admin, enabled === '1' ? 'stock.enabled.telegram' : 'stock.disabled.telegram', 'stock', stock._id, `${admin.nickname || admin.name} ${enabled === '1' ? 'enabled' : 'disabled'} stock from Telegram`);
    return send(chatId, enabled === '1' ? '♻️ Account enabled.' : '🚫 Account disabled.', [[button('🧰 Manage accounts', 'sm:' + stock.productId), button('⬅️ Home', 'home')]]);
  }
  const [action, orderId] = data.split(':');
  if (['oa', 'or', 'od'].includes(action)) return confirmOrder(chatId, action === 'oa' ? 'approve' : action === 'or' ? 'reject' : 'deliver', orderId);
  const admin = await ownerAdmin();
  if (!admin) return send(chatId, 'No active admin account is configured yet.');
  try {
    if (action === 'coa') {
      const result = await approveOrder({ orderId, admin, source: 'telegram' });
      return notifyOrderApproved(result.order, result.email);
    }
    if (action === 'cor') {
      const result = await rejectOrder({ orderId, admin, reason: 'Rejected via Telegram', source: 'telegram' });
      return send(chatId, '❌ Rejected · ' + result.order.orderId + '\n' + (result.order.productSnapshot?.title || 'Product'));
    }
    if (action === 'cod') {
      const result = await markOrderDelivered({ orderId, admin, source: 'telegram' });
      return notifyOrderDelivered(result.order, result.email);
    }
  } catch (error) {
    return send(chatId, '⚠️ ' + error.message);
  }
}

export async function handleTelegramUpdate(update) {
  if (!configured()) return;
  if (update?.callback_query) return handleCallback(update.callback_query);
  const message = update?.message;
  if (!message || !isAdminChat(message.chat?.id)) return;
  const text = String(message.text || '').trim();
  const draft = takeDraft(message.chat.id);
  if (draft && text && !text.startsWith('/')) {
    try {
      if (draft.kind === 'customer_search') {
        clearDraft(message.chat.id);
        return searchCustomers(message.chat.id, text);
      }
      if (draft.kind === 'admin_get_code') {
        const email = text.trim().toLowerCase();
        if (!email.includes('@')) throw new Error('Send one valid email address.');
        clearDraft(message.chat.id);
        const result = await getLatestMailTxtLoginCode(email);
        if (!result?.code) throw new Error(result?.error || 'No recent code was found for this email.');
        return send(message.chat.id, '🔐 Latest code\n\nEmail: ' + email + '\nCode: ' + result.code + (result.receivedAt ? '\nReceived: ' + new Date(result.receivedAt).toLocaleString('en-GB') : '') + '\n\nOwner-only result. Do not forward unless needed.', [[button('🔐 Get another code', 'getcode'), button('🏠 Home', 'home')]]);
      }
      if (draft.kind === 'product_backorder') {
        const amount = Number(text);
        if (!Number.isInteger(amount) || amount < 0 || amount > 10000) throw new Error('Send a whole number from 0 to 10000.');
        const admin = await ownerAdmin();
        if (!admin) throw new Error('No active admin account is configured.');
        const product = await Product.findByIdAndUpdate(draft.productId, { $set: { backorderStock: amount } }, { new: true });
        if (!product) throw new Error('Product was not found.');
        clearDraft(message.chat.id);
        await logActivity(admin, 'product.backorder_stock.telegram', 'product', product._id, (admin.nickname || admin.name) + ' set display stock to ' + amount + ' from Telegram');
        return send(message.chat.id, '✅ Display/backorder stock set to ' + amount + ' for ' + product.title + '.', [[button('Open product', 'pd:' + product._id), button('🏠 Home', 'home')]]);
      }
      if (draft.kind === 'reseller_add') {
        const email = text.trim().toLowerCase();
        if (!email.includes('@')) throw new Error('Send one valid Gmail address.');
        if (await Reseller.findOne({ email })) throw new Error('This email is already in the reseller list.');
        const admin = await ownerAdmin();
        if (!admin) throw new Error('No active admin account is configured.');
        const customer = await Customer.findOne({ email }).lean();
        const reseller = await Reseller.create({
          email,
          name: customer?.name || email.split('@')[0],
          customerId: customer?._id || null,
          status: customer ? 'active' : 'invited',
          creditLimitBDT: 0,
          internalNote: 'Added from Telegram',
          createdByAdminId: admin._id,
          createdByNickname: admin.nickname || admin.name
        });
        clearDraft(message.chat.id);
        await logActivity(admin, 'reseller.created.telegram', 'reseller', reseller._id, (admin.nickname || admin.name) + ' added reseller ' + email + ' from Telegram');
        return send(message.chat.id, '✅ Reseller added: ' + email + '\nStatus: ' + reseller.status, [[button('Manage reseller', 'rs:' + reseller._id), button('🏠 Home', 'home')]]);
      }
      if (draft.kind === 'reseller_credit') {
        const amount = Number(text);
        if (!Number.isInteger(amount) || amount < 0 || amount > 100000000) throw new Error('Send a whole BDT amount from 0 to 100000000.');
        const admin = await ownerAdmin();
        if (!admin) throw new Error('No active admin account is configured.');
        const reseller = await Reseller.findByIdAndUpdate(draft.resellerId, { $set: { creditLimitBDT: amount } }, { new: true });
        if (!reseller) throw new Error('Reseller was not found.');
        clearDraft(message.chat.id);
        await logActivity(admin, 'reseller.credit_limit.telegram', 'reseller', reseller._id, (admin.nickname || admin.name) + ' set reseller credit limit to ' + amount + ' BDT from Telegram');
        return send(message.chat.id, '✅ Credit limit updated to ৳' + amount + '.', [[button('Open reseller', 'rs:' + reseller._id), button('🏠 Home', 'home')]]);
      }
      if (draft.kind === 'order_credentials') {
        const entries = parseCredentialRows(text);
        if (entries.length !== 1) throw new Error('Send one email | password line only.');
        await removeSensitiveMessage(message);
        clearDraft(message.chat.id);
        return addOrderDeliveryDetails({ chatId: message.chat.id, orderId: draft.orderId, type: 'credentials', payload: entries[0] });
      }
      if (draft.kind === 'order_activation_code') {
        if (text.length > 1000) throw new Error('Activation key is too long.');
        await removeSensitiveMessage(message);
        clearDraft(message.chat.id);
        return addOrderDeliveryDetails({ chatId: message.chat.id, orderId: draft.orderId, type: 'activation_code', payload: { activationCode: text } });
      }
      if (draft.kind === 'order_login_code') {
        const payload = parseLoginCodeInput(text);
        await removeSensitiveMessage(message);
        clearDraft(message.chat.id);
        return addOrderDeliveryDetails({ chatId: message.chat.id, orderId: draft.orderId, type: 'login_code', payload });
      }
      if (draft.kind === 'order_manual') {
        if (text.length > 8000) throw new Error('Manual delivery note is too long.');
        await removeSensitiveMessage(message);
        clearDraft(message.chat.id);
        return addOrderDeliveryDetails({ chatId: message.chat.id, orderId: draft.orderId, type: 'manual', payload: { instruction: text } });
      }
      if (draft.kind === 'credentials' || draft.kind === 'bulk_credentials') {
        const entries = parseCredentialRows(text);
        if (draft.kind === 'credentials' && entries.length !== 1) throw new Error('For one account, send one line only.');
        await removeSensitiveMessage(message);
        clearDraft(message.chat.id);
        return saveTelegramStock({ chatId: message.chat.id, productId: draft.productId, type: 'credentials', payload: entries, count: entries.length });
      }
      if (draft.kind === 'activation_code') {
        if (text.length > 1000) throw new Error('Activation code is too long.');
        await removeSensitiveMessage(message);
        clearDraft(message.chat.id);
        return saveTelegramStock({ chatId: message.chat.id, productId: draft.productId, type: 'activation_code', payload: { activationCode: text }, count: 1 });
      }
      if (draft.kind === 'login_code') {
        const payload = parseLoginCodeInput(text);
        await removeSensitiveMessage(message);
        clearDraft(message.chat.id);
        return saveTelegramStock({ chatId: message.chat.id, productId: draft.productId, type: 'login_code', payload, count: 1 });
      }
      if (draft.kind === 'manual') {
        if (text.length > 8000) throw new Error('Instruction is too long.');
        await removeSensitiveMessage(message);
        clearDraft(message.chat.id);
        return saveTelegramStock({ chatId: message.chat.id, productId: draft.productId, type: 'manual', payload: { instruction: text }, count: 1 });
      }
    } catch (error) {
      return send(message.chat.id, '⚠️ ' + error.message + '\nTry again, or press /menu to cancel.');
    }
  }
  if (draft && message.document) {
    try {
      if (!['bulk_credentials', 'activation_code', 'login_code'].includes(draft.kind)) throw new Error('TXT upload is not available for this delivery method.');
      const fileText = await readTelegramTxtDocument(message.document);
      const lines = fileText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (lines.length > 30) throw new Error('Please upload at most 30 lines at a time.');
      let type = 'credentials';
      let payload = [];
      if (draft.kind === 'bulk_credentials') {
        payload = parseCredentialRows(fileText);
        if (!payload.length) throw new Error('Use one account per line: email | password');
      } else if (draft.kind === 'activation_code') {
        type = 'activation_code';
        payload = lines.map((activationCode) => ({ activationCode }));
      } else {
        type = 'login_code';
        if (lines.some((email) => email.includes('|') || !email.includes('@'))) throw new Error('Use one valid delivery email per line.');
        payload = lines.map((email) => ({ email }));
      }
      await removeSensitiveMessage(message);
      clearDraft(message.chat.id);
      return saveTelegramStock({ chatId: message.chat.id, productId: draft.productId, type, payload, count: payload.length });
    } catch (error) {
      return send(message.chat.id, '⚠️ ' + error.message + '\nTry again, or press /menu to cancel.');
    }
  }
  if (text.startsWith('/')) clearDraft(message.chat.id);
  if (text === '/cancel') {
    clearDraft(message.chat.id);
    return send(message.chat.id, 'Draft cancelled.', [[button('🏠 Home', 'home')]]);
  }
  if (text === '/start' || text === '/menu' || text === '🏠 Dashboard') return showHome(message.chat.id, true);
  if (text === '/stock' || text === '📦 Stock') return showProductPicker(message.chat.id);
  if (text === '/orders' || text === '🧾 Orders') return showPendingOrders(message.chat.id);
  if (text === '🛍 Products') return showProductsDashboard(message.chat.id);
  if (text === '🤝 Resellers') return showResellerDashboard(message.chat.id);
  if (text === '💳 Payments') return showPaymentReviews(message.chat.id);
  if (text === '👥 Customers') {
    setDraft(message.chat.id, { kind: 'customer_search' });
    return send(message.chat.id, '🔎 Send a customer name or Gmail address. Use /cancel to stop.');
  }
  if (text === '🔐 Get Code') {
    setDraft(message.chat.id, { kind: 'admin_get_code' });
    return send(message.chat.id, '🔐 Send the Mail TXT email address. Use /cancel to stop.');
  }
  if (text === '🏷 Promos') return showPromoDashboard(message.chat.id);
  if (text === '📊 Reports') return showTodaySummary(message.chat.id);
  return showHome(message.chat.id);
}

export function telegramEnabled() {
  return configured();
}

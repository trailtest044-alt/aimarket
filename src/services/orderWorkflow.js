import { Order } from '../models/Order.js';
import { StockItem } from '../models/StockItem.js';
import { Reseller } from '../models/Reseller.js';
import { ResellerInvoice } from '../models/ResellerInvoice.js';
import { ResellerLedger } from '../models/ResellerLedger.js';
import { decryptJson } from '../utils/cryptoBox.js';
import { logActivity } from '../utils/activity.js';
import { sendDeliveryEmail } from './notificationEmail.js';

function actorName(admin) {
  return admin?.nickname || admin?.name || 'System';
}

function setLoginCodeExpiry(order, stock, startAt = new Date()) {
  if (order.getCodeAccessExpiresAt || !stock?.encryptedPayload) return;
  let payload = {};
  try { payload = decryptJson(stock.encryptedPayload); } catch { payload = {}; }
  if ((payload.deliveryMode || stock.type) !== 'login_code') return;
  const days = Math.min(3650, Math.max(1, Math.floor(Number(payload.getCodeAccessDays || 25))));
  const configuredExpiry = payload.getCodeAccessExpiresAt ? new Date(payload.getCodeAccessExpiresAt) : null;
  const stockStartAt = stock.createdAt || startAt;
  order.getCodeAccessDays = days;
  order.getCodeAccessExpiresAt = configuredExpiry && Number.isFinite(configuredExpiry.getTime())
    ? configuredExpiry
    : new Date(new Date(stockStartAt).getTime() + days * 24 * 60 * 60 * 1000);
}

export async function emailDeliveryReceiptOnce(order) {
  if (!order?.assignedStockItemId || order.deliveryEmailSentAt) return { sent: false, status: 'already_sent_or_unavailable' };
  const stock = await StockItem.findById(order.assignedStockItemId).lean();
  if (!stock) return { sent: false, status: 'missing_stock' };
  const result = await sendDeliveryEmail({ order, delivery: decryptJson(stock.encryptedPayload) });
  if (result.sent) {
    order.deliveryEmailSentAt = new Date();
    await order.save();
  }
  return result;
}

async function voidResellerDue(order, resellerId, { reason = '', admin = null, event = 'rejected' } = {}) {
  if (order?.paymentMethod !== 'reseller_due' || !resellerId) return { reversed: false, amount: 0, currency: 'BDT', remainingDue: null };
  const invoice = await ResellerInvoice.findOne({ resellerId, orderId: order.orderId }).lean();
  if (!invoice) return { reversed: false, amount: 0, currency: 'BDT', remainingDue: null };
  const [charge, existingReversal] = await Promise.all([
    ResellerLedger.findOne({ resellerId, orderId: order.orderId, kind: 'order_charge' }).lean(),
    ResellerLedger.findOne({ resellerId, orderId: order.orderId, kind: 'order_reversal' }).lean()
  ]);
  const reverseAmount = Math.abs(Number(charge?.amount || invoice.originalAmount || invoice.remainingAmount || 0));
  const currency = charge?.currency || invoice.currency || 'BDT';
  if (reverseAmount > 0 && !existingReversal) {
    await ResellerLedger.create({
      resellerId,
      orderId: order.orderId,
      kind: 'order_reversal',
      currency,
      amount: -reverseAmount,
      note: (event === 'cancelled' ? 'Cancelled order reversal' : 'Rejected order reversal') + (reason ? ': ' + reason : ''),
      createdByAdminId: admin?._id || null,
      createdByNickname: actorName(admin)
    });
  }
  if (invoice.status !== 'void') {
    await ResellerInvoice.findByIdAndUpdate(invoice._id, { $set: {
      remainingAmount: 0,
      status: 'void',
      voidedAt: new Date(),
      voidReason: reason || (event === 'cancelled' ? 'Order cancelled' : order.rejectReason || 'Order rejected'),
      voidedByAdminId: admin?._id || null,
      voidedByNickname: actorName(admin)
    } }, { new: true });
  }
  const entries = await ResellerLedger.find({ resellerId, currency }).lean();
  const remainingDue = Math.round(entries.reduce((sum, entry) => sum + Number(entry.amount || 0), 0) * 100) / 100;
  return { reversed: !existingReversal, amount: reverseAmount, currency, remainingDue };
}

async function assignDeliveryStock(order, admin) {
  // Backorder details are attached to this exact order by the admin. Do not
  // replace them with an unrelated account or let a fake-stock order skip
  // this gate.
  if (order.assignedStockItemId) {
    const assigned = await StockItem.findById(order.assignedStockItemId);
    if (!assigned || String(assigned.assignedOrderId || '') !== String(order._id)) {
      throw new Error('Assigned delivery details are missing or do not belong to this order');
    }
    if (assigned.status !== 'delivered') {
      assigned.status = 'delivered';
      assigned.deliveredAt = new Date();
      await assigned.save();
    }
    return assigned;
  }
  if (order.fulfillment?.isBackorder) {
    throw new Error('Add delivery details first. This backorder has no real stock assigned yet.');
  }
  const stock = await StockItem.findOneAndUpdate(
    { productId: order.productId, status: 'available' },
    { status: 'delivered', assignedOrderId: order._id, deliveredAt: new Date() },
    { new: true, sort: { createdAt: 1 } }
  );
  if (!stock) throw new Error('No available stock for this product');
  order.assignedStockItemId = stock._id;
  return stock;
}

export async function approveOrder({ orderId, admin, source = 'admin' }) {
  const order = await Order.findOne({ orderId });
  if (!order) throw new Error('Order not found');
  if (order.status !== 'pending') throw new Error('Order is already ' + order.status);
  if (order.productSnapshot?.deliveryMode === 'manual' && !order.manualActivationActivatedAt) {
    throw new Error('Open customer login details and confirm Subscription activated first');
  }
  const stock = await assignDeliveryStock(order, admin);
  const nick = actorName(admin);
  order.status = 'approved';
  order.assignedStockItemId = stock._id;
  order.reviewedBy = admin?._id || null;
  order.reviewedByNickname = nick;
  order.reviewedAt = new Date();
  order.approvedBy = admin?._id || null;
  order.approvedByNickname = nick;
  order.approvedAt = new Date();
  setLoginCodeExpiry(order, stock, order.approvedAt);
  await order.save();
  const email = await emailDeliveryReceiptOnce(order);
  await logActivity(admin, 'order.approved', 'order', order.orderId, nick + ' approved order ' + order.orderId, { source });
  return { order, stock, email };
}

export async function rejectOrder({ orderId, admin, reason = 'Rejected via admin review', source = 'admin' }) {
  const order = await Order.findOne({ orderId });
  if (!order) throw new Error('Order not found');
  if (order.status !== 'pending') throw new Error('Order is already ' + order.status);
  const nick = actorName(admin);
  order.status = 'rejected';
  order.rejectReason = String(reason).slice(0, 500);
  order.reviewedBy = admin?._id || null;
  order.reviewedByNickname = nick;
  order.reviewedAt = new Date();
  order.rejectedBy = admin?._id || null;
  order.rejectedByNickname = nick;
  order.rejectedAt = new Date();
  await order.save();
  if (order.paymentMethod === 'reseller_due') {
    const reseller = await Reseller.findOne({ email: String(order.customer?.email || '').toLowerCase() }).lean();
    if (reseller) await voidResellerDue(order, reseller._id, { reason: order.rejectReason, admin, event: 'rejected' });
  }
  await logActivity(admin, 'order.rejected', 'order', order.orderId, nick + ' rejected order ' + order.orderId, { source });
  return { order };
}

// Approved/delivered orders are never deleted: cancellation revokes customer
// delivery access, preserves the encrypted stock item for audit, and appends a
// single reseller reversal. Retrying the request cannot charge or reverse twice.
export async function cancelApprovedOrder({ orderId, admin, reason = 'Cancelled by admin', source = 'admin' }) {
  const order = await Order.findOne({ orderId });
  if (!order) throw new Error('Order not found');
  if (order.status === 'cancelled') {
    return { order, alreadyCancelled: true, dueAdjustment: { reversed: false, amount: 0, currency: order.productSnapshot?.currency || 'BDT', remainingDue: null } };
  }
  if (!['approved', 'delivered'].includes(order.status)) {
    throw new Error('Only approved or delivered orders can be cancelled');
  }

  const nick = actorName(admin);
  const cleanReason = String(reason || 'Cancelled by admin').trim().slice(0, 500);
  let dueAdjustment = { reversed: false, amount: 0, currency: order.productSnapshot?.currency || 'BDT', remainingDue: null };
  if (order.paymentMethod === 'reseller_due') {
    const reseller = await Reseller.findOne({ email: String(order.customer?.email || '').toLowerCase() }).lean();
    if (reseller) dueAdjustment = await voidResellerDue(order, reseller._id, { reason: cleanReason, admin, event: 'cancelled' });
  }

  const previousStatus = order.status;
  order.status = 'cancelled';
  order.cancelReason = cleanReason;
  order.cancelledAt = new Date();
  order.cancelledBy = admin?._id || null;
  order.cancelledByNickname = nick;
  order.deliveryRevokedAt = new Date();
  order.getCodeAccessExpiresAt = null;
  await order.save();

  if (order.assignedStockItemId) {
    await StockItem.findByIdAndUpdate(order.assignedStockItemId, { $set: {
      status: 'cancelled',
      revokedAt: new Date(),
      revokeReason: cleanReason,
      revokedByAdminId: admin?._id || null,
      revokedByNickname: nick
    } });
  }

  await logActivity(admin, 'order.cancelled', 'order', order.orderId, nick + ' cancelled order ' + order.orderId, {
    source,
    previousStatus,
    reason: cleanReason,
    resellerDueReversed: dueAdjustment.amount || 0,
    currency: dueAdjustment.currency
  });
  return { order, alreadyCancelled: false, dueAdjustment };
}

export async function markOrderDelivered({ orderId, admin, source = 'admin' }) {
  const order = await Order.findOne({ orderId });
  if (!order) throw new Error('Order not found');
  if (!['pending', 'approved', 'delivered'].includes(order.status)) throw new Error('Order is ' + order.status);
  if (order.productSnapshot?.deliveryMode === 'manual' && !order.manualActivationActivatedAt) {
    throw new Error('Open customer login details and confirm Subscription activated first');
  }
  const nick = actorName(admin);
  let stock = null;
  if (order.status === 'pending') {
    stock = await assignDeliveryStock(order, admin);
    order.assignedStockItemId = stock._id;
    order.approvedBy = admin?._id || null;
    order.approvedByNickname = nick;
    order.approvedAt = new Date();
    order.reviewedBy = admin?._id || null;
    order.reviewedByNickname = nick;
    order.reviewedAt = new Date();
    setLoginCodeExpiry(order, stock, order.approvedAt);
  }
  if (!stock && order.assignedStockItemId) stock = await StockItem.findById(order.assignedStockItemId);
  setLoginCodeExpiry(order, stock, order.approvedAt || new Date());
  order.status = 'delivered';
  order.deliveredBy = admin?._id || null;
  order.deliveredByNickname = nick;
  order.deliveredAt = new Date();
  await order.save();
  const email = await emailDeliveryReceiptOnce(order);
  await logActivity(admin, 'order.delivered', 'order', order.orderId, nick + ' approved and delivered order ' + order.orderId, { source });
  return { order, stock, email };
}

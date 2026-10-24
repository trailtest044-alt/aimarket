import crypto from 'node:crypto';
import { Product } from '../models/Product.js';
import { Order } from '../models/Order.js';
import { SupplierSyncState } from '../models/SupplierSyncState.js';
import { request, supplierEnabled, reservePlandawStock, cancelPlandawReservation } from './plandawSupplier.js';

export function supplierImportFields(payload) {
  if (!payload?.supplierProductId || typeof payload.title !== 'string' || !Number.isFinite(payload.pricePKR) || payload.pricePKR <= 0) throw new Error('Invalid product import data');
  const fingerprint = crypto.createHash('sha256').update(`${payload.supplierProductId}:${payload.supplierPackageId || ''}`).digest('hex').slice(0, 20);
  const base = payload.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 85) || 'product';
  return {
    title: payload.title.slice(0, 160), slug: `${base}-${fingerprint}`,
    supplierProductId: payload.supplierProductId, supplierPackageId: payload.supplierPackageId || '',
    description: String(payload.description || ''), shortDescription: String(payload.shortDescription || ''),
    category: String(payload.category || 'AI Tools'), imageUrl: String(payload.imageUrl || ''), icon: String(payload.icon || '✨'),
    deliveryMode: payload.deliveryMode || 'credentials', deliveryMethod: String(payload.deliveryMethod || ''),
    validity: String(payload.validity || ''), warranty: String(payload.warranty || ''),
    pricePKR: payload.pricePKR, priceBDT: 0, priceUSDT: 0, isActive: true, createdByNickname: 'Plandaw product import'
  };
}
let running = false;
export async function runSupplierSync({ force = false } = {}) {
  if (!supplierEnabled()) return { configured: false };
  if (running) return { busy: true };
  running = true;
  let lease = false;
  try {
    await SupplierSyncState.updateOne({ _id: 'plandaw' }, { $setOnInsert: { failures: 0, lockUntil: new Date(0) } }, { upsert: true });
    const state = await SupplierSyncState.findOneAndUpdate({ _id: 'plandaw', lockUntil: { $lte: new Date() },
      ...(force ? {} : { $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: new Date() } }] }) },
    { $set: { lockUntil: new Date(Date.now() + 180000), lastAttemptAt: new Date() } }, { new: true });
    if (!state) return { busy: true };
    lease = true;
    const { jobs } = await request('/sync/jobs');
    if (!Array.isArray(jobs)) throw new Error('Invalid sync queue response');
    let imported = 0;
    for (const job of jobs.slice(0, 3)) {
      try {
      const payload = supplierImportFields(job.payload);
      const mapping = { supplierProductId: payload.supplierProductId, supplierPackageId: payload.supplierPackageId };
      const existing = await Product.findOne(mapping);
      const product = existing || await Product.findOneAndUpdate({ slug: payload.slug }, { $setOnInsert: payload }, { upsert: true, new: true, runValidators: true });
      await request(`/sync/jobs/${encodeURIComponent(job._id)}/result`, { method: 'POST', body: JSON.stringify({ ok: true, localProductId: String(product._id) }) });
      imported++;
      } catch (error) {
        await request(`/sync/jobs/${encodeURIComponent(job._id)}/result`, { method: 'POST', body: JSON.stringify({ ok: false, error: 'Product import failed. Check product data and Pakistan database connection.' }) }).catch(() => {});
        throw error;
      }
    }
    const orders = await Order.find({ $or: [
      { status: 'pending', 'supplier.provider': 'plandaw', 'supplier.status': { $in: ['reservation_failed', 'out_of_stock'] } },
      { 'supplier.cancelPending': true }
    ] }).sort({ 'supplier.lastAttemptAt': 1 }).limit(2);
    for (const order of orders) {
      if (order.supplier.cancelPending) {
        await cancelPlandawReservation(order);
        if (order.supplier.cancelPending) throw new Error('Supplier cancellation needs retry');
      } else {
        const result = await reservePlandawStock({ order, product: { supplierProductId: order.supplier.productId, supplierPackageId: order.supplier.packageId } });
        if (result.error && result.error.payload?.order?.status !== 'out_of_stock') throw new Error('Supplier order reservation needs attention; see order details');
      }
    }
    await SupplierSyncState.updateOne({ _id: 'plandaw' }, { $set: { lastSuccessAt: new Date(), nextAttemptAt: new Date(Date.now() + 30000), failures: 0, lastError: '' }, $inc: { imported } });
    return { ok: true, imported };
  } catch (error) {
    if (lease) {
      const state = await SupplierSyncState.findById('plandaw');
      const failures = Number(state?.failures || 0) + 1;
      await SupplierSyncState.updateOne({ _id: 'plandaw' }, { $set: { failures, lastError: 'Supplier sync failed. Check API connection and pending order details.', nextAttemptAt: new Date(Date.now() + Math.min(900000, 30000 * 2 ** Math.min(failures, 5))) } });
      if (failures >= 3) await request('/sync/alert', { method: 'POST', body: '{}' }).catch(() => {});
    }
    return { ok: false, error: 'Supplier sync failed; automatic retry is scheduled' };
  } finally {
    try { if (lease) await SupplierSyncState.updateOne({ _id: 'plandaw' }, { $set: { lockUntil: new Date(0) } }); }
    finally { running = false; }
  }
}
export function startSupplierSync() {
  const tick = () => { void runSupplierSync().catch(error => console.error('Supplier worker:', error.message)); };
  const timer = setInterval(tick, 30000);
  timer.unref();
  tick();
}

import { env } from '../config/env.js';

export function supplierEnabled() {
  return Boolean(env.plandawSupplier.apiUrl && env.plandawSupplier.apiKey);
}

let catalogCache = { expiresAt: 0, products: [], loaded: false };

export async function request(path, init = {}) {
  if (!supplierEnabled()) throw new Error('Plandaw supplier API is not configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(15000, env.plandawSupplier.timeoutMs));
  try {
    const response = await fetch(env.plandawSupplier.apiUrl + path, {
      ...init,
      signal: controller.signal,
      headers: { Authorization: `Bearer ${env.plandawSupplier.apiKey}`, 'Content-Type': 'application/json', ...(init.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `Plandaw supplier request failed (${response.status})`);
      error.status = response.status;
      error.payload = data;
      throw error;
    }
    return data;
  } finally { clearTimeout(timer); }
}

export async function reservePlandawStock({ order, product }) {
  if (!supplierEnabled() || !product?.supplierProductId) return { enabled: false };
  try {
    const result = await request('/orders', { method: 'POST', body: JSON.stringify({
      externalOrderId: order.orderId,
      externalCustomerRef: String(order.customer?._id || order.customer?.email || '').slice(0, 160),
      productId: product.supplierProductId,
      packageId: product.supplierPackageId || '',
      currency: order.productSnapshot?.currency === 'PKR' ? 'PKR' : order.productSnapshot?.currency === 'USDT' ? 'USDT' : 'BDT'
    }) });
    order.supplier = { provider: 'plandaw', productId: product.supplierProductId, packageId: product.supplierPackageId || '', partnerOrderId: result.order?._id || '', externalOrderId: order.orderId, status: result.order?.status || 'stock_reserved', reservedAt: new Date(), lastAttemptAt: new Date(), lastError: '' };
    if (['stock_reserved', 'delivered'].includes(order.supplier.status)) {
      if (order.productSnapshot) order.productSnapshot.backorder = false;
      order.fulfillment = {
        ...(order.fulfillment?.toObject?.() || order.fulfillment || {}),
        isBackorder: false,
        note: 'Plandaw stock reserved. Ready for Pakistan admin approval.'
      };
    }
    await order.save();
    return { enabled: true, reserved: ['stock_reserved', 'delivered'].includes(result.order?.status), order: result.order };
  } catch (error) {
    order.supplier = { ...(order.supplier?.toObject?.() || order.supplier || {}), provider: 'plandaw', productId: product.supplierProductId, packageId: product.supplierPackageId || '', externalOrderId: order.orderId, status: error.payload?.order?.status === 'out_of_stock' ? 'out_of_stock' : 'reservation_failed', lastError: String(error.message).slice(0, 500), lastAttemptAt: new Date() };
    await order.save();
    return { enabled: true, reserved: false, error };
  }
}

export async function plandawStockMap() {
  const snapshot = await plandawCatalogSnapshot();
  return new Map(snapshot.products.map((item) => [`${item.productId}:${item.packageId || ''}`, Number(item.availableStock || 0)]));
}

export async function plandawCatalogSnapshot() {
  if (!supplierEnabled()) return { enabled: false, authoritative: false, products: [] };
  if (catalogCache.expiresAt > Date.now()) return { enabled: true, authoritative: true, products: catalogCache.products };
  try {
    const result = await request('/catalog');
    if (!Array.isArray(result.products)) throw new Error('Invalid supplier catalog response');
    catalogCache = { expiresAt: Date.now() + 30_000, products: result.products, loaded: true };
  } catch {
    return { enabled: true, authoritative: catalogCache.loaded, products: catalogCache.products };
  }
  return { enabled: true, authoritative: true, products: catalogCache.products };
}

export async function fetchPlandawDelivery(order) {
  if (!supplierEnabled() || order.supplier?.provider !== 'plandaw') return null;
  if (!['stock_reserved', 'out_of_stock', 'reservation_failed', 'delivered'].includes(order.supplier?.status || '')) return null;
  if (!['stock_reserved', 'delivered'].includes(order.supplier.status)) {
    const product = { supplierProductId: order.supplier.productId, supplierPackageId: order.supplier.packageId };
    if (!product.supplierProductId) throw new Error(order.supplier.lastError || 'Supplier product mapping is missing');
    const retried = await reservePlandawStock({ order, product });
    if (!retried.reserved) throw new Error(retried.error?.message || 'Plandaw stock is not available yet');
  }
  const result = await request(`/orders/${encodeURIComponent(order.orderId)}/approve`, { method: 'POST', body: '{}' });
  if (!result.delivery || typeof result.delivery !== 'object') throw new Error('Supplier delivery response is missing details; retry this order');
  order.supplier = { ...(order.supplier?.toObject?.() || order.supplier || {}), status: 'delivered', deliveredAt: new Date(), lastError: '' };
  await order.save();
  return result.delivery || null;
}

export async function cancelPlandawReservation(order) {
  if (!supplierEnabled() || order.supplier?.provider !== 'plandaw' || ['cancelled', 'delivered'].includes(order.supplier?.status || '')) return;
  try {
    await request(`/orders/${encodeURIComponent(order.orderId)}/cancel`, { method: 'POST', body: '{}' });
    order.supplier = { ...(order.supplier?.toObject?.() || order.supplier || {}), status: 'cancelled', cancelPending: false, cancelledAt: new Date(), lastError: '' };
  } catch (error) {
    order.supplier = { ...(order.supplier?.toObject?.() || order.supplier || {}), cancelPending: true, lastError: String(error.message).slice(0, 500) };
  }
  await order.save();
}

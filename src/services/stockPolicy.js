export function storefrontSellableStock({ actualStock = 0, backorderAvailable = 0, supplierStock = 0, supplierLinked = false } = {}) {
  const localActual = Math.max(0, Number(actualStock || 0));
  const localBackorder = Math.max(0, Number(backorderAvailable || 0));
  if (!supplierLinked) return localActual + localBackorder;
  // Pakistan's display quantity is the local sales limit, while Plandaw's
  // real/backorder availability is the upstream limit. Local real stock never
  // depends on Plandaw; only the fallback portion is capped upstream.
  return localActual + Math.min(localBackorder, Math.max(0, Number(supplierStock || 0)));
}

export function shouldUseSupplierFallback({ actualStock = 0, orderIndex = 0, supplierProductId = '' } = {}) {
  return Boolean(supplierProductId) && Math.max(0, Number(orderIndex || 0)) >= Math.max(0, Number(actualStock || 0));
}

export function supplierReservationNeedsBackorder(reservation) {
  return !reservation?.reserved;
}

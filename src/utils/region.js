export function normalizeCountryCode(value) {
  return String(value || '').trim().toUpperCase().slice(0, 2) || 'XX';
}

export function regionFromCountry(countryCode) {
  return 'pk';
}

export function detectCountry(req) {
  // Supports common proxy/CDN country headers when available.
  const headers = req.headers || {};
  const candidates = [
    headers['cf-ipcountry'],
    headers['x-vercel-ip-country'],
    headers['x-country-code'],
    headers['cloudfront-viewer-country'],
  ];
  return normalizeCountryCode(candidates.find(Boolean) || 'XX');
}

export function detectRegion(req, requestedRegion) {
  const country = detectCountry(req);
  return { country, region: 'pk' };
}

export function priceForRegion(product, region) {
  return { amount: Number(product.pricePKR || 0), currency: 'PKR' };
}

export function allowedPaymentMethods(region) {
  return ['pakistan'];
}

export function priceRegionForPaymentMethod(paymentMethod, detectedRegion = 'world') {
  return 'pk';
}

export function expectedPaymentMethod(region) {
  return allowedPaymentMethods(region)[0];
}

export function normalizeCountryCode(value) {
  return String(value || '').trim().toUpperCase().slice(0, 2) || 'XX';
}

export function regionFromCountry(countryCode) {
  const code = normalizeCountryCode(countryCode);
  if (code === 'BD') return 'bd';
  if (code === 'PK') return 'pk';
  return 'world';
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
  const headerRegion = regionFromCountry(country);
  const requested = ['bd', 'pk', 'world'].includes(requestedRegion) ? requestedRegion : undefined;
  // If the hosting proxy did not provide a country header, use the frontend-detected region.
  const region = country === 'XX' && requested ? requested : headerRegion;
  return { country, region };
}

export function priceForRegion(product, region) {
  if (region === 'bd') return { amount: Number(product.priceBDT || 0), currency: 'BDT' };
  if (region === 'pk') return { amount: Number(product.pricePKR || 0), currency: 'PKR' };
  return { amount: Number(product.priceUSDT || 0), currency: product.worldwideCurrency || 'USDT' };
}

export function expectedPaymentMethod(region) {
  if (region === 'bd') return 'bangladesh';
  if (region === 'pk') return 'pakistan';
  return 'binance';
}

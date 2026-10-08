const express = require('express');
const { providerServices } = require('./provider');
const router = express.Router();
const { applyPricing, defaultMarkupPercent, getPricingOverrides, roundMoney } = require('./pricing');

const CACHE_MS = Number(process.env.SERVICE_CACHE_MS || 5 * 60 * 1000);
let cachedServices = null;
let cachedAt = 0;
let refreshPromise = null;

function detectPlatform(name, category, raw) {
  const text = `${name || ''} ${category || ''} ${raw?.platform || ''}`.toLowerCase();
  if (text.includes('tiktok') || text.includes('tik tok')) return 'TikTok';
  if (text.includes('facebook') || text.includes('fb')) return 'Facebook';
  if (text.includes('instagram') || text.includes('ig')) return 'Instagram';
  if (text.includes('youtube') || text.includes('yt')) return 'Youtube';
  if (text.includes('telegram') || text.includes('tele')) return 'Telegram';
  if (text.includes('shopee')) return 'Shopee';
  return 'Khác';
}

function toBool(value) {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

function normalizeService(row) {
  const service = Number(row.service ?? row.id);
  const name = String(row.name ?? '').trim();
  const category = String(row.category ?? row.type ?? 'Khác').trim() || 'Khác';
  const platform = detectPlatform(name, category, row);
  const type = String(row.type ?? 'Default').trim() || 'Default';
  const rateNumber = Number.parseFloat(row.rate ?? 0);
  const minNumber = Number.parseInt(row.min ?? 0, 10);
  const maxNumber = Number.parseInt(row.max ?? 0, 10);
  const mode = String(process.env.PROVIDER_RATE_MODE || 'USD_PER_1000').trim().toUpperCase();
  const clean = value => roundMoney(value);

  if (!Number.isFinite(service) || !Number.isSafeInteger(service) || !name || !Number.isFinite(rateNumber) || !Number.isFinite(minNumber) || !Number.isFinite(maxNumber) || rateNumber < 0 || minNumber < 0 || maxNumber < minNumber) return null;

  let providerUnitVnd;
  if (mode === 'VND_PER_1') {
    providerUnitVnd = rateNumber;
  } else if (mode === 'VND_PER_1000') {
    providerUnitVnd = rateNumber / 1000;
  } else if (mode === 'USD_PER_1000') {
    const usdVnd = Number(process.env.USD_VND_RATE || 27000);
    if (!Number.isFinite(usdVnd) || usdVnd <= 0) throw new Error('USD_VND_RATE is invalid');
    const providerUsdPer1000 = rateNumber >= 10 ? rateNumber / 1000 : rateNumber;
    providerUnitVnd = providerUsdPer1000 * usdVnd / 1000;
  } else {
    throw new Error(`Unsupported PROVIDER_RATE_MODE: ${mode}`);
  }

  const base = {
    service,
    name,
    type,
    platform,
    category,
    providerRate: clean(rateNumber),
    providerRateMode: mode,
    providerUnitRateVnd: clean(providerUnitVnd),
    min: String(minNumber),
    max: String(maxNumber),
    refill: toBool(row.refill),
    cancel: toBool(row.cancel)
  };

  return applyPricing(base);
}

async function fetchProviderServices() {
  const data = await providerServices();
  if (!Array.isArray(data)) throw new Error('Provider services response is not an array');
  const normalized = data.map(normalizeService).filter(Boolean);
  if (!normalized.length) throw new Error('Provider returned no usable services');
  return normalized;
}

async function persistCatalog(db, services) {
  if (!db || !services.length) return;
  const chunkSize = 400;
  for (let index = 0; index < services.length; index += chunkSize) {
    const batch = db.batch();
    for (const service of services.slice(index, index + chunkSize)) {
      const ref = db.collection('service_catalog').doc(String(service.service));
      batch.set(ref, {
        ...service,
        lastSyncedAt: new Date()
      }, { merge: true });
    }
    await batch.commit();
  }
  await db.collection('system').doc('serviceSync').set({
    serviceCount: services.length,
    syncedAt: new Date(),
    providerRateMode: process.env.PROVIDER_RATE_MODE || 'USD_PER_1000',
    defaultMarkupPercent: defaultMarkupPercent()
  }, { merge: true });
}

async function getServices(forceRefresh = false, db = null) {
  const now = Date.now();
  if (!forceRefresh && cachedServices && now - cachedAt < CACHE_MS) return cachedServices;
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const freshBase = await fetchProviderServices();
      let overrides = new Map();
      try {
        overrides = await getPricingOverrides(db);
      } catch (error) {
        console.error('pricing overrides unavailable; using defaults:', error?.message || error);
      }
      const fresh = freshBase
        .map(service => applyPricing(service, overrides.get(String(service.service))))
        .filter(service => service.enabled);
      cachedServices = fresh;
      cachedAt = Date.now();
      if (db) await persistCatalog(db, fresh);
      return fresh;
    } catch (error) {
      if (cachedServices?.length) {
        console.error('Provider refresh failed; serving cached services:', error.message);
        return cachedServices;
      }
      throw error;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function loadCatalogFallback(db) {
  if (!db) return [];
  try {
    const snap = await db.collection('service_catalog').limit(2000).get();
    const rows = snap.docs.map(d => d.data() || {}).filter(x => x.service != null);
    return rows;
  } catch (error) {
    console.error('service catalog fallback:', error?.code || 'unknown', error?.message || error);
    return [];
  }
}

async function syncServices(db, forceRefresh = true) {
  try {
    return await getServices(forceRefresh, db);
  } catch (error) {
    const fallback = await loadCatalogFallback(db);
    if (fallback.length) {
      cachedServices = fallback;
      cachedAt = Date.now();
      console.error('Provider sync failed; using Firestore catalog fallback:', error?.message || error);
      return fallback;
    }
    throw error;
  }
}

router.get('/', async (req, res) => {
  try {
    const services = await getServices(req.query.refresh === '1', req.app.locals.db);
    res.set('Cache-Control', 'no-store');
    res.json({ services, cachedAt, count: services.length, defaultMarkupPercent: defaultMarkupPercent(), degraded: false });
  } catch (error) {
    const fallback = await loadCatalogFallback(req.app.locals.db);
    if (fallback.length) {
      cachedServices = fallback;
      cachedAt = Date.now();
      console.error('services: Provider unavailable; returning Firestore catalog fallback:', error.message);
      res.set('Cache-Control', 'no-store');
      return res.json({
        services: fallback,
        cachedAt,
        count: fallback.length,
        defaultMarkupPercent: defaultMarkupPercent(),
        degraded: true,
        provider: { available: false, code: error?.providerCode || error?.code || 'PROVIDER_ERROR', httpStatus: error?.providerStatus || null }
      });
    }
    console.error('services:', error);
    res.status(502).json({
      error: 'Không lấy được danh sách dịch vụ từ Provider',
      code: error?.providerCode || error?.code || 'PROVIDER_ERROR',
      httpStatus: error?.providerStatus || null,
      message: String(error?.message || 'Provider unavailable').slice(0, 300),
      providerConfigured: Boolean(
        String(process.env.PROVIDER_API_URL || '').trim() &&
        String(process.env.PROVIDER_API_KEY || '').trim()
      )
    });
  }
});

router.get('/:serviceId', async (req, res) => {
  try {
    const serviceId = Number.parseInt(req.params.serviceId, 10);
    if (!Number.isInteger(serviceId)) return res.status(400).json({ error: 'Service ID không hợp lệ' });
    const services = await getServices(false, req.app.locals.db);
    const service = services.find(v => v.service === serviceId);
    if (!service) return res.status(404).json({ error: 'Không tìm thấy dịch vụ' });
    res.json({ service });
  } catch (error) {
    console.error('service detail:', error.message);
    res.status(502).json({ error: 'Không lấy được dịch vụ' });
  }
});

module.exports = router;
module.exports.getServices = getServices;
module.exports.syncServices = syncServices;
module.exports.loadCatalogFallback = loadCatalogFallback;
module.exports.normalizeService = normalizeService;

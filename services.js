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
  try {
    if (!row || typeof row !== 'object') return null;

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

    if (!Number.isFinite(service) || !Number.isSafeInteger(service) || !name || !Number.isFinite(rateNumber) || !Number.isFinite(minNumber) || !Number.isFinite(maxNumber) || rateNumber <= 0 || minNumber < 0 || maxNumber < minNumber) {
      return null;
    }

    let providerUnitVnd;
    if (mode === 'VND_PER_1') {
      providerUnitVnd = rateNumber;
    } else if (mode === 'VND_PER_1000') {
      providerUnitVnd = rateNumber / 1000;
    } else if (mode === 'USD_PER_1000') {
      const usdVnd = Number(process.env.USD_VND_RATE || 27000);
      if (!Number.isFinite(usdVnd) || usdVnd <= 0) return null;
      const providerUsdPer1000 = rateNumber >= 10 ? rateNumber / 1000 : rateNumber;
      providerUnitVnd = providerUsdPer1000 * usdVnd / 1000;
    } else {
      return null;
    }

    if (!Number.isFinite(providerUnitVnd) || providerUnitVnd < 0) return null;

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
  } catch (err) {
    return null;
  }
}

// ĐÃ SỬA: Bọc lót an toàn, trả về mảng rỗng [] thay vì throw Error làm sập Cron Job
async function fetchProviderServices() {
  try {
    const data = await providerServices();
    if (!Array.isArray(data)) return [];
    return data.map(normalizeService).filter(Boolean);
  } catch (error) {
    console.error('fetchProviderServices error:', error?.message || error);
    return [];
  }
}

async function persistCatalog(db, services) {
  if (!db || !services.length) return;
  try {
    const chunkSize = 400;
    for (let index = 0; index < services.length; index += chunkSize) {
      const batch = db.batch();
      for (const service of services.slice(index, index + chunkSize)) {
        const ref = db.collection('service_catalog').doc(String(service.service));
        batch.set(ref, { ...service, lastSyncedAt: new Date() }, { merge: true });
      }
      await batch.commit();
    }
  } catch (err) {
    console.error('persistCatalog error:', err.message);
  }
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
      } catch {}

      const fresh = freshBase
        .map(service => {
          try { return applyPricing(service, overrides.get(String(service.service))); }
          catch { return service; }
        })
        .filter(Boolean)
        .filter(service => service.enabled !== false);

      if (fresh.length > 0) {
        cachedServices = fresh;
        cachedAt = Date.now();
        if (db) await persistCatalog(db, fresh);
        return fresh;
      }
      
      // Nếu Provider bị lỗi/rỗng, tự động lấy dữ liệu lưu tạm từ Firestore Catalog
      return await loadCatalogFallback(db);
    } catch (error) {
      return await loadCatalogFallback(db);
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function loadCatalogFallback(db) {
  if (!db) return cachedServices || [];
  try {
    const snap = await db.collection('service_catalog').limit(2000).get();
    const rows = snap.docs.map(d => d.data() || {}).filter(x => x.service != null);
    if (rows.length) {
      cachedServices = rows;
      cachedAt = Date.now();
    }
    return rows;
  } catch {
    return cachedServices || [];
  }
}

async function syncServices(db, forceRefresh = true) {
  try {
    return await getServices(forceRefresh, db);
  } catch (error) {
    return await loadCatalogFallback(db);
  }
}

router.get('/', async (req, res) => {
  try {
    const services = await getServices(req.query.refresh === '1', req.app.locals.db);
    res.set('Cache-Control', 'no-store');
    res.json({
      services,
      cachedAt,
      count: services.length,
      defaultMarkupPercent: defaultMarkupPercent(),
      degraded: services.length === 0
    });
  } catch (error) {
    res.status(200).json({
      services: [],
      cachedAt: Date.now(),
      count: 0,
      defaultMarkupPercent: defaultMarkupPercent(),
      degraded: true
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
    res.status(502).json({ error: 'Không lấy được dịch vụ' });
  }
});

module.exports = router;
module.exports.getServices = getServices;
module.exports.syncServices = syncServices;
module.exports.loadCatalogFallback = loadCatalogFallback;
module.exports.normalizeService = normalizeService;

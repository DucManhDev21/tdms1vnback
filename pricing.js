const DEFAULT_MARKUP_PERCENT = 30;
const MAX_MARKUP_PERCENT = 1000;

function roundMoney(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

function parseMarkup(value, fallback = DEFAULT_MARKUP_PERCENT) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(MAX_MARKUP_PERCENT, Math.max(0, number));
}

function defaultMarkupPercent() {
  return parseMarkup(process.env.SERVICE_MARKUP_PERCENT, DEFAULT_MARKUP_PERCENT);
}

async function getPricingOverrides(db) {
  if (!db) return new Map();
  try {
    const snap = await db.collection('service_pricing').get();
    const map = new Map();
    for (const doc of snap.docs) {
      const data = doc.data() || {};
      map.set(String(doc.id), {
        markupPercent: parseMarkup(data.markupPercent, defaultMarkupPercent()),
        fixedUnitRateVnd: data.fixedUnitRateVnd == null || data.fixedUnitRateVnd === '' ? null : roundMoney(data.fixedUnitRateVnd),
        enabled: data.enabled !== false,
        updatedAt: data.updatedAt || null
      });
    }
    return map;
  } catch (err) {
    console.error('getPricingOverrides error:', err.message);
    return new Map();
  }
}

function applyPricing(service, override = null) {
  if (!service) return null;
  
  const providerUnitRate = Number(service.unitRateVnd ?? service.providerUnitRateVnd ?? service.rate);
  
  // Trả về null để bỏ qua dịch vụ lỗi giá thay vì throw Error làm sập server
  if (!Number.isFinite(providerUnitRate) || providerUnitRate < 0) {
    return null;
  }

  const markupPercent = parseMarkup(override?.markupPercent, defaultMarkupPercent());
  const customRate = override?.fixedUnitRateVnd;
  const sellingRate = customRate != null && Number.isFinite(Number(customRate)) && Number(customRate) >= 0
    ? roundMoney(customRate)
    : roundMoney(providerUnitRate * (1 + markupPercent / 100));

  return {
    ...service,
    providerUnitRateVnd: roundMoney(providerUnitRate),
    providerRateRaw: service.providerRate ?? null,
    rate: sellingRate,
    unitRateVnd: sellingRate,
    sellingRateVnd: sellingRate,
    markupPercent,
    fixedUnitRateVnd: customRate == null ? null : roundMoney(customRate),
    enabled: override?.enabled !== false
  };
}

function calculateTotal(rate, quantity) {
  const unitRate = Number(rate);
  const qty = Number(quantity);
  if (!Number.isFinite(unitRate) || unitRate < 0 || !Number.isSafeInteger(qty) || qty <= 0) {
    throw new Error('Giá hoặc số lượng không hợp lệ');
  }
  const total = roundMoney(unitRate * qty);
  if (!Number.isFinite(total) || total < 0) throw new Error('Tổng tiền không hợp lệ');
  return total;
}

module.exports = {
  DEFAULT_MARKUP_PERCENT,
  MAX_MARKUP_PERCENT,
  roundMoney,
  parseMarkup,
  defaultMarkupPercent,
  getPricingOverrides,
  applyPricing,
  calculateTotal
};

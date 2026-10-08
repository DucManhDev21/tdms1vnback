'use strict';

const PROVIDER_RETRIES = Math.min(
  Math.max(Number(process.env.PROVIDER_RETRIES || 2), 0),
  3
);

function providerConfig() {
  const rawUrl = String(process.env.PROVIDER_API_URL || '').trim();
  const key = String(process.env.PROVIDER_API_KEY || '').trim();

  if (!rawUrl) throw new Error('PROVIDER_API_URL chưa được cấu hình');
  if (!key) throw new Error('PROVIDER_API_KEY chưa được cấu hình');

  let url = rawUrl.replace(/\s+/g, '').replace(/\/+$/, '');
  if (!/\/api\/v2$/i.test(url)) url += '/api/v2';

  return {
    url,
    key,
    timeout: Math.min(
      Math.max(Number(process.env.PROVIDER_TIMEOUT_MS || 30000), 5000),
      60000
    )
  };
}

function providerError(error, action = 'Provider API') {
  const out = new Error(
    String(
      error?.providerMessage ||
      error?.message ||
      `${action} thất bại`
    ).slice(0, 1000)
  );
  out.providerStatus = error?.providerStatus || null;
  out.providerCode = error?.providerCode || error?.code || null;
  out.providerResponse = error?.providerResponse ?? null;
  return out;
}

async function readResponse(response) {
  const text = await response.text();
  let data = null;

  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text.trim();
    }
  }

  if (!response.ok) {
    throw Object.assign(
      new Error(
        typeof data === 'object' && data?.error
          ? String(data.error)
          : `Provider HTTP ${response.status}`
      ),
      {
        providerStatus: response.status,
        providerResponse: data
      }
    );
  }

  if (typeof data === 'string') {
    throw Object.assign(
      new Error(`Provider trả về dữ liệu không phải JSON: ${data.slice(0, 300)}`),
      { providerStatus: response.status, providerResponse: data }
    );
  }

  if (data && !Array.isArray(data) && typeof data === 'object' && data.error) {
    throw Object.assign(new Error(String(data.error)), {
      providerStatus: response.status,
      providerResponse: data
    });
  }

  return data;
}

async function providerRequest(params) {
  const cfg = providerConfig();
  let lastError = null;

  for (let attempt = 0; attempt <= PROVIDER_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeout);

    try {
      const body = new URLSearchParams({
        key: cfg.key,
        ...Object.fromEntries(
          Object.entries(params || {}).map(([k, v]) => [k, String(v)])
        )
      }).toString();

      const response = await fetch(cfg.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          'User-Agent': 'TDMS1VN-ProviderClient/12.2'
        },
        body,
        signal: controller.signal
      });

      return await readResponse(response);
    } catch (error) {
      if (error?.name === 'AbortError') {
        lastError = Object.assign(new Error('Provider request timeout'), {
          providerCode: 'ETIMEDOUT'
        });
      } else {
        lastError = error;
      }

      const status = lastError?.providerStatus || null;
      const retryable =
        !status ||
        status === 408 ||
        status === 425 ||
        status === 429 ||
        status >= 500;

      if (!retryable || attempt >= PROVIDER_RETRIES) break;
      await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }

  throw providerError(
    lastError,
    `Provider action ${String(params?.action || 'request')}`
  );
}

async function providerServices() {
  const data = await providerRequest({ action: 'services' });
  if (!Array.isArray(data)) {
    throw Object.assign(
      new Error('Provider services response không phải là mảng'),
      { providerResponse: data }
    );
  }
  return data;
}

async function providerAddOrder({ service, link, quantity, comments, reaction }) {
  const params = {
    action: 'add',
    service: String(service),
    link: String(link),
    quantity: String(quantity)
  };
  if (comments) params.comments = String(comments);
  if (reaction) params.reaction = String(reaction);
  return providerRequest(params);
}

async function providerStatus(order) {
  return providerRequest({ action: 'status', order: String(order) });
}

async function providerCancel(orders) {
  return providerRequest({
    action: 'cancel',
    orders: Array.isArray(orders) ? orders.join(',') : String(orders)
  });
}

async function providerRefill(orders) {
  return providerRequest({
    action: 'refill',
    orders: Array.isArray(orders) ? orders.join(',') : String(orders)
  });
}

module.exports = {
  providerConfig,
  providerError,
  providerRequest,
  providerServices,
  providerAddOrder,
  providerStatus,
  providerCancel,
  providerRefill
};

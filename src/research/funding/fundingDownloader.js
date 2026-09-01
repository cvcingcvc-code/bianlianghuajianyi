// Binance USD-M Futures funding rate downloader.
// Research-only. Paginated, retry-capable, rate-limit friendly.
// Data source: GET /fapi/v1/fundingRate

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const BASE_URL = 'https://fapi.binance.com';
const ENDPOINT = '/fapi/v1/fundingRate';
const PAGE_LIMIT = 1000;
const RETRY_MAX = 5;
const RETRY_DELAY_MS = 2000;
const PAGE_DELAY_MS = 250; // rate-limit: ~4 req/s

const HOLDOUT_START_MS = Date.UTC(2026, 0, 1);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchPage(symbol, startTime, endTime, limit = PAGE_LIMIT) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ symbol, limit: String(limit) });
    if (startTime != null) params.set('startTime', String(startTime));
    if (endTime != null) params.set('endTime', String(endTime));
    const url = `${BASE_URL}${ENDPOINT}?${params}`;
    https.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 429) {
          return reject(new Error('RATE_LIMITED'));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function fetchWithRetry(symbol, startTime, endTime) {
  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    try {
      return await fetchPage(symbol, startTime, endTime);
    } catch (err) {
      if (attempt === RETRY_MAX) throw err;
      const delay = RETRY_DELAY_MS * attempt;
      console.warn(`  [retry ${attempt}/${RETRY_MAX}] ${symbol} ${err.message}, waiting ${delay}ms`);
      await sleep(delay);
    }
  }
}

// Download all funding rate events for a symbol from startMs to endMs (inclusive).
// Returns sorted, deduplicated array of raw API objects.
async function downloadFundingHistory({ symbol, startMs, endMs, onProgress }) {
  if (endMs >= HOLDOUT_START_MS) {
    throw new Error(`endTime ${endMs} touches 2026 HOLDOUT — refusing to download`);
  }

  const allEvents = [];
  let cursor = startMs;
  let page = 0;

  while (cursor <= endMs) {
    page++;
    const batch = await fetchWithRetry(symbol, cursor, endMs);
    if (!Array.isArray(batch) || batch.length === 0) break;

    allEvents.push(...batch);
    if (onProgress) onProgress({ symbol, page, count: allEvents.length, lastTime: batch[batch.length - 1].fundingTime });

    // next startTime = last fundingTime + 1 (avoid duplicate boundary)
    const lastTime = batch[batch.length - 1].fundingTime;
    cursor = lastTime + 1;

    // guard: if batch filled the limit, keep paginating; otherwise done
    if (batch.length < PAGE_LIMIT) break;

    await sleep(PAGE_DELAY_MS);
  }

  // sort ascending by fundingTime
  allEvents.sort((a, b) => a.fundingTime - b.fundingTime);

  // deduplicate by fundingTime
  const seen = new Set();
  const deduped = [];
  for (const ev of allEvents) {
    if (!seen.has(ev.fundingTime)) {
      seen.add(ev.fundingTime);
      deduped.push(ev);
    }
  }

  return deduped;
}

// Save events to CSV. Forward-compatible: writes available fields.
function saveFundingCSV(events, filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const header = 'symbol,fundingTime,fundingRate,markPrice,rateType\n';
  const rows = events.map((e) => {
    const parts = [
      e.symbol,
      e.fundingTime,
      e.fundingRate,
      e.markPrice != null ? e.markPrice : '',
      e.rateType != null ? e.rateType : '',
    ];
    return parts.join(',');
  }).join('\n');

  fs.writeFileSync(filePath, header + rows + '\n', 'utf8');
}

// Load events from CSV. Forward-compatible: reads available fields, ignores unknown.
function loadFundingCSV(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim());
  if (lines.length <= 1) return [];

  const header = lines[0].split(',');
  const events = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    const row = {};
    for (let j = 0; j < header.length; j++) {
      row[header[j]] = values[j];
    }
    events.push({
      symbol: row.symbol,
      fundingTime: Number(row.fundingTime),
      fundingRate: Number(row.fundingRate),
      markPrice: row.markPrice ? Number(row.markPrice) : null,
      rateType: row.rateType || null,
    });
  }
  return events;
}

module.exports = { downloadFundingHistory, saveFundingCSV, loadFundingCSV, HOLDOUT_START_MS };

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const puppeteer = require('puppeteer');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Available confirmed models (in priority order)
const GEMINI_MODELS = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-001',
  'gemini-2.5-flash',
];

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ── Currency: live exchange rate cache ──
let exchangeRates = {};
let ratesFetchedAt = 0;

async function getINRRate(fromCurrency = 'USD') {
  const now = Date.now();
  // Refresh rates every 30 minutes
  if (now - ratesFetchedAt > 30 * 60 * 1000 || !exchangeRates[fromCurrency]) {
    try {
      const res = await axios.get(
        `https://api.exchangerate-api.com/v4/latest/INR`,
        { timeout: 5000 }
      );
      // rates are relative to INR, so we invert
      const rates = res.data.rates;
      exchangeRates = rates;
      ratesFetchedAt = now;
    } catch {
      // fallback approximate rates
      exchangeRates = { USD: 0.012, EUR: 0.011, GBP: 0.0095, JPY: 1.8, INR: 1 };
    }
  }
  const upper = fromCurrency.toUpperCase();
  // exchangeRates[X] = how many X per 1 INR → to convert X to INR: divide by rate
  if (upper === 'INR') return 1;
  const rate = exchangeRates[upper];
  return rate ? (1 / rate) : 83; // default USD→INR fallback
}

async function toINR(amount, currency = 'USD') {
  if (!amount || isNaN(amount)) return null;
  const rate = await getINRRate(currency);
  return Math.round(amount * rate);
}

// ── Helper: detect currency from price string ──
function detectCurrency(priceStr) {
  if (!priceStr) return 'USD';
  if (priceStr.includes('₹') || priceStr.toLowerCase().includes('inr')) return 'INR';
  if (priceStr.includes('€')) return 'EUR';
  if (priceStr.includes('£')) return 'GBP';
  if (priceStr.includes('¥')) return 'JPY';
  return 'USD';
}

// ── Helper: extract numeric price from string ──
function parseNumericPrice(str) {
  if (!str) return null;
  const cleaned = str.replace(/[^\d.,]/g, '').replace(/,/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// ── Helper: get website name from URL ──
function getWebsiteName(url) {
  try {
    const hostname = new URL(url).hostname.replace('www.', '');
    const parts = hostname.split('.');
    const name = parts[0];
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    return 'Website';
  }
}

// ── Helper: extract product name from URL slug ──
function extractProductNameFromUrl(url) {
  try {
    const parsed = new URL(url);
    // Get the full path and split by /
    const segments = parsed.pathname.split('/').filter(Boolean);

    // Find the longest segment that looks like a product slug
    // (contains letters and hyphens/underscores, not just an ID)
    let bestSlug = '';
    for (const seg of segments) {
      // Skip short segments, pure IDs (all digits), or short codes
      if (seg.length > bestSlug.length && /[a-zA-Z]{3,}/.test(seg) && !/^\/?(dp|p|product|item|pd)$/.test(seg)) {
        bestSlug = seg;
      }
    }

    if (!bestSlug) return null;

    // Convert slug to human-readable: replace - and _ with spaces, remove trailing IDs
    let name = bestSlug
      .replace(/[-_]/g, ' ')
      .replace(/\b[a-f0-9]{8,}\b/gi, '')          // remove hex IDs
      .replace(/\b\d{4,}\b/g, '')                   // remove long numbers
      .replace(/\s+/g, ' ')
      .trim();

    // Title-case
    name = name.replace(/\b\w/g, c => c.toUpperCase());
    return name.length > 3 ? name : null;
  } catch {
    return null;
  }
}

// ── Detect if running on a cloud environment (Render, Railway, etc.) ──
const IS_CLOUD = !!process.env.RENDER || !!process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production';
console.log(`🌐 Environment: ${IS_CLOUD ? 'CLOUD (Puppeteer disabled)' : 'LOCAL'}`);

// ── Axios headers that mimic a real browser closely ──
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'max-age=0',
  'Sec-Ch-Ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  'Connection': 'keep-alive',
  'DNT': '1',
};

// ── Puppeteer: fetch rendered HTML (local only) ──
async function fetchRenderedHTML(url) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1280,800',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    const page = await browser.newPage();

    // Spoof a real modern browser more aggressively
    await page.setUserAgent(BROWSER_HEADERS['User-Agent']);
    await page.setExtraHTTPHeaders({
      'Accept-Language': BROWSER_HEADERS['Accept-Language'],
      'Accept': BROWSER_HEADERS['Accept'],
      'Sec-Ch-Ua': BROWSER_HEADERS['Sec-Ch-Ua'],
      'Sec-Ch-Ua-Mobile': BROWSER_HEADERS['Sec-Ch-Ua-Mobile'],
      'Sec-Ch-Ua-Platform': BROWSER_HEADERS['Sec-Ch-Ua-Platform'],
      'Sec-Fetch-Dest': BROWSER_HEADERS['Sec-Fetch-Dest'],
      'Sec-Fetch-Mode': BROWSER_HEADERS['Sec-Fetch-Mode'],
      'Sec-Fetch-Site': BROWSER_HEADERS['Sec-Fetch-Site'],
      'Sec-Fetch-User': BROWSER_HEADERS['Sec-Fetch-User'],
      'Upgrade-Insecure-Requests': BROWSER_HEADERS['Upgrade-Insecure-Requests'],
    });

    // Bypass common webdriver checks
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    });

    // Only block media/fonts — allow stylesheets so price elements load
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'font', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Navigate and wait for network to settle
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Extra wait for dynamic price elements (Amazon loads prices via JS)
    await new Promise(r => setTimeout(r, 3000));

    // Try to dismiss cookie/location popups
    try { await page.click('#sp-cc-accept', { timeout: 1000 }); } catch { }
    try { await page.click('.a-button-input[aria-labelledby="a-autoid-0-announce"]', { timeout: 1000 }); } catch { }

    const html = await page.content();
    return html;
  } finally {
    if (browser) await browser.close();
  }
}

// ── Axios: fetch HTML with browser-like headers ──
async function fetchWithAxios(url) {
  const response = await axios.get(url, {
    headers: BROWSER_HEADERS,
    timeout: 20000,
    maxRedirects: 5,
    validateStatus: (status) => status < 400,
  });
  return response.data;
}



// ── Cleaner: strip junk from HTML ──
function cleanHTML(html) {
  // Remove script, style, nav, footer, header, aside, ads
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')         // strip remaining tags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s{2,}/g, ' ')          // collapse whitespace
    .trim();

  // Truncate to ~8000 chars to stay within Gemini token limits
  return cleaned.slice(0, 8000);
}

// ── Gemini AI: extract product data ──
async function extractWithGemini(cleanedText, url) {
  let lastError;
  for (const modelName of GEMINI_MODELS) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });

      const prompt = `You are a product data extractor for an e-commerce price comparison tool.
From the text below (scraped from ${url}), extract the following:
1. Product name - the main product title being sold
2. Current selling price - the actual price with currency symbol (look for ₹, $, etc.)
3. Three short feature/description bullet points about the product

IMPORTANT:
- For Amazon India pages, the price is usually shown as ₹X,XXX or ₹X,XX,XXX
- Look for words like "price", "deal price", "M.R.P", "offer price"
- Description points should be factual product features (RAM, storage, camera, etc.)
- If you see multiple prices, pick the lowest current selling price

Respond ONLY with valid JSON, no markdown, no explanation:
{
  "name": "full product name here",
  "priceText": "price with currency symbol e.g. ₹24,999",
  "currency": "INR",
  "description": ["feature 1", "feature 2", "feature 3"],
  "image": ""
}

Text to analyze:
${cleanedText}`;

      const result = await model.generateContent(prompt);
      const text = result.response.text();
      console.log(`✅ Gemini model ${modelName} responded`);

      // Extract JSON - handle markdown code blocks too
      const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON in response');
      const jsonStr = jsonMatch[1] || jsonMatch[0];
      return JSON.parse(jsonStr);
    } catch (err) {
      console.warn(`⚠️  Model ${modelName} failed:`, err.message);
      lastError = err;
    }
  }
  throw new Error(`All Gemini models failed. Last error: ${lastError?.message}`);
}

// ── POST /scrape ──
app.post('/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const websiteName = getWebsiteName(url);

  // ── Helper: build a blocked-site response from URL slug ──
  function blockedResponse(reason) {
    const slugName = extractProductNameFromUrl(url);
    console.warn(`⛔ Blocked/failed (${reason}). Slug extracted: "${slugName}"`);
    return res.json({
      blocked: true,
      name: slugName || 'Product',
      searchQuery: slugName,
      price: null,
      priceText: null,
      description: [],
      image: '',
      url,
      websiteName,
      blockerMessage: `⛔ ${websiteName} has blocked access to this page. We've extracted the product name from the URL and will search for similar products.`,
    });
  }

  try {
    console.log(`\n🌐 Fetching: ${url} [${IS_CLOUD ? 'CLOUD/Axios' : 'LOCAL/Puppeteer'}]`);

    // Step 1: Fetch HTML — use Puppeteer locally, Axios on cloud
    let html;
    let fetchFailed = false;

    if (!IS_CLOUD) {
      // LOCAL: Try Puppeteer first for JS-rendered pages
      try {
        html = await fetchRenderedHTML(url);
        console.log(`✅ Puppeteer fetched ${html.length} chars`);
      } catch (puppeteerErr) {
        console.warn('⚠️  Puppeteer failed, trying axios:', puppeteerErr.message);
      }
    }

    // CLOUD or Puppeteer failed: use Axios with browser headers
    if (!html) {
      try {
        html = await fetchWithAxios(url);
        console.log(`✅ Axios fetched ${html?.length} chars`);
      } catch (axiosErr) {
        console.warn('⚠️  Axios also failed:', axiosErr.message);
        fetchFailed = true;
      }
    }

    // If both fetchers failed — site is blocking us
    if (fetchFailed || !html || html.length < 500) {
      return blockedResponse('fetch failed or empty HTML');
    }

    // Step 2: Clean HTML
    const cleanedText = cleanHTML(html);
    console.log(`🧹 Cleaned to ${cleanedText.length} chars`);

    // If cleaned text is too short, the site returned a bot-check page
    if (cleanedText.length < 200) {
      return blockedResponse('bot-check / CAPTCHA detected');
    }

    // Step 3: Gemini AI extraction
    console.log(`🤖 Sending to Gemini AI...`);
    let extracted;
    try {
      extracted = await extractWithGemini(cleanedText, url);
      console.log(`✨ Gemini extracted:`, extracted.name, extracted.priceText);
    } catch (geminiErr) {
      console.warn('⚠️  Gemini failed:', geminiErr.message);
      return blockedResponse('AI extraction failed');
    }

    // If Gemini couldn’t find the product name — treat as blocked
    const isUnknown = !extracted.name ||
      extracted.name.toLowerCase().includes('unknown') ||
      extracted.name.trim().length < 3;

    if (isUnknown) {
      return blockedResponse('product name not found in page content');
    }

    // Step 4: Convert price to INR
    const numericPrice = parseNumericPrice(extracted.priceText);
    const currency = extracted.currency || detectCurrency(extracted.priceText);
    const priceINR = await toINR(numericPrice, currency);

    res.json({
      blocked: false,
      name: extracted.name,
      searchQuery: extracted.name,
      price: priceINR,
      priceText: priceINR ? `₹${priceINR.toLocaleString('en-IN')}` : extracted.priceText,
      originalPrice: extracted.priceText,
      currency,
      description: (extracted.description || []).slice(0, 3),
      image: extracted.image || '',
      url,
      websiteName,
    });

  } catch (err) {
    console.error('❌ Scrape error:', err.message);
    // Even on unexpected errors, try slug fallback gracefully
    const slugName = extractProductNameFromUrl(url);
    if (slugName) {
      return res.json({
        blocked: true,
        name: slugName,
        searchQuery: slugName,
        price: null,
        priceText: null,
        description: [],
        image: '',
        url,
        websiteName,
        blockerMessage: `⛔ ${websiteName} has blocked access to this page. Showing similar products based on the URL.`,
      });
    }
    res.status(500).json({ error: `Failed to extract product data: ${err.message}` });
  }
});

// ── POST /search ──
app.post('/search', async (req, res) => {
  const { productName } = req.body;
  if (!productName) return res.status(400).json({ error: 'Product name is required' });

  const serpApiKey = process.env.SERPAPI_KEY;

  // Try SerpAPI Google Shopping (India locale for INR prices)
  if (serpApiKey && serpApiKey !== 'your_serpapi_key_here') {
    try {
      console.log(`\n🔍 Searching SerpAPI for: ${productName}`);
      const searchResponse = await axios.get('https://serpapi.com/search', {
        params: {
          engine: 'google_shopping',
          q: productName,
          api_key: serpApiKey,
          gl: 'in',        // India locale
          hl: 'en',
          num: 6,
        },
        timeout: 12000,
      });

      const results = searchResponse.data.shopping_results || [];
      console.log(`📦 SerpAPI returned ${results.length} results`);

      const products = await Promise.all(
        results.slice(0, 3).map(async (item) => {
          const numericPrice = parseNumericPrice(item.price);
          const currency = detectCurrency(item.price);
          const priceINR = await toINR(numericPrice, currency);
          const productUrl = item.link || item.product_link || '#';

          return {
            name: item.title || productName,
            price: priceINR,
            priceText: priceINR ? `₹${priceINR.toLocaleString('en-IN')}` : (item.price || 'N/A'),
            originalPrice: item.price,
            description: [
              item.source ? `Sold by: ${item.source}` : null,
              item.rating ? `Rating: ${item.rating}/5 (${item.reviews || 0} reviews)` : null,
              item.delivery ? `Delivery: ${item.delivery}` : 'Check website for delivery info',
            ].filter(Boolean),
            image: item.thumbnail || '',
            url: productUrl,
            websiteName: item.source || getWebsiteName(productUrl),
          };
        })
      );

      return res.json({ products });
    } catch (err) {
      console.error('SerpAPI error:', err.message);
      // Fall through to fallback
    }
  }

  // Fallback: major Indian retailers
  const retailers = [
    { name: 'Amazon India', domain: 'amazon.in', searchPath: 's?k=' },
    { name: 'Flipkart', domain: 'flipkart.com', searchPath: 'search?q=' },
    { name: 'Myntra', domain: 'myntra.com', searchPath: 'search?rawQuery=' },
  ];

  const products = retailers.map((retailer) => ({
    name: productName,
    price: null,
    priceText: 'Check website',
    description: [
      `Search results from ${retailer.name}`,
      'Click the link to view current pricing in ₹',
      'Prices may vary by seller',
    ],
    image: '',
    url: `https://www.${retailer.domain}/${retailer.searchPath}${encodeURIComponent(productName)}`,
    websiteName: retailer.name,
  }));

  return res.json({ products, fallback: true });
});

app.listen(PORT, () => {
  console.log(`\n🚀 PriceScope AI Server running at http://localhost:${PORT}`);
  console.log(`🤖 Gemini AI: ${process.env.GEMINI_API_KEY ? '✅ Connected' : '❌ No key'}`);
  console.log(`🔍 SerpAPI:   ${process.env.SERPAPI_KEY ? '✅ Connected' : '❌ No key'}`);
  console.log(`📦 Open http://localhost:${PORT} in your browser\n`);
});

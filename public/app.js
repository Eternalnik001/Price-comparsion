/* ============================================================
   PriceScope — App Logic
   ============================================================ */

const API_BASE = 'http://localhost:3000';

let isLoading = false;

// ── DOM refs ──
const productUrlInput = document.getElementById('productUrl');
const compareBtn = document.getElementById('compareBtn');
const loadingSection = document.getElementById('loadingSection');
const errorSection = document.getElementById('errorSection');
const blockedSection = document.getElementById('blockedSection');
const errorMessage = document.getElementById('errorMessage');
const sourceSection = document.getElementById('sourceSection');
const comparisonSection = document.getElementById('comparisonSection');
const comparisonGrid = document.getElementById('comparisonGrid');

const loadStep1 = document.getElementById('loadStep1');
const loadStep2 = document.getElementById('loadStep2');
const loadStep3 = document.getElementById('loadStep3');

// ── Allow Enter key ──
productUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !isLoading) startComparison();
});

// ── Main flow ──
async function startComparison() {
    const url = productUrlInput.value.trim();

    if (!url) {
        shakeInput();
        return;
    }

    if (!isValidUrl(url)) {
        showError('Please enter a valid URL starting with http:// or https://');
        return;
    }

    if (isLoading) return;
    isLoading = true;

    // Reset UI
    hideAll();
    compareBtn.disabled = true;
    show(loadingSection);
    setLoadStep(1);

    try {
        // Step 1: Scrape product
        const scrapeData = await scrapeProduct(url);
        setLoadStep(2);

        if (scrapeData.blocked) {
            // Site blocked — show banner, skip source card, search by slug
            showBlockedBanner(scrapeData);
            const searchData = await searchProducts(scrapeData.searchQuery || scrapeData.name);
            setLoadStep(3);
            await sleep(400);
            renderComparison(searchData.products, null);
            hide(loadingSection);
            show(blockedSection);
            show(comparisonSection);
        } else {
            // Normal flow
            renderSourceProduct(scrapeData);
            const searchData = await searchProducts(scrapeData.searchQuery || scrapeData.name);
            setLoadStep(3);
            await sleep(600);
            renderComparison(searchData.products, scrapeData);
            hide(loadingSection);
            show(sourceSection);
            show(comparisonSection);
        }

        // Smooth scroll to results
        setTimeout(() => {
            const firstResult = document.getElementById('blockedSection').classList.contains('hidden')
                ? sourceSection
                : blockedSection;
            firstResult.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 100);

    } catch (err) {
        hide(loadingSection);
        showError(err.message || 'Something went wrong. Please try again.');
    } finally {
        isLoading = false;
        compareBtn.disabled = false;
    }
}

// ── API calls ──
async function scrapeProduct(url) {
    const res = await fetch(`${API_BASE}/scrape`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to read product page');
    return data;
}

async function searchProducts(productName) {
    const res = await fetch(`${API_BASE}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productName }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to search for products');
    return data;
}

// ── Render: Source Product ──
function renderSourceProduct(product) {
    document.getElementById('sourceName').textContent = product.name;

    // Show INR price; also show original if different currency
    let priceDisplay = product.priceText || 'Price not found';
    if (product.originalPrice && product.originalPrice !== product.priceText) {
        priceDisplay = `${product.priceText} (${product.originalPrice})`;
    }
    document.getElementById('sourcePrice').textContent = priceDisplay;

    const descList = document.getElementById('sourceDesc');
    descList.innerHTML = '';
    const points = product.description && product.description.length > 0
        ? product.description.slice(0, 3)
        : ['Product details not available'];
    points.forEach(pt => {
        const li = document.createElement('li');
        li.textContent = pt;
        descList.appendChild(li);
    });

    // Show website name in source card
    if (product.websiteName) {
        const sourceInfo = document.querySelector('.source-info');
        const existing = sourceInfo.querySelector('.source-website');
        if (existing) existing.remove();
        const siteTag = document.createElement('div');
        siteTag.className = 'source-website';
        siteTag.textContent = `🌐 ${product.websiteName}`;
        sourceInfo.insertBefore(siteTag, sourceInfo.firstChild);
    }

    const imgWrap = document.getElementById('sourceImage');
    imgWrap.innerHTML = '';
    if (product.image) {
        const img = document.createElement('img');
        img.src = product.image;
        img.alt = product.name;
        img.onerror = () => { imgWrap.innerHTML = ''; };
        imgWrap.appendChild(img);
    }
}

// ── Render: Comparison Grid ──
function renderComparison(products, sourceProduct) {
    comparisonGrid.innerHTML = '';

    if (!products || products.length === 0) {
        comparisonGrid.innerHTML = '<p style="color:var(--text-muted);text-align:center;grid-column:1/-1">No comparison results found.</p>';
        return;
    }

    // Determine min/max prices
    const prices = products.map(p => p.price).filter(p => p !== null && p !== undefined && !isNaN(p));
    const minPrice = prices.length > 0 ? Math.min(...prices) : null;
    const maxPrice = prices.length > 0 ? Math.max(...prices) : null;

    products.forEach((product, index) => {
        const isLowest = minPrice !== null && product.price === minPrice && prices.filter(p => p === minPrice).length >= 1;
        const isHighest = maxPrice !== null && product.price === maxPrice && minPrice !== maxPrice;

        const card = buildProductCard(product, isLowest, isHighest, index);
        comparisonGrid.appendChild(card);
    });
}

// ── Build a single product card ──
function buildProductCard(product, isLowest, isHighest, index) {
    const card = document.createElement('div');
    card.className = 'product-card';
    card.style.animationDelay = `${index * 0.12}s`;

    if (isLowest) card.classList.add('price-lowest');
    else if (isHighest) card.classList.add('price-highest');

    // Price badge
    if (isLowest) {
        card.innerHTML += `<span class="price-badge badge-lowest">🟢 Best Price</span>`;
    } else if (isHighest) {
        card.innerHTML += `<span class="price-badge badge-highest">🔴 Highest</span>`;
    }

    // Product image or placeholder
    if (product.image) {
        const img = document.createElement('img');
        img.className = 'card-image';
        img.src = product.image;
        img.alt = product.name;
        img.onerror = () => {
            img.replaceWith(buildImagePlaceholder());
        };
        card.appendChild(img);
    } else {
        card.appendChild(buildImagePlaceholder());
    }

    // Website name tag
    const siteName = product.websiteName || product.retailer || '';
    if (siteName) {
        const siteTag = document.createElement('div');
        siteTag.className = 'card-website';
        siteTag.innerHTML = `<span class="card-website-dot"></span>${siteName}`;
        card.appendChild(siteTag);
    }

    // Product name
    const nameEl = document.createElement('h3');
    nameEl.className = 'card-name';
    nameEl.textContent = product.name;
    card.appendChild(nameEl);

    // Description points
    const descList = document.createElement('ul');
    descList.className = 'card-desc';
    const points = product.description && product.description.length > 0
        ? product.description.slice(0, 3)
        : ['Click the link to view product details'];
    points.forEach(pt => {
        if (!pt) return;
        const li = document.createElement('li');
        li.textContent = pt;
        descList.appendChild(li);
    });
    card.appendChild(descList);

    // Footer: price + link
    const footer = document.createElement('div');
    footer.className = 'card-footer';

    // Price (always in ₹ INR)
    const priceEl = document.createElement('div');
    if (product.price !== null && product.price !== undefined && !isNaN(product.price)) {
        priceEl.className = 'card-price';
        priceEl.textContent = product.priceText || `₹${Number(product.price).toLocaleString('en-IN')}`;
    } else {
        priceEl.className = 'card-price-na';
        priceEl.textContent = product.priceText || 'Check website';
    }
    footer.appendChild(priceEl);

    // Link
    const link = document.createElement('a');
    link.className = 'card-link';
    link.href = product.url || '#';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.innerHTML = `LINK TO WEBSITE <span class="card-link-icon">↗</span>`;
    footer.appendChild(link);

    card.appendChild(footer);

    return card;
}

function buildImagePlaceholder() {
    const div = document.createElement('div');
    div.className = 'card-image-placeholder';
    div.textContent = '🛍️';
    return div;
}

// ── UI Helpers ──
function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function hideAll() {
    hide(loadingSection);
    hide(errorSection);
    hide(blockedSection);
    hide(sourceSection);
    hide(comparisonSection);
}

function showError(msg) {
    hideAll();
    errorMessage.textContent = msg;
    show(errorSection);
}

function showBlockedBanner(data) {
    document.getElementById('blockedMessage').textContent =
        data.blockerMessage || `⛔ ${data.websiteName || 'This website'} has blocked access. Searching for similar products from the URL.`;
    document.getElementById('blockedSearchQuery').textContent = data.searchQuery || data.name;
}

function resetUI() {
    hideAll();
    productUrlInput.value = '';
    productUrlInput.focus();
    comparisonGrid.innerHTML = '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setLoadStep(step) {
    [loadStep1, loadStep2, loadStep3].forEach((el, i) => {
        el.classList.remove('active', 'done');
        if (i + 1 < step) el.classList.add('done');
        else if (i + 1 === step) el.classList.add('active');
    });
}

function shakeInput() {
    const wrapper = document.querySelector('.input-wrapper');
    wrapper.style.animation = 'none';
    wrapper.offsetHeight; // reflow
    wrapper.style.animation = 'shake 0.4s ease';
    setTimeout(() => { wrapper.style.animation = ''; }, 400);
}

function isValidUrl(str) {
    try {
        const url = new URL(str);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch { return false; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Add shake keyframe dynamically
const style = document.createElement('style');
style.textContent = `
  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    20% { transform: translateX(-8px); }
    40% { transform: translateX(8px); }
    60% { transform: translateX(-5px); }
    80% { transform: translateX(5px); }
  }
`;
document.head.appendChild(style);

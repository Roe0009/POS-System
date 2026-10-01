const $ = (selector, root = document) => root.querySelector(selector);
const money = cents => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(cents / 100);
const safe = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const productById = id => data.products.find(p => p.id === Number(id));
const low = p => p.stock <= p.threshold;

// ---- Expiration dates (product.expiry is "YYYY-MM-DD" or "" when not set)
const EXPIRY_SOON_DAYS = 7;
const parseDay = value => { const [y, m, d] = value.split('-').map(Number); return new Date(y, m - 1, d); };
function expiryInfo(p) {
    if (!p || !p.expiry) return null;
    const day = parseDay(p.expiry);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = Math.round((day - today) / 86400000);
    const pretty = day.toLocaleDateString('en-PH', { dateStyle: 'medium' });
    if (days < 0) return { days, pretty, cls: 'out', expired: true, short: 'Expired ' + pretty, note: days === -1 ? 'Expired yesterday' : 'Expired ' + (-days) + ' days ago' };
    if (days === 0) return { days, pretty, cls: 'low', expired: false, short: 'Expires today', note: 'Expires today' };
    if (days <= EXPIRY_SOON_DAYS) { const t = 'Expires in ' + days + (days === 1 ? ' day' : ' days'); return { days, pretty, cls: 'low', expired: false, short: t, note: t }; }
    return { days, pretty, cls: 'ok', expired: false, short: 'Exp. ' + pretty, note: 'Expires in ' + days + ' days' };
}
const isExpired = p => !!expiryInfo(p)?.expired;
const unavailable = p => !p.stock || isExpired(p);
const date = value => new Date(value).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
const initials = name => (name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();

// ---------------------------------------------------------------- Theme
const themeToggles = document.querySelectorAll('#theme-toggle, #landing-theme-toggle, #customer-theme-toggle');
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
let themePref = localStorage.getItem('theme') || 'system';   // 'light' | 'dark' | 'system'
let currentTheme = 'light';
function applyTheme() {
    currentTheme = themePref === 'system' ? (systemDark.matches ? 'dark' : 'light') : themePref;
    document.documentElement.setAttribute('data-theme', currentTheme);
    themeToggles.forEach(btn => btn.textContent = currentTheme === 'dark' ? '☀️' : '🌙');
    document.querySelectorAll('[data-theme-pref]').forEach(el => el.classList.toggle('active', el.dataset.themePref === themePref));
}
function setThemePref(pref) {
    themePref = pref;
    if (pref === 'system') localStorage.removeItem('theme'); else localStorage.setItem('theme', pref);
    applyTheme();
}
systemDark.addEventListener?.('change', () => { if (themePref === 'system') applyTheme(); });
themeToggles.forEach(toggle => toggle.addEventListener('click', () => setThemePref(currentTheme === 'dark' ? 'light' : 'dark')));
applyTheme();

// ---------------------------------------------------------------- API helper
async function api(path, options = {}) {
    let response;
    try { response = await fetch(path, options); } catch { throw new Error('Cannot connect to the Java server. Check that it is running.'); }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Something went wrong.');
    return body;
}
function formBody(values) { return new URLSearchParams(values).toString(); }
const postForm = (path, values) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: formBody(values) });

// ---------------------------------------------------------------- State
const data = { products: [], sales: [], myOrders: [], wishlist: [], addresses: [], config: { deliveryFee: 3900, freeDeliveryOver: 50000 } };
let me = null; // {id, username, name, role}
let view = 'dashboard', category = 'All', posSearch = '', inventorySearch = '', salesSearch = '', ordersSearch = '';
let justAdded = null;
let sortBy = 'featured', fulfillment = 'pickup', payMethod = 'cod', addressChoice = '', orderNote = '';
let settingsTab = 'overview', account = null;
const verifyDemo = { email: null, phone: null };
let cart = new Map(), cashValue = '', walkInName = '', currentReceipt = null, toastTimer;

function isStaff() { return me && (me.role === 'employee' || me.role === 'admin'); }

// ---------------------------------------------------------------- Page switching
function showLanding() {
    $('#landing-page').style.display = 'flex';
    $('#auth-page').style.display = 'none';
    $('#app-container').style.display = 'none';
}
function showAuth() {
    $('#landing-page').style.display = 'none';
    $('#auth-page').style.display = 'flex';
    $('#app-container').style.display = 'none';
}
function showApp() {
    $('#landing-page').style.display = 'none';
    $('#auth-page').style.display = 'none';
    $('#app-container').style.display = 'block';
}

let authRole = 'customer', authSubtab = 'login';
window.goToAuth = (role, subtab) => {
    authRole = role || 'customer'; authSubtab = subtab || 'login';
    showAuth();
    renderAuthTabs();
};
function renderAuthTabs() {
    document.querySelectorAll('.role-tab').forEach(t => { const on = t.dataset.role === authRole; t.classList.toggle('active', on); t.setAttribute('aria-selected', on); });
    const tabs = document.querySelector('.role-tabs'); if (tabs) tabs.dataset.active = authRole;
    $('#customer-auth').hidden = authRole !== 'customer';
    $('#employee-auth').hidden = authRole !== 'employee';
    if (authRole === 'customer') setSubtab(authSubtab);
    $('#auth-error').classList.remove('show');
}
window.setSubtab = (name) => {
    authSubtab = name;
    $('#auth-error').classList.remove('show');
    $('#customer-login-form').hidden = name !== 'login';
    $('#customer-signup-form').hidden = name !== 'signup';
};
document.querySelectorAll('.role-tab').forEach(tab => tab.addEventListener('click', () => { authRole = tab.dataset.role; renderAuthTabs(); }));

function authFail(message) {
    const el = $('#auth-error');
    el.textContent = message;
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show'); // restart the shake
}

// ---------------------------------------------------------------- Login loader (sliding store doors)
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LOADER_MSGS = {
    customer: ['Stocking the shelves…', 'Brewing fresh coffee…', 'Warming up the hot foods…', 'Chilling the drinks…'],
    guest:    ['Stocking the shelves…', 'Grabbing you a basket…', 'Warming up the hot foods…', 'Chilling the drinks…'],
    staff:    ['Unlocking the back office…', 'Counting the register…', 'Checking stock levels…', 'Lining up the day’s orders…']
};
function playLoginLoader(user) {
    const el = $('#login-loader');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const minMs = reduced ? 900 : 2800;
    const kind = user.guest ? 'guest' : (user.role === 'employee' || user.role === 'admin') ? 'staff' : 'customer';
    const msgs = LOADER_MSGS[kind], status = $('#ll-status');
    el.className = 'll'; el.style.setProperty('--ll-dur', (minMs - 400) + 'ms');
    $('#ll-name').textContent = (user.name || 'friend').trim().split(/\s+/)[0];
    $('#ll-role').textContent = kind === 'staff' ? (user.role === 'admin' ? 'Opening the admin workspace…' : 'Opening your register…')
        : kind === 'guest' ? 'Browsing as a guest' : 'Getting your store ready…';
    status.textContent = msgs[0]; status.classList.remove('swap');
    el.hidden = false;                       // (re)showing the element restarts every CSS animation

    let i = 0;
    const timer = setInterval(() => {
        i = Math.min(i + 1, msgs.length - 1);
        status.classList.add('swap');
        setTimeout(() => { status.textContent = msgs[i]; status.classList.remove('swap'); }, 180);
    }, Math.round(minMs / msgs.length));

    const hide = () => { clearInterval(timer); el.hidden = true; el.className = 'll'; };
    return {
        minTime: sleep(minMs),
        abort: hide,
        async finish(revealApp) {
            clearInterval(timer);
            status.textContent = 'You’re all set ✓';
            el.classList.add('ready');
            await sleep(reduced ? 150 : 380);
            el.classList.add('closing');
            await sleep(reduced ? 100 : 260);
            revealApp();                     // swap the page underneath just as the doors start to part
            el.classList.add('open');
            await sleep(reduced ? 250 : 900);
            el.classList.add('gone');
            await sleep(260);
            hide();
        }
    };
}

async function afterLogin(user) {
    me = user; loadCart(); cashValue = ''; walkInName = ''; account = null; settingsTab = 'overview';
    const loader = playLoginLoader(user);
    try {
        buildNav();
        switchView(isStaff() ? 'dashboard' : 'pos');
        await Promise.all([refresh(), loader.minTime]);   // load real data while the animation plays
    } catch (err) { showApp(); loader.abort(); throw err; }
    await loader.finish(showApp);
    notify(`Welcome, ${user.name.split(' ')[0]}!`);
}

document.addEventListener('submit', async e => {
    if (e.target.id === 'customer-login-form') {
        e.preventDefault();
        const values = Object.fromEntries(new FormData(e.target));
        try { const user = await postForm('/api/auth/login', values); await afterLogin(user); }
        catch (err) { authFail(err.message); }
    } else if (e.target.id === 'customer-signup-form') {
        e.preventDefault();
        const values = Object.fromEntries(new FormData(e.target));
        try { const user = await postForm('/api/auth/register', values); await afterLogin(user); }
        catch (err) { authFail(err.message); }
    } else if (e.target.id === 'employee-login-form') {
        e.preventDefault();
        const values = Object.fromEntries(new FormData(e.target));
        try { const user = await postForm('/api/auth/login', values); await afterLogin(user); }
        catch (err) { authFail(err.message); }
    }
});

window.guestLogin = async () => {
    try { const user = await api('/api/auth/guest', { method: 'POST' }); await afterLogin(user); }
    catch (err) { authFail(err.message); }
};

// Logging out asks first (centered Yes / No popup).
let lcReturnFocus = null;
function closeLogoutConfirm() {
    const box = $('#logout-confirm'); if (box.hidden) return;
    box.classList.add('leaving');
    setTimeout(() => { box.hidden = true; box.classList.remove('leaving'); lcReturnFocus?.focus?.(); }, 180);
}
window.logout = () => {
    const box = $('#logout-confirm');
    lcReturnFocus = document.activeElement;
    $('#lc-text').textContent = me && me.guest
        ? 'Are you sure you want to log out? Your guest session and cart will be cleared.'
        : 'Are you sure you want to log out?';
    box.hidden = false; box.classList.remove('leaving');
    $('#lc-no').focus();
};
async function performLogout() {
    const wasCustomer = me && me.role === 'customer';
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    me = null; cart.clear(); account = null;
    showLanding();
    notify(wasCustomer ? 'Thanks for shopping with 7/11 Online Convenience Store!' : 'Successfully logged out!');
}
$('#lc-no').addEventListener('click', closeLogoutConfirm);
$('#lc-yes').addEventListener('click', async () => { closeLogoutConfirm(); lcReturnFocus = null; await performLogout(); });
$('#logout-confirm').addEventListener('click', e => { if (e.target.id === 'logout-confirm') closeLogoutConfirm(); });
document.addEventListener('keydown', e => {
    const box = $('#logout-confirm'); if (box.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closeLogoutConfirm(); }
    else if (e.key === 'Tab') {                       // keep focus inside the dialog
        const btns = [$('#lc-no'), $('#lc-yes')], i = btns.indexOf(document.activeElement);
        e.preventDefault(); btns[(i + (e.shiftKey ? -1 : 1) + 2) % 2].focus();
    }
});

// ---------------------------------------------------------------- Sidebar nav (role-aware)
function buildNav() {
    const nav = $('#main-nav');
    $('.app').classList.toggle('top-layout', !isStaff());
    if (isStaff()) {
        nav.innerHTML = `
            <button class="nav" data-view="dashboard"><span class="nav-icon">▦</span> Dashboard</button>
            <button class="nav" data-view="pos"><span class="nav-icon">🛒</span> POS terminal</button>
            <button class="nav" data-view="inventory"><span class="nav-icon">▤</span> Inventory <span id="nav-alert-count" class="nav-count" hidden></span></button>
            <button class="nav" data-view="sales"><span class="nav-icon">◷</span> Sales &amp; orders <span id="nav-order-count" class="nav-count" hidden></span></button>`;
        $('#workspace-label').textContent = 'WORKSPACE';
        $('#brand-subtitle').textContent = 'STAFF PORTAL';
    } else {
        nav.innerHTML = `
            <button class="nav" data-view="pos"><span class="nav-icon">🏠</span> Home / Shop</button>
            <button class="nav" data-view="wishlist"><span class="nav-icon">♥</span> Wishlist <span id="nav-wish-count" class="nav-count" hidden></span></button>
            <button class="nav" data-view="orders"><span class="nav-icon">🧾</span> My orders</button>`;
        $('#workspace-label').textContent = 'SHOPPING';
        $('#brand-subtitle').textContent = 'CONVENIENCE STORE';
    }
    paintIdentity();
}

const avatarUrl = u => u && u.avatarVer ? `/api/account/avatar?v=${u.avatarVer}` : '';
function paintAvatar(el, u) {
    if (!el || !u) return;
    const url = avatarUrl(u);
    el.style.backgroundImage = url ? `url("${url}")` : '';
    el.classList.toggle('has-img', !!url);
    el.textContent = url ? '' : initials(u.name);
}
const avatarHtml = (u, cls = '') => { const url = avatarUrl(u); return `<span class="avatar ${cls} ${url ? 'has-img' : ''}" ${url ? `style="background-image:url('${url}')"` : ''}>${url ? '' : safe(initials(u.name))}</span>`; };
function paintIdentity() {
    if (!me) return;
    paintAvatar($('#user-avatar'), me); paintAvatar($('#top-avatar'), me);
    $('#user-role-label').innerHTML = `${safe(me.name)} <span class="role-badge ${me.role}">${me.role}</span>`;
    $('#user-workspace-label').textContent = isStaff() ? 'Store team member' : '@' + me.username;
}

// ---------------------------------------------------------------- Data refresh
async function refresh() {
    const next = await api('/api/state');
    data.products = next.products;
    data.sales = next.sales || [];
    data.myOrders = next.myOrders || [];
    data.wishlist = next.wishlist || [];
    data.addresses = next.addresses || [];
    if (next.config) data.config = next.config;
    if (next.me) { me = next.me; paintIdentity(); }
    for (const [id, qty] of cart) {
        const p = productById(id);
        if (!p || unavailable(p)) cart.delete(id);
        else if (qty > p.stock) cart.set(id, p.stock);
    }
    render();
}

function notify(message, isError = false, duration = 4000) {
    const el = $('#toast');
    el.textContent = message;
    el.className = isError ? 'show error' : 'show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.className = '', duration);
}

function switchView(name) {
    view = name;
    document.querySelectorAll('.nav').forEach(n => n.classList.toggle('active', n.dataset.view === name));
    document.querySelectorAll('.view').forEach(n => n.hidden = n.id !== name + '-view');
    $('.sidebar').classList.remove('open');
    render();
    if (name === 'settings') openSettings();
}

const renderIcon = (icon) => icon && icon.startsWith('http')
    ? `<img src="${safe(icon)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'📦',className:'img-fallback'}))">`
    : safe(icon);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function render() {
    if (!me) return;
    const headings = {
        dashboard: ['Dashboard', "Here's what's happening at your store today.", 'Workspace / Dashboard'],
        pos: isStaff()
            ? ['POS terminal', 'Build an order and check out in seconds.', 'Workspace / POS terminal']
            : ['Home', 'Browse products, add them to your cart, and check out.', 'Shopping / Home'],
        inventory: ['Inventory', 'Keep your products and stock up to date.', 'Workspace / Inventory'],
        sales: ['Sales history', 'Review transactions and reprint receipts.', 'Workspace / Sales history'],
        orders: ['My orders', 'Track your orders, cancel pending ones and view receipts.', 'Shopping / My orders'],
        wishlist: ['Wishlist', 'Items you saved for later.', 'Shopping / Wishlist'],
        settings: ['Settings', me && me.guest ? 'Choose how the store looks on this device.' : 'Manage your profile, security and preferences.', 'Account / Settings']
    };
    const isWelcome = view === 'dashboard' || (view === 'pos' && !isStaff());   // staff Dashboard + customer Home
    $('#page-title').textContent = isWelcome ? `Welcome, ${me.name}!` : headings[view][0];
    $('#page-title').classList.toggle('welcome-title', isWelcome);
    $('#page-subtitle').textContent = headings[view][1];
    $('#breadcrumb').textContent = headings[view][2];
    $('#page-eyebrow').textContent = view === 'settings' ? 'ACCOUNT' : isStaff() ? 'STORE MANAGEMENT' : view === 'pos' ? 'HOME' : 'WELCOME';

    if (isStaff()) {
        const alerts = data.products.filter(low);
        const alertCount = $('#nav-alert-count');
        if (alertCount) { alertCount.hidden = alerts.length === 0; alertCount.textContent = alerts.length; }
        const oc = $('#nav-order-count'), open = data.sales.filter(isActive).length;
        if (oc) { oc.hidden = !open; oc.textContent = open; }
    } else {
        const wc = $('#nav-wish-count');
        if (wc) { wc.hidden = !data.wishlist.length; wc.textContent = data.wishlist.length; }
    }

    $('#page-action').innerHTML = view === 'pos' ? '' : view === 'sales'
        ? '<button class="btn btn-primary" data-action="go-pos">＋ New sale</button>'
        : view === 'inventory' ? '<button class="btn btn-primary" data-action="new-product">＋ Add product</button>' : '';

    if (isStaff()) renderDashboard();
    renderPOS();
    if (isStaff()) { renderInventory(); renderSales(); } else { renderOrders(); renderWishlist(); }
    updateSidebarWidget();
}

// ---------------------------------------------------------------- Dashboard (employee)
function renderDashboard() {
    const alerts = data.products.filter(low).sort((a, b) => a.stock - b.stock);
    const expiring = data.products.filter(p => p.stock > 0 && expiryInfo(p) && expiryInfo(p).cls !== 'ok').sort((a, b) => a.expiry.localeCompare(b.expiry));
    const today = new Date().toDateString();
    const todaySales = validSales().filter(s => new Date(s.time).toDateString() === today);
    const revenue = todaySales.reduce((sum, s) => sum + s.total, 0);

    const qtyByProduct = new Map();
    for (const s of validSales()) for (const l of s.lines) qtyByProduct.set(l.name, (qtyByProduct.get(l.name) || 0) + l.quantity);
    const topSellers = [...qtyByProduct.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    const maxQty = Math.max(1, ...topSellers.map(t => t[1]));

    $('#dashboard-view').innerHTML = `
        <div class="hero">
            <div class="hero-copy">
                <div class="eyebrow">TODAY'S OVERVIEW ✦</div>
                <h2>Your store is looking good.</h2>
                <p>Take a quick look at your inventory, manage products, and serve your next customer.</p>
            </div>
            <button class="btn btn-amber" data-action="go-pos">Open POS terminal →</button>
        </div>

        <div class="metric-grid">
            <div class="card metric"><span class="metric-icon">₱</span><div class="metric-label">Today's revenue</div><div class="metric-value">${money(revenue)}</div><div class="metric-note">From completed sales today</div></div>
            <div class="card metric"><span class="metric-icon">▦</span><div class="metric-label">Transactions today</div><div class="metric-value">${todaySales.length}</div><div class="metric-note">Orders completed</div></div>
            <div class="card metric"><span class="metric-icon">▣</span><div class="metric-label">Active orders</div><div class="metric-value">${data.sales.filter(isActive).length}</div><div class="metric-note">Pending, preparing or on the way</div></div>
            <div class="card metric"><span class="metric-icon">!</span><div class="metric-label">Stock alerts</div><div class="metric-value">${alerts.length}</div><div class="metric-note">Low or out of stock</div></div>
        </div>

        <div class="dashboard-panels">
            <div class="card panel">
                <div class="panel-heading"><h2>Top sellers</h2><button class="link-btn" data-action="go-sales">View all sales →</button></div>
                ${topSellers.length ? `<div class="bar-chart">${topSellers.map(([name, qty]) => `
                    <div class="bar-col">
                        <span>${qty}</span>
                        <div class="bar-fill" style="height:${Math.max(6, Math.round(qty / maxQty * 100))}%"></div>
                        <small>${safe(name)}</small>
                    </div>`).join('')}</div>` : '<div class="empty-state">No sales yet. Your first order will appear here.</div>'}
            </div>
            <div class="card panel">
                <div class="panel-heading"><h2>Stock alerts</h2><button class="link-btn" data-action="go-inventory">View inventory →</button></div>
                ${alerts.length ? alerts.slice(0, 5).map(p => `
                    <div class="alert-item">
                        <div class="item-icon">${renderIcon(p.icon)}</div>
                        <div><strong>${safe(p.name)}</strong><small>${safe(p.sku)} · Alert at ${p.threshold}</small></div>
                        <div class="item-right"><span class="pill ${p.stock ? 'warn' : 'empty'}">${p.stock ? p.stock + ' left' : 'Out of stock'}</span></div>
                    </div>`).join('') : '<div class="empty-state">✦ All products have healthy stock levels.</div>'}
            </div>
        </div>
        <div class="card panel" style="margin-top:18px;">
            <div class="panel-heading"><h2>Expiry alerts</h2><button class="link-btn" data-action="go-inventory">Manage in inventory →</button></div>
            ${expiring.length ? expiring.slice(0, 6).map(p => `
                <div class="alert-item">
                    <div class="item-icon">${renderIcon(p.icon)}</div>
                    <div><strong>${safe(p.name)}</strong><small>${safe(p.sku)} · ${safe(expiryInfo(p).pretty)} · ${p.stock} in stock</small></div>
                    <div class="item-right"><span class="pill ${expiryInfo(p).cls === 'out' ? 'empty' : 'warn'}">${safe(expiryInfo(p).short)}</span><button class="link-btn" data-action="expiry" data-id="${p.id}">Edit date</button></div>
                </div>`).join('') : '<div class="empty-state">✦ No products are expired or expiring within ' + EXPIRY_SOON_DAYS + ' days.</div>'}
        </div>
        <div class="card panel" style="margin-top:18px;">
            <div class="panel-heading"><h2>Recent sales</h2><button class="link-btn" data-action="go-sales">View all sales →</button></div>
            ${data.sales.length ? data.sales.slice(0, 5).map(s => `
                <div class="recent-item">
                    <div class="item-icon">✓</div>
                    <div><strong>Order #${s.id.toString().padStart(4, '0')} · ${safe(s.buyerName)}</strong><small>${date(s.time)} · ${plural(s.lines.reduce((n, l) => n + l.quantity, 0), 'item')} ${s.cashierName ? '· Served by ' + safe(s.cashierName) : ''}</small></div>
                    <div class="item-right"><strong>${money(s.total)}</strong>${statusPill(s.status)}</div>
                </div>`).join('') : '<div class="empty-state">No sales yet. Your first order will appear here.</div>'}
        </div>`;
}

// ---------------------------------------------------------------- Shop / POS (shared)
function renderPOS() {
    if (!isStaff() && !data.addresses.some(a => String(a.id) === String(addressChoice))) addressChoice = data.addresses[0]?.id ?? '';
    saveCart();
    const categories = ['All', ...new Set(data.products.map(p => p.category))];
    if (!categories.includes(category)) category = 'All';

    const visible = data.products.filter(p => (category === 'All' || p.category === category)
        && (p.name + ' ' + p.sku + ' ' + p.category).toLowerCase().includes(posSearch.toLowerCase()));
    if (sortBy === 'price-asc') visible.sort((a, b) => a.price - b.price);
    else if (sortBy === 'price-desc') visible.sort((a, b) => b.price - a.price);
    else if (sortBy === 'name') visible.sort((a, b) => a.name.localeCompare(b.name));

    $('#pos-view').innerHTML = `
        <div class="pos-layout">
            <div class="card catalog">
                <div class="catalog-tools">
                    <label class="search"><span>⌕</span><input id="pos-search" type="search" placeholder="Search products or SKU..." value="${safe(posSearch)}" aria-label="Search products"></label>
                    <select class="input sort-select" id="sort-by" aria-label="Sort products">
                        <option value="featured" ${sortBy === 'featured' ? 'selected' : ''}>Sort: Featured</option>
                        <option value="price-asc" ${sortBy === 'price-asc' ? 'selected' : ''}>Price: low to high</option>
                        <option value="price-desc" ${sortBy === 'price-desc' ? 'selected' : ''}>Price: high to low</option>
                        <option value="name" ${sortBy === 'name' ? 'selected' : ''}>Name: A to Z</option>
                    </select>
                </div>
                <div class="category-row">
                    ${categories.map(c => `<button class="chip ${category === c ? 'active' : ''}" data-category="${safe(c)}">${safe(c)}</button>`).join('')}
                </div>
                <div class="catalog-meta"><strong>${isStaff() ? 'Discover products' : 'Shop our catalog'}</strong><span>${visible.length} items available</span></div>
                <div class="product-grid">
                    ${visible.map(productCardHtml).join('') || '<div class="empty-state">No products match your search.</div>'}
                </div>
            </div>

            <div class="card cart">
                <div class="cart-top"><h2>Current order</h2><span class="cart-count">${plural([...cart.values()].reduce((n, q) => n + q, 0), 'item')}</span></div>
                ${isStaff() ? `<div class="auth-field" style="margin:14px 0 0;"><label class="field-label">Customer name (optional)</label><input class="input" id="walkin-name" placeholder="Walk-in customer" value="${safe(walkInName)}"></div>` : ''}
                <div class="cart-items">
                    ${[...cart].filter(([id]) => productById(id)).map(([id, qty]) => {
                        const p = productById(id);
                        return `
                            <div class="cart-line ${justAdded === id ? 'pop' : ''}">
                                <div class="item-icon">${renderIcon(p.icon)}</div>
                                <div class="cart-item-info">
                                    <strong>${safe(p.name)}</strong><small>${money(p.price)} each</small>
                                    <div class="qty-tools">
                                        <button data-action="decrease" data-id="${id}" aria-label="Decrease quantity">−</button>${qty}
                                        <button data-action="increase" data-id="${id}" aria-label="Increase quantity" ${qty >= p.stock ? 'disabled' : ''}>+</button>
                                    </div>
                                </div>
                                <div class="cart-price">${money(qty * p.price)}<button data-action="remove-cart" data-id="${id}" aria-label="Remove item">×</button></div>
                            </div>`;
                    }).join('') || '<div class="empty-state">Your cart is empty.<br>Add products to get started.</div>'}
                </div>
                <div class="cart-summary">
                    <div class="summary-line"><span>Subtotal</span><strong>${money(cartTotal())}</strong></div>
                    ${isStaff() ? '' : `<div class="summary-line"><span>Delivery fee</span><strong>${fulfillment === 'delivery' ? (feeNow() ? money(feeNow()) : 'FREE') : '—'}</strong></div>`}
                    <div class="summary-line summary-total"><span>Total due</span><strong>${money(cartTotal() + feeNow())}</strong></div>
                </div>
                ${isStaff() ? `
                <label class="field-label" for="cash">Payment amount</label>
                <div class="cash-input cash-row">
                    <span>₱</span><input class="input" id="cash" type="number" min="0" step=".01" placeholder="0.00" value="${safe(cashValue)}">
                </div>
                <div class="change-preview">
                    <span>Change to give</span><strong id="change-amount">${money(Math.max(0, Math.round((Number(cashValue) || 0) * 100) - cartTotal()))}</strong>
                </div>
                <button class="btn btn-primary btn-wide" data-action="checkout" ${cart.size ? '' : 'disabled'}>Complete payment →</button>` : checkoutOptionsHtml()}
                <p class="cart-note">Prices shown in Philippine pesos</p>
            </div>
        </div>`;
}

function cartTotal() { return [...cart].reduce((sum, [id, qty]) => { const p = productById(id); return p ? sum + p.price * qty : sum; }, 0); }

// ---------------------------------------------------------------- Inventory (employee)
function renderInventory() {
    const visible = data.products.filter(p => (p.name + ' ' + p.sku + ' ' + p.category).toLowerCase().includes(inventorySearch.toLowerCase()));
    $('#inventory-view').innerHTML = `
        <div class="inventory-toolbar">
            <label class="search"><span>⌕</span><input id="inventory-search" type="search" placeholder="Search name, SKU or category..." value="${safe(inventorySearch)}"></label>
            <span class="pill pill-lg">${data.products.length} products</span>
        </div>
        <div class="card inventory-card">
            <table class="data-table">
                <thead><tr><th>Product</th><th>SKU</th><th>Category</th><th>Price</th><th>Stock</th><th>Expires</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>
                    ${visible.map(p => `
                        <tr>
                            <td><div class="table-product clickable" data-action="view-product" data-id="${p.id}" title="View details"><span class="item-icon">${renderIcon(p.icon)}</span><strong>${safe(p.name)}</strong></div></td>
                            <td class="table-muted">${safe(p.sku)}</td>
                            <td>${safe(p.category)}</td>
                            <td><strong>${money(p.price)}</strong></td>
                            <td><strong>${p.stock}</strong></td>
                            <td>${expiryInfo(p) ? `<span class="pill ${{ out: 'empty', low: 'warn', ok: '' }[expiryInfo(p).cls]}" title="${safe(expiryInfo(p).note)}">${safe(expiryInfo(p).cls === 'ok' ? expiryInfo(p).pretty : expiryInfo(p).short)}</span>` : '<span class="table-muted">No date</span>'}</td>
                            <td><span class="pill ${low(p) ? p.stock ? 'warn' : 'empty' : ''}">${!p.stock ? 'Out of stock' : low(p) ? 'Low stock' : 'In stock'}</span></td>
                            <td>
                                <div class="table-actions">
                                    <button data-action="stock" data-id="${p.id}">± Stock</button>
                                    <button data-action="expiry" data-id="${p.id}">📅 Expiry</button>
                                    <button data-action="edit" data-id="${p.id}">Edit</button>
                                    <button class="danger" data-action="delete" data-id="${p.id}">Delete</button>
                                </div>
                            </td>
                        </tr>`).join('') || '<tr><td colspan="8" class="empty-state">No matching products.</td></tr>'}
                </tbody>
            </table>
            <div class="table-footer">Showing ${visible.length} of ${data.products.length} products · Low stock alerts use each product's threshold</div>
        </div>`;
}

// ---------------------------------------------------------------- Sales history (employee)
function renderSales() {
    const visible = data.sales.filter(s => ('' + s.id + ' ' + s.buyerName + ' ' + s.lines.map(l => l.name).join(' ')).toLowerCase().includes(salesSearch.toLowerCase()));
    const statusCell = s => {
        if (s.fulfillment === 'in-store' || s.status === 'completed' || s.status === 'cancelled') return statusPill(s.status);
        const opts = ['pending', 'preparing', s.fulfillment === 'delivery' ? 'out_for_delivery' : 'ready', 'completed', 'cancelled'];
        return `<select class="status-select" data-order="${s.id}" aria-label="Order status">${opts.map(o => `<option value="${o}" ${o === s.status ? 'selected' : ''}>${STATUS[o][0]}</option>`).join('')}</select>`;
    };
    $('#sales-view').innerHTML = `
        <div class="sales-toolbar">
            <label class="search"><span>⌕</span><input id="sales-search" type="search" placeholder="Search order #, customer or product..." value="${safe(salesSearch)}"></label>
            <span class="pill pill-lg">${plural(data.sales.length, 'transaction')}</span>
        </div>
        <div class="card sales-card">
            <table class="data-table">
                <thead><tr><th>Order</th><th>Customer</th><th>Date &amp; time</th><th>Items</th><th>Total</th><th>Status</th><th>Receipt</th></tr></thead>
                <tbody>
                    ${visible.map(s => `
                        <tr>
                            <td><strong>#${s.id.toString().padStart(4, '0')}</strong></td>
                            <td>${safe(s.buyerName)}<br><small class="table-muted">${s.fulfillment === 'in-store' ? 'Served by ' + safe(s.cashierName || 'staff') : (s.fulfillment === 'delivery' ? '🛵 Delivery' : '🏪 Pickup') + ' · ' + safe(PAY_LABEL[s.payment] || s.payment)}</small></td>
                            <td class="table-muted">${date(s.time)}</td>
                            <td>${plural(s.lines.reduce((sum, l) => sum + l.quantity, 0), 'item')}</td>
                            <td><strong>${money(s.total)}</strong></td>
                            <td>${statusCell(s)}</td>
                            <td><button class="btn btn-sm" data-action="receipt" data-id="${s.id}">View receipt</button></td>
                        </tr>`).join('') || '<tr><td colspan="7" class="empty-state">No sales found. Complete an order to see it here.</td></tr>'}
                </tbody>
            </table>
            <div class="table-footer">Online orders start as Pending — update their status here as you prepare and hand them over. Cancelling returns the items to stock.</div>
        </div>`;
}

// ---------------------------------------------------------------- My orders (customer)
function renderOrders() {
    const visible = data.myOrders.filter(s => ('' + s.id + ' ' + s.lines.map(l => l.name).join(' ')).toLowerCase().includes(ordersSearch.toLowerCase()));
    $('#orders-view').innerHTML = `
        <div class="sales-toolbar">
            <label class="search"><span>⌕</span><input id="orders-search" type="search" placeholder="Search order # or product..." value="${safe(ordersSearch)}"></label>
            <span class="pill pill-lg">${plural(data.myOrders.length, 'order')}</span>
        </div>
        <div class="card sales-card">
            <table class="data-table">
                <thead><tr><th>Order</th><th>Date &amp; time</th><th>Items</th><th>Total</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>
                    ${visible.map(s => `
                        <tr>
                            <td><strong>#${s.id.toString().padStart(4, '0')}</strong><br><small class="table-muted">${s.fulfillment === 'delivery' ? '🛵 Delivery' : '🏪 Pickup'}</small></td>
                            <td class="table-muted">${date(s.time)}</td>
                            <td>${plural(s.lines.reduce((sum, l) => sum + l.quantity, 0), 'item')}</td>
                            <td><strong>${money(s.total)}</strong></td>
                            <td>${statusPill(s.status)}</td>
                            <td><div class="table-actions">
                                <button data-action="receipt" data-id="${s.id}">Receipt</button>
                                <button data-action="reorder" data-id="${s.id}">Reorder</button>
                                ${s.status === 'pending' ? `<button class="danger" data-action="cancel-order" data-id="${s.id}">Cancel</button>` : ''}
                            </div></td>
                        </tr>`).join('') || '<tr><td colspan="6" class="empty-state">You have not placed any orders yet.</td></tr>'}
                </tbody>
            </table>
            <div class="table-footer">Orders can be cancelled while they are still Pending. After that, please contact the store.</div>
        </div>`;
}

// ---------------------------------------------------------------- Sidebar smart widget
function updateSidebarWidget() {
    const promo = $('#sidebar-promo');
    if (!promo || promo.style.display === 'none') return;
    const iconEl = $('#sidebar-promo-icon'), titleEl = $('#sidebar-promo-title'), textEl = $('#sidebar-promo-text');

    if (isStaff()) {
        const alerts = data.products.filter(low);
        const today = new Date().toDateString();
        const todaySales = data.sales.filter(s => new Date(s.time).toDateString() === today);
        const revenue = todaySales.reduce((sum, s) => sum + s.total, 0);
        if (alerts.length > 0) {
            iconEl.textContent = '⚠️'; titleEl.textContent = 'Action required';
            textEl.textContent = `${alerts.length} item(s) are critically low on stock. Please review inventory.`;
            promo.style.borderBottomColor = 'var(--red)';
        } else if (todaySales.length > 0) {
            iconEl.textContent = '📈'; titleEl.textContent = 'Sales milestone';
            textEl.textContent = `Great job! You've made ${todaySales.length} sales today totaling ${money(revenue)}.`;
            promo.style.borderBottomColor = 'var(--green)';
        } else {
            iconEl.textContent = '✦'; titleEl.textContent = 'System ready';
            textEl.textContent = 'Store systems are online. Ready for your first sale of the day.';
            promo.style.borderBottomColor = 'var(--amber)';
        }
    } else {
        iconEl.textContent = '🛍️'; titleEl.textContent = 'Happy shopping';
        textEl.textContent = data.myOrders.length ? `You've placed ${data.myOrders.length} order(s) with us. Thank you!` : 'Add a few items to your cart to get started.';
        promo.style.borderBottomColor = 'var(--primary)';
    }
}
window.dismissSidebarWidget = () => { $('#sidebar-promo').style.display = 'none'; };

// ---------------------------------------------------------------- Modals
function closeModal() { $('#modal-root').innerHTML = ''; }
function openModal(html, cls = '') {
    $('#modal-root').innerHTML = `<div class="modal-backdrop"><div class="modal ${cls}" role="dialog" aria-modal="true">${html}</div></div>`;
    $('#modal-root .modal-backdrop').addEventListener('click', e => { if (e.target.classList.contains('modal-backdrop')) closeModal(); });
    $('#modal-root input')?.focus();
}

async function saveExpiry(id, value) {
    try {
        await postForm('/api/products/' + id + '/expiry', { expiry: value });
        await refresh();
        notify(value ? 'Expiration date saved.' : 'Expiration date removed.');
        productDetailModal(productById(id));
    } catch (err) { notify(err.message, true); }
}

function productModal(p = null) {
    openModal(`
        <h2>${p ? 'Edit product' : 'Add a new product'}</h2>
        <p class="modal-sub">${p ? 'Update the product details below. Use ± Stock to change inventory.' : 'Fill in the details to add it to your catalog.'}</p>
        <form id="product-form" data-id="${p?.id || ''}">
            <div class="form-grid">
                <div class="full"><label class="field-label">Product name</label><input class="input" name="name" required minlength="2" maxlength="80" value="${safe(p?.name || '')}" placeholder="e.g. Classic Cheeseburger"></div>
                <div><label class="field-label">SKU / code</label><input class="input" name="sku" required minlength="2" maxlength="40" value="${safe(p?.sku || '')}" placeholder="SF-011"></div>
                <div><label class="field-label">Category</label><input class="input" name="category" required minlength="2" maxlength="40" value="${safe(p?.category || '')}" placeholder="Snacks"></div>
                <div><label class="field-label">Price (₱)</label><input class="input" name="price" type="number" required min=".01" max="1000000" step=".01" value="${p ? (p.price / 100).toFixed(2) : ''}" placeholder="0.00"></div>
                <div><label class="field-label">Icon (emoji or URL)</label><input class="input" name="icon" maxlength="500" value="${safe(p?.icon || '📦')}" placeholder="📦 or image URL"></div>
                <div class="full"><label class="field-label">Description</label><textarea class="input" name="description" rows="3" maxlength="600" placeholder="Tell customers what makes this product great...">${safe(p?.description || '')}</textarea></div>
                ${p ? '' : `<div><label class="field-label">Starting stock</label><input class="input" name="stock" type="number" required min="0" max="1000000" value="0"></div>`}
                <div><label class="field-label">Low-stock alert at</label><input class="input" name="threshold" type="number" required min="0" max="1000000" value="${p?.threshold ?? 5}"></div>
                <div><label class="field-label">Expiration date <small class="table-muted">(optional)</small></label><input class="input" name="expiry" type="date" min="2000-01-01" max="2100-12-31" value="${safe(p?.expiry || '')}"></div>
            </div>
            <div class="modal-actions"><button type="button" class="btn" data-action="close">Cancel</button><button class="btn btn-primary" type="submit">${p ? 'Save changes' : 'Add product'}</button></div>
        </form>`);
}

let detailQty = 1;
const stockState = (p) => isExpired(p) ? { cls: 'out', label: 'Expired' } : p.stock <= 0 ? { cls: 'out', label: 'Sold out' } : p.stock <= p.threshold ? { cls: 'low', label: 'Only ' + p.stock + ' left' } : { cls: 'ok', label: 'In stock' };

function productDetailModal(p, editing = false) {
    if (!p) return;
    if (!editing) detailQty = 1;
    const st = stockState(p), staff = isStaff(), exp = expiryInfo(p);
    const desc = (p.description || '').trim();
    const descBlock = staff && editing === true
        ? `<form id="desc-form" data-id="${p.id}">
               <textarea class="pd-textarea" id="desc-text" name="description" maxlength="600" placeholder="Write what customers should know: taste, ingredients, size, allergens...">${safe(p.description || '')}</textarea>
               <div class="pd-count"><span id="desc-count">${(p.description || '').length}</span> / 600</div>
               <div class="pd-edit-actions"><button type="button" class="btn btn-sm" data-action="cancel-desc" data-id="${p.id}">Cancel</button><button class="btn btn-primary btn-sm" type="submit">Save description</button></div>
           </form>`
        : `<p class="pd-desc ${desc ? '' : 'empty'}">${desc ? safe(desc) : (staff ? 'No description yet. Add one so customers know what they are buying.' : 'No description available for this item yet.')}</p>`;
    const buy = `
        <div class="pd-buy">
            <div class="pd-qty"><button type="button" data-action="detail-dec" aria-label="Decrease quantity">−</button><span id="detail-qty">${detailQty}</span><button type="button" data-action="detail-inc" data-id="${p.id}" aria-label="Increase quantity">+</button></div>
            <button class="btn btn-primary" data-action="detail-add" data-id="${p.id}" ${unavailable(p) ? 'disabled' : ''}>${isExpired(p) ? 'Expired' : p.stock ? (staff ? 'Add to sale' : 'Add to cart') : 'Sold out'}</button>
        </div>`;
    const editingExpiry = staff && editing === 'expiry';
    const expiryBlock = `
        <div class="pd-expiry ${exp ? exp.cls : 'none'}">
            <div class="pd-expiry-info">
                <small>Expiration date</small>
                <strong>${exp ? safe(exp.pretty) : (staff ? 'No expiration date set' : 'Not specified')}</strong>
                ${exp ? `<span>${safe(exp.note)}</span>` : (staff ? '<span>Add one so customers can see it.</span>' : '')}
            </div>
            ${staff && !editingExpiry ? `<button class="pd-edit-btn" data-action="edit-expiry" data-id="${p.id}">${exp ? 'Change' : 'Set'} date</button>` : ''}
            ${editingExpiry ? `
            <form id="expiry-form" class="pd-expiry-form" data-id="${p.id}">
                <input class="input" id="expiry-input" type="date" name="expiry" min="2000-01-01" max="2100-12-31" value="${safe(p.expiry || '')}" aria-label="Expiration date">
                <div class="pd-edit-actions">
                    ${p.expiry ? `<button type="button" class="btn btn-sm" data-action="clear-expiry" data-id="${p.id}">Remove date</button>` : ''}
                    <button type="button" class="btn btn-sm" data-action="cancel-desc" data-id="${p.id}">Cancel</button>
                    <button class="btn btn-primary btn-sm" type="submit">Save date</button>
                </div>
            </form>` : ''}
        </div>`;
    const staffTools = staff ? `
        <div class="pd-staff">
            <button class="btn" data-action="edit" data-id="${p.id}">✎ Edit product</button>
            <button class="btn" data-action="stock" data-id="${p.id}">± Adjust stock</button>
        </div>` : '';
    openModal(`
        <div class="pd-media"><button class="pd-close" data-action="close" aria-label="Close">×</button>${renderIcon(p.icon)}</div>
        <div class="pd-body">
            <div class="pd-tags"><span class="pd-tag">${safe(p.category)}</span><span class="pd-tag ${st.cls}">${st.label}</span>${exp && exp.cls === 'low' ? `<span class="pd-tag low">${safe(exp.short)}</span>` : ''}</div>
            <h2 class="pd-title">${safe(p.name)}</h2>
            <div class="pd-price">${money(p.price)}</div>
            <div class="pd-label">About this item ${staff && editing !== true ? `<button class="pd-edit-btn" data-action="edit-desc" data-id="${p.id}">✎ ${desc ? 'Edit' : 'Add'} description</button>` : ''}</div>
            ${descBlock}
            <div class="pd-facts">
                <div class="pd-fact"><small>SKU</small><strong>${safe(p.sku)}</strong></div>
                <div class="pd-fact"><small>Category</small><strong>${safe(p.category)}</strong></div>
                <div class="pd-fact"><small>${staff ? 'In stock' : 'Availability'}</small><strong>${staff ? p.stock + ' units' : st.label}</strong></div>
            </div>
            ${expiryBlock}
            ${buy}${staffTools}
        </div>`, 'modal-product');
    if (editing === true) { const t = $('#desc-text'); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } }
}

function stockModal(p) {
    openModal(`
        <h2>Adjust stock</h2>
        <p class="modal-sub">${safe(p.name)} · Current stock: <strong>${p.stock}</strong></p>
        <form id="stock-form" data-id="${p.id}">
            <label class="field-label">Quantity to add or remove</label>
            <input class="input" type="number" name="change" required min="-100000" max="100000" step="1" placeholder="e.g. 10 or -2">
            <p class="modal-sub" style="margin:9px 0">Use a positive number to restock or a negative number to remove damaged items.</p>
            <div class="modal-actions"><button type="button" class="btn" data-action="close">Cancel</button><button class="btn btn-primary" type="submit">Update stock</button></div>
        </form>`);
}

function receiptHtml(s) {
    const online = s.fulfillment && s.fulfillment !== 'in-store';
    return `
        <div class="receipt-header">
            <img class="receipt-logo" src="/img/logo-mark.svg" alt="7-Eleven">
            <h2>7/11 Online Convenience Store</h2>
            <div class="table-muted">Order #${s.id.toString().padStart(4, '0')} · ${date(s.time)}</div>
            <div class="table-muted">${safe(s.buyerName)}${s.cashierName ? ' · Served by ' + safe(s.cashierName) : ''}</div>
            ${online ? `<div style="margin-top:8px">${statusPill(s.status)}</div>` : ''}
        </div>
        <div style="padding:13px 0;border-bottom:1px dashed var(--line)">
            ${s.lines.map(l => `<div class="receipt-row"><span>${l.quantity} × ${safe(l.name)}</span><strong>${money(l.quantity * l.price)}</strong></div>`).join('')}
        </div>
        ${s.fee || online ? `<div class="receipt-row"><span>Subtotal</span><span>${money(s.total - (s.fee || 0))}</span></div>` : ''}
        ${online && s.fulfillment === 'delivery' ? `<div class="receipt-row"><span>Delivery fee</span><span>${s.fee ? money(s.fee) : 'FREE'}</span></div>` : ''}
        <div class="receipt-row receipt-total"><span>Total</span><span>${money(s.total)}</span></div>
        ${online
            ? `<div class="receipt-row"><span>Payment</span><span>${safe(PAY_LABEL[s.payment] || s.payment)}</span></div>
               <div class="receipt-row"><span>${s.fulfillment === 'delivery' ? 'Deliver to' : 'Pickup'}</span><span class="receipt-addr">${s.fulfillment === 'delivery' ? safe(s.address) : 'At the store'}</span></div>
               ${s.note ? `<div class="receipt-row"><span>Note</span><span class="receipt-addr">${safe(s.note)}</span></div>` : ''}`
            : `<div class="receipt-row"><span>Payment received</span><span>${money(s.paid)}</span></div>
               <div class="receipt-row"><span>Change</span><strong>${money(s.change)}</strong></div>`}
        <p class="receipt-caption">Thank you for shopping at 7/11!</p>`;
}

function showReceipt(s) {
    currentReceipt = s;
    $('#print-area').innerHTML = receiptHtml(s);
    openModal(`
        <h2>${s.fulfillment && s.fulfillment !== 'in-store' ? 'Order placed ✓' : 'Purchase complete ✓'}</h2>
        <p class="modal-sub">Thank you for your order.</p>
        ${receiptHtml(s)}
        <div class="modal-actions"><button class="btn" data-action="close">Close</button><button class="btn btn-primary" data-action="print">Print receipt</button></div>`);
}

// ---------------------------------------------------------------- Clicks
document.addEventListener('click', async e => {
    const nav = e.target.closest('[data-view]'); if (nav) { switchView(nav.dataset.view); return; }
    const chip = e.target.closest('[data-category]'); if (chip) { category = chip.dataset.category; renderPOS(); const g = $('.product-grid'); if (g) g.classList.add('swap'); return; }
    const button = e.target.closest('[data-action]'); if (!button) return;

    const action = button.dataset.action, id = Number(button.dataset.id);
    try {
        if (action === 'go-pos') switchView('pos');
        else if (action === 'go-inventory') switchView('inventory');
        else if (action === 'go-sales') switchView('sales');
        else if (action === 'wish') await toggleWish(id);
        else if (action === 'reorder') reorder(id);
        else if (action === 'cancel-order') await cancelOrder(id);
        else if (action === 'set-fulfillment') { fulfillment = button.dataset.value; renderPOS(); }
        else if (action === 'go-addresses') { settingsTab = 'addresses'; switchView('settings'); }
        else if (action === 'new-product') productModal();
        else if (action === 'view-product') productDetailModal(productById(id));
        else if (action === 'edit-desc') productDetailModal(productById(id), true);
        else if (action === 'cancel-desc') productDetailModal(productById(id));
        else if (action === 'edit-expiry' || action === 'expiry') productDetailModal(productById(id), 'expiry');
        else if (action === 'clear-expiry') await saveExpiry(id, '');
        else if (action === 'detail-inc') {
            const p = productById(id), room = p.stock - (cart.get(id) || 0);
            if (detailQty >= room) { notify(room > 0 ? 'Only ' + p.stock + ' available in stock.' : 'All available stock is already in your cart.', true); return; }
            detailQty++; $('#detail-qty').textContent = detailQty;
        } else if (action === 'detail-dec') { if (detailQty > 1) { detailQty--; $('#detail-qty').textContent = detailQty; } }
        else if (action === 'detail-add') {
            const p = productById(id), next = (cart.get(id) || 0) + detailQty;
            if (isExpired(p)) { notify('This product has expired and can\'t be sold.', true); return; }
            if (next > p.stock) { notify('Only ' + p.stock + ' available in stock.', true); return; }
            cart.set(id, next); justAdded = id; closeModal(); renderPOS(); justAdded = null;
            notify(detailQty + ' × ' + p.name + (isStaff() ? ' added to the sale.' : ' added to your cart.'));
        }
        else if (action === 'edit') productModal(productById(id));
        else if (action === 'stock') stockModal(productById(id));
        else if (action === 'close') closeModal();
        else if (action === 'print') window.print();
        else if (action === 'receipt') showReceipt((isStaff() ? data.sales : data.myOrders).find(s => s.id === id));
        else if (action === 'add-cart' || action === 'increase') {
            const p = productById(id), next = (cart.get(id) || 0) + 1;
            if (isExpired(p)) { notify('This product has expired and can\'t be sold.', true); return; }
            if (next > p.stock) { notify('Only ' + p.stock + ' available in stock.', true); return; }
            cart.set(id, next); justAdded = id; renderPOS(); justAdded = null;
        } else if (action === 'decrease') {
            const next = (cart.get(id) || 0) - 1;
            if (next <= 0) cart.delete(id); else cart.set(id, next); renderPOS();
        } else if (action === 'remove-cart') {
            cart.delete(id); renderPOS();
        } else if (action === 'delete') {
            const p = productById(id);
            if (!confirm('Delete ' + p.name + ' from inventory? Past sale receipts will remain available.')) return;
            await api('/api/products/' + id, { method: 'DELETE' });
            await refresh(); notify('Product deleted.');
        } else if (action === 'checkout') {
            if (!cart.size) return;
            if (!isStaff()) { await customerCheckout(button); return; }
            const paid = String(cashValue).trim();
            const cents = Math.round(Number(paid) * 100);
            if (!paid || !Number.isFinite(cents) || cents < cartTotal()) { notify('Enter enough payment to cover the total.', true); return; }
            button.disabled = true;

            const itemsInCart = [...cart].map(([itemId, qty]) => ({ id: itemId, qty }));
            const itemsParam = itemsInCart.map(item => item.id + ':' + item.qty).join(',');
            const payload = { items: itemsParam, paid };
            if (isStaff()) payload.customerName = walkInName;

            const sale = await postForm('/api/sales', payload);
            cart.clear(); cashValue = ''; walkInName = ''; await refresh(); showReceipt(sale);

            if (isStaff()) {
                const lowStockAlerts = itemsInCart.map(item => productById(item.id)).filter(p => p && p.stock <= p.threshold);
                if (lowStockAlerts.length > 0) setTimeout(() => notify(`⚠️ ${lowStockAlerts.length} item(s) are now low or out of stock!`, false, 6000), 900);
                else notify('Payment completed.');
            } else {
                notify('Thank you for shopping at 7/11!', false, 4000);
            }
        }
    } catch (err) { notify(err.message, true); if (action === 'checkout') button.disabled = false; }
});

document.addEventListener('submit', async e => {
    const form = e.target; if (!['product-form', 'stock-form', 'desc-form', 'expiry-form'].includes(form.id)) return;
    e.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    const button = form.querySelector('[type=submit]'); button.disabled = true;
    try {
        if (form.id === 'expiry-form') {
            await saveExpiry(Number(form.dataset.id), values.expiry || ''); return;
        }
        if (form.id === 'desc-form') {
            const p = productById(Number(form.dataset.id));
            await api('/api/products/' + p.id, { method: 'PUT', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: formBody({
                name: p.name, sku: p.sku, category: p.category, icon: p.icon, price: (p.price / 100).toFixed(2), threshold: p.threshold, expiry: p.expiry || '', description: values.description }) });
            await refresh(); notify('Description saved.'); productDetailModal(productById(p.id)); return;
        }
        if (form.id === 'product-form') {
            const id = form.dataset.id;
            await api(id ? '/api/products/' + id : '/api/products', { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: formBody(values) });
            notify(id ? 'Product updated.' : 'Product added.');
        } else {
            await api('/api/products/' + form.dataset.id + '/stock', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: formBody(values) });
            notify('Stock updated.');
        }
        closeModal(); await refresh();
    } catch (err) { notify(err.message, true); button.disabled = false; }
});

document.addEventListener('input', e => {
    if (e.target.id === 'pos-search') { posSearch = e.target.value; const pos = e.target.selectionStart; renderPOS(); $('#pos-search').focus(); $('#pos-search').setSelectionRange(pos, pos); }
    else if (e.target.id === 'inventory-search') { inventorySearch = e.target.value; const pos = e.target.selectionStart; renderInventory(); $('#inventory-search').focus(); $('#inventory-search').setSelectionRange(pos, pos); }
    else if (e.target.id === 'sales-search') { salesSearch = e.target.value; const pos = e.target.selectionStart; renderSales(); $('#sales-search').focus(); $('#sales-search').setSelectionRange(pos, pos); }
    else if (e.target.id === 'orders-search') { ordersSearch = e.target.value; const pos = e.target.selectionStart; renderOrders(); $('#orders-search').focus(); $('#orders-search').setSelectionRange(pos, pos); }
    else if (e.target.id === 'desc-text') { $('#desc-count').textContent = e.target.value.length; }
    else if (e.target.id === 'walkin-name') { walkInName = e.target.value; }
    else if (e.target.id === 'cash') { cashValue = e.target.value; $('#change-amount').textContent = money(Math.max(0, Math.round((Number(cashValue) || 0) * 100) - cartTotal())); }
});

document.addEventListener('pointerdown', e => {
    const target = e.target.closest('.btn, .nav, .chip, .add-btn, .subtab, .role-tab, .theme-btn');
    if (!target || target.disabled) return;
    const rect = target.getBoundingClientRect(), size = Math.max(rect.width, rect.height) * 2;
    const dot = document.createElement('span');
    dot.className = 'ripple';
    dot.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - rect.left - size / 2}px;top:${e.clientY - rect.top - size / 2}px`;
    target.appendChild(dot);
    setTimeout(() => dot.remove(), 650);
});

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
    else if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('product-card')) { e.preventDefault(); productDetailModal(productById(Number(e.target.dataset.id))); }
});
$('#mobile-menu').addEventListener('click', () => $('.sidebar').classList.toggle('open'));
$('#today').textContent = new Date().toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

// ---------------------------------------------------------------- Orders, wishlist, cart persistence
const STATUS = {
    pending: ['Pending', 'warn'], preparing: ['Preparing', 'info'], out_for_delivery: ['Out for delivery', 'info'],
    ready: ['Ready for pickup', 'ok'], completed: ['Completed', 'ok'], cancelled: ['Cancelled', 'empty']
};
const PAY_LABEL = { cod: 'Cash on delivery / pay at store', gcash: 'GCash (demo)', card: 'Card (demo)', cash: 'Cash' };
const isActive = s => ['pending', 'preparing', 'out_for_delivery', 'ready'].includes(s.status);
const validSales = () => data.sales.filter(s => s.status !== 'cancelled');
const statusPill = st => `<span class="pill status-${safe(st)}">${safe(STATUS[st] ? STATUS[st][0] : st)}</span>`;
const feeNow = () => (!isStaff() && fulfillment === 'delivery' && cart.size && cartTotal() < data.config.freeDeliveryOver) ? data.config.deliveryFee : 0;

const cartKey = () => me ? 'cart:' + me.id : null;
function saveCart() {
    const key = cartKey(); if (!key) return;
    try { localStorage.setItem(key, JSON.stringify([...cart])); } catch {}
}
function loadCart() {
    cart.clear();
    const key = cartKey(); if (!key) return;
    try { for (const [id, qty] of JSON.parse(localStorage.getItem(key) || '[]')) if (Number(qty) > 0) cart.set(Number(id), Number(qty)); } catch {}
}

function productCardHtml(p) {
    const wished = data.wishlist.includes(p.id);
    return `
        <div class="product-card ${unavailable(p) ? 'soldout' : ''}" data-action="view-product" data-id="${p.id}" role="button" tabindex="0" aria-label="View details for ${safe(p.name)}">
            ${isStaff() ? '' : `<button class="wish-btn ${wished ? 'on' : ''}" data-action="wish" data-id="${p.id}" aria-label="${wished ? 'Remove from' : 'Add to'} wishlist" aria-pressed="${wished}">${wished ? '♥' : '♡'}</button>`}
            <div class="product-art">${renderIcon(p.icon)}</div>
            <div class="product-name" title="${safe(p.name)}">${safe(p.name)}</div>
            <div class="product-category">${safe(p.category)} · ${safe(p.sku)}</div>
            ${expiryInfo(p) ? `<div class="exp-tag ${expiryInfo(p).cls}">${safe(expiryInfo(p).short)}</div>` : ''}
            <div class="product-foot">
                <div><div class="price">${money(p.price)}</div><div class="stock-tag">${isExpired(p) ? 'Expired' : p.stock ? 'Stock: ' + p.stock : 'Out of stock'}</div></div>
                <button class="add-btn" data-action="add-cart" data-id="${p.id}" aria-label="Add ${safe(p.name)}" ${unavailable(p) ? 'disabled' : ''}>+</button>
            </div>
        </div>`;
}

function checkoutOptionsHtml() {
    if (me && me.guest) fulfillment = 'pickup';   // guests have no saved addresses, so delivery is account-only
    const free = data.config.freeDeliveryOver;
    const addr = data.addresses.length
        ? `<select class="input" id="addr-select" aria-label="Delivery address">${data.addresses.map(a => `<option value="${a.id}" ${String(a.id) === String(addressChoice) ? 'selected' : ''}>${safe(a.label)} — ${safe(a.street)}, ${safe(a.city)}</option>`).join('')}</select>
           <button type="button" class="link-btn" data-action="go-addresses" style="margin-top:6px">Manage addresses →</button>`
        : `<div class="co-empty">No saved address yet. <button type="button" class="link-btn" data-action="go-addresses">Add one →</button></div>`;
    return `
        <div class="co-section">
            <div class="field-label">How would you like your order?</div>
            <div class="seg">
                <button type="button" class="seg-btn ${fulfillment === 'pickup' ? 'active' : ''}" data-action="set-fulfillment" data-value="pickup">🏪 Pickup</button>
                <button type="button" class="seg-btn ${fulfillment === 'delivery' ? 'active' : ''}" data-action="set-fulfillment" data-value="delivery" ${me && me.guest ? 'disabled title="Delivery is for account holders"' : ''}>${me && me.guest ? '🔒' : '🛵'} Delivery</button>
            </div>
            ${me && me.guest ? '<p class="co-lock">Delivery is for account holders. <button type="button" class="link-btn" onclick="guestToAuth(\'signup\')">Make an account →</button></p>' : ''}
            ${fulfillment === 'delivery' ? `<div style="margin-top:10px">${addr}<p class="cart-note" style="text-align:left">Delivery ${money(data.config.deliveryFee)} · free for orders of ${money(free)} or more.</p></div>` : '<p class="cart-note" style="text-align:left">Pick it up at the store counter — no fee.</p>'}
        </div>
        <div class="co-section">
            <label class="field-label" for="pay-method">Payment method</label>
            <select class="input" id="pay-method">
                <option value="cod" ${payMethod === 'cod' ? 'selected' : ''}>Cash on delivery / pay at store</option>
                <option value="gcash" ${payMethod === 'gcash' ? 'selected' : ''}>GCash (demo)</option>
                <option value="card" ${payMethod === 'card' ? 'selected' : ''}>Credit / debit card (demo)</option>
            </select>
            ${payMethod === 'cod' ? '' : '<p class="cart-note" style="text-align:left">Demo payment for this school project — nothing is actually charged.</p>'}
        </div>
        <div class="co-section">
            <label class="field-label" for="order-note">Order note (optional)</label>
            <input class="input" id="order-note" maxlength="200" placeholder="e.g. No ice, please" value="${safe(orderNote)}">
        </div>
        <button class="btn btn-primary btn-wide" data-action="checkout" ${cart.size ? '' : 'disabled'}>Place order · ${money(cartTotal() + feeNow())} →</button>`;
}

async function customerCheckout(button) {
    if (fulfillment === 'delivery' && !addressChoice) {
        notify('Add a delivery address first.', true);
        if (!data.addresses.length) { settingsTab = 'addresses'; switchView('settings'); }
        return;
    }
    button.disabled = true;
    const payload = { items: [...cart].map(([id, qty]) => id + ':' + qty).join(','), fulfillment, payment: payMethod, note: orderNote };
    if (fulfillment === 'delivery') payload.addressId = addressChoice;
    const sale = await postForm('/api/sales', payload);
    cart.clear(); orderNote = ''; await refresh(); showReceipt(sale);
    notify('Order placed! Track it under My orders.');
}

async function toggleWish(id) {
    const r = await api('/api/wishlist/' + id, { method: 'POST' });
    data.wishlist = r.wishlist;
    renderPOS(); renderWishlist();
    const wc = $('#nav-wish-count'); if (wc) { wc.hidden = !data.wishlist.length; wc.textContent = data.wishlist.length; }
}

function reorder(orderId) {
    const order = data.myOrders.find(o => o.id === orderId); if (!order) return;
    let added = 0, skipped = 0;
    for (const line of order.lines) {
        const p = productById(line.productId);
        if (!p || unavailable(p)) { skipped++; continue; }
        cart.set(p.id, Math.min(p.stock, (cart.get(p.id) || 0) + line.quantity)); added++;
    }
    switchView('pos');
    notify(added ? `Added ${plural(added, 'item')} to your cart${skipped ? ` (${skipped} unavailable)` : ''}.` : 'Those items are no longer available.', !added);
}

async function cancelOrder(orderId) {
    if (!confirm('Cancel order #' + String(orderId).padStart(4, '0') + '? The items will go back to stock.')) return;
    await postForm('/api/sales/' + orderId + '/status', { status: 'cancelled' });
    await refresh(); notify('Order cancelled.');
}

function renderWishlist() {
    const root = $('#wishlist-view'); if (!root || isStaff()) return;
    const items = data.wishlist.map(productById).filter(Boolean);
    root.innerHTML = items.length
        ? `<div class="card catalog"><div class="catalog-meta"><strong>Saved items</strong><span>${plural(items.length, 'item')}</span></div><div class="product-grid wish-grid">${items.map(productCardHtml).join('')}</div></div>`
        : `<div class="card panel"><div class="empty-state">♡ Your wishlist is empty.<br>Tap the heart on any product to save it here.<br><br><button class="btn btn-primary" data-view="pos">Browse products</button></div></div>`;
}

document.addEventListener('change', async e => {
    const t = e.target;
    if (t.classList?.contains('status-select')) {
        const id = Number(t.dataset.order), status = t.value;
        if (status === 'cancelled' && !confirm('Cancel this order and return its items to stock?')) { renderSales(); return; }
        try { await postForm('/api/sales/' + id + '/status', { status }); await refresh(); notify('Order #' + String(id).padStart(4, '0') + ' is now ' + STATUS[status][0].toLowerCase() + '.'); }
        catch (err) { notify(err.message, true); await refresh(); }
    } else if (t.id === 'pay-method') { payMethod = t.value; renderPOS(); }
    else if (t.id === 'addr-select') { addressChoice = t.value; }
    else if (t.id === 'sort-by') { sortBy = t.value; renderPOS(); }
    else if (t.id === 'avatar-input') {
        const file = t.files && t.files[0]; t.value = '';
        if (!file) return;
        try {
            if (!file.type.startsWith('image/')) throw new Error('Please choose an image file.');
            if (file.size > 15 * 1024 * 1024) throw new Error('That image is too large (15 MB max).');
            me = await postForm('/api/account/avatar', { image: await resizeToDataUrl(file) });
            paintIdentity(); await loadAccount(); notify('Profile picture updated.');
        } catch (err) { notify(err.message, true); }
    }
});
document.addEventListener('input', e => { if (e.target.id === 'order-note') orderNote = e.target.value; });

// ---------------------------------------------------------------- Login background (store photos slideshow)
// Left-panel photo: your own store-*.jpg first, otherwise a free Wikimedia Commons photo of a 7-Eleven at night,
// otherwise the bundled illustration. (Save any photo as public/img/store-1.jpg to make it work fully offline.)
const PANEL_PHOTO_URL = 'https://commons.wikimedia.org/wiki/Special:FilePath/Night_view_of_7-Eleven_store_at_2546_Niagara_Falls_Boulevard,_Tonawanda,_New_York_-_20230202.jpg?width=1100';
const canLoadImage = (src, timeout = 7000) => new Promise(done => {
    const im = new Image(), t = setTimeout(() => done(false), timeout);
    im.onload = () => { clearTimeout(t); done(true); };
    im.onerror = () => { clearTimeout(t); done(false); };
    im.src = src;
});
async function initAuthVisual(localImages) {
    const el = $('#auth-visual-photo'); if (!el) return;
    el.style.backgroundImage = "url('/img/store-fallback.svg')";
    if (localImages.length && await canLoadImage(localImages[0])) { el.style.backgroundImage = `url('${localImages[0]}')`; return; }
    if (await canLoadImage(PANEL_PHOTO_URL)) { el.style.backgroundImage = `url('${PANEL_PHOTO_URL}')`; }
}

async function initAuthBackground() {
    const bg = $('#auth-bg'); if (!bg) return;
    bg.style.backgroundImage = "url('/img/store-fallback.svg')";
    try {
        const { images } = await api('/api/backgrounds');
        const loaded = [];
        await Promise.all(images.map(src => new Promise(done => { const im = new Image(); im.onload = () => { loaded.push(src); done(); }; im.onerror = done; im.src = src; })));
        loaded.sort();
        initAuthVisual(loaded);
        if (!loaded.length) return;
        bg.innerHTML = loaded.map((src, i) => `<div class="auth-slide ${i === 0 ? 'on' : ''}" style="background-image:url('${src}')"></div>`).join('');
        if (loaded.length > 1) {
            let i = 0;
            setInterval(() => { const slides = bg.querySelectorAll('.auth-slide'); slides[i].classList.remove('on'); i = (i + 1) % slides.length; slides[i].classList.add('on'); }, 6000);
        }
    } catch { initAuthVisual([]); }
}

// ---------------------------------------------------------------- Settings
async function loadAccount() {
    try { account = await api('/api/account'); me = account.user; paintIdentity(); }
    catch (err) { notify(err.message, true); }
    if (view === 'settings') renderSettings();
}
function openSettings() { renderSettings(); loadAccount(); }

async function resizeToDataUrl(file, size = 256) {
    const img = await new Promise((resolve, reject) => {
        const image = new Image(), url = URL.createObjectURL(file);
        image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
        image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file could not be read as an image.')); };
        image.src = url;
    });
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d'), side = Math.min(img.width, img.height);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', 0.86);
}

function guestSettingsPromo() {
    const perks = ['Save delivery addresses', 'Track and reorder your orders', 'Build your wishlist', 'Your own secure profile'];
    return `
        <div class="gs-card">
            <div>
                <span class="gs-eyebrow"><i></i> Guest session</span>
                <h2 class="gs-title"><span>Make an account</span> to start shopping with us now!</h2>
                <p class="gs-sub">You’re browsing as a guest, so profile, contact and address settings are turned off. It only takes a minute to join.</p>
                <ul class="gs-perks">${perks.map(p => `<li>${p}</li>`).join('')}</ul>
                <div class="gs-actions">
                    <button type="button" class="gs-btn gs-btn-primary" onclick="guestToAuth('signup')">Create free account
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg></button>
                    <button type="button" class="gs-btn gs-btn-ghost" onclick="guestToAuth('login')">I already have one</button>
                </div>
            </div>
            <div class="gs-art" aria-hidden="true">
                <svg viewBox="0 0 200 200">
                    <ellipse cx="100" cy="182" rx="56" ry="9" fill="rgba(0,80,45,.18)"/>
                    <path d="M62 78h76l9 92a8 8 0 0 1-8 9H61a8 8 0 0 1-8-9z" fill="#00854a"/>
                    <path d="M62 78h76l9 92a8 8 0 0 1-8 9H100z" fill="#00a35a"/>
                    <path d="M78 78V64a22 22 0 0 1 44 0v14" fill="none" stroke="#005f35" stroke-width="7" stroke-linecap="round"/>
                    <rect x="53" y="112" width="94" height="14" fill="#f27b21"/><rect x="53" y="126" width="94" height="14" fill="#fff"/><rect x="53" y="140" width="94" height="14" fill="#ee2a24"/>
                    <path d="M74 122h10m2 0h4" stroke="#fff" stroke-width="0"/>
                    <path class="gs-spark" d="M28 52l4 10 10 4-10 4-4 10-4-10-10-4 10-4z" fill="#ffb340"/>
                    <path class="gs-spark s2" d="M164 38l3 8 8 3-8 3-3 8-3-8-8-3 8-3z" fill="#22c07a"/>
                    <path class="gs-spark s3" d="M170 108l3 7 7 3-7 3-3 7-3-7-7-3 7-3z" fill="#f27b21"/>
                </svg>
            </div>
        </div>`;
}

window.guestToAuth = async (subtab) => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    me = null; cart.clear(); account = null;
    goToAuth('customer', subtab);
};

function renderSettings() {
    const root = $('#settings-view'); if (!root || !me) return;
    if (me.guest) {                          // guests: appearance + an invitation to sign up, nothing else
        root.innerHTML = `<div class="settings-body guest-settings">${guestSettingsPromo()}${tabAppearance()}</div>`;
        applyTheme();
        return;
    }
    const tabs = [['overview', 'Overview'], ['profile', 'Profile'], ['contact', 'Email & phone'], ['security', 'Security'],
        ...(isStaff() ? [] : [['addresses', 'Addresses']]), ['appearance', 'Appearance']];
    if (!tabs.some(t => t[0] === settingsTab)) settingsTab = 'overview';
    const panels = { overview: tabOverview, profile: tabProfile, contact: tabContact, security: tabSecurity, addresses: tabAddresses, appearance: tabAppearance };
    root.innerHTML = `
        <div class="settings-layout">
            <div class="card settings-nav" role="tablist" aria-label="Settings sections">
                ${tabs.map(([key, label]) => `<button class="settings-tab ${key === settingsTab ? 'active' : ''}" data-stab="${key}" role="tab" aria-selected="${key === settingsTab}">${label}</button>`).join('')}
            </div>
            <div class="settings-body">${panels[settingsTab]()}</div>
        </div>`;
    applyTheme();
}

function tabOverview() {
    const st = account && account.stats;
    const facts = [
        ['Member since', date(me.createdAt)],
        ['Last sign-in', account && account.lastLogin ? date(account.lastLogin) : 'This is your first session'],
        [isStaff() ? 'Last sale handled' : 'Last order', st && st.lastOrder ? date(st.lastOrder) : '—'],
        ['Active sessions', account ? String(account.sessions) : '…']
    ];
    const cards = !st ? [] : isStaff()
        ? [['Sales handled', st.orders], ['Revenue handled', money(st.spent)], ['Items sold', st.items], ['Sales today', st.today], ['Average sale', money(st.average)], ['Cancelled', st.cancelled]]
        : [['Orders placed', st.orders], ['Total spent', money(st.spent)], ['Items bought', st.items], ['Average order', money(st.average)], ['Cancelled orders', st.cancelled], ['Favorite item', st.topProduct || '—'], ['Wishlist items', st.wishlist], ['Saved addresses', st.addresses]];
    return `
        <div class="card s-card s-hero">
            ${avatarHtml(me, 'avatar-xl')}
            <div class="s-hero-info">
                <h2>${safe(me.name)} <span class="role-badge ${me.role}">${safe(me.role)}</span></h2>
                <div class="s-sub">@${safe(me.username)}${me.guest ? ' · guest session' : ''}</div>
                <div class="s-pills">
                    <span class="pill ${me.emailVerified ? '' : 'warn'}">${me.email ? (me.emailVerified ? '✓ Email verified' : 'Email not verified') : 'No email yet'}</span>
                    <span class="pill ${me.phoneVerified ? '' : 'warn'}">${me.phone ? (me.phoneVerified ? '✓ Phone verified' : 'Phone not verified') : 'No phone yet'}</span>
                </div>
            </div>
        </div>
        <div class="card s-card"><h3>Your stats</h3>
            ${st ? `<div class="s-stats">${cards.map(([label, value]) => `<div class="s-stat"><span>${safe(label)}</span><strong>${safe(value)}</strong></div>`).join('')}</div>` : '<div class="empty-state">Loading your stats…</div>'}
        </div>
        <div class="card s-card"><h3>Account activity</h3>
            <div class="s-facts">${facts.map(([k, v]) => `<div><span>${safe(k)}</span><strong>${safe(v)}</strong></div>`).join('')}</div>
        </div>`;
}

function tabProfile() {
    return `
        <div class="card s-card"><h3>Profile picture</h3>
            <p class="s-sub">JPG, PNG, WebP or GIF. It is cropped to a square and resized for you.</p>
            <div class="s-avatar-row">${avatarHtml(me, 'avatar-xl')}
                <div class="s-actions">
                    <button class="btn btn-primary" data-sact="pick-avatar">Upload photo</button>
                    ${me.avatarVer ? '<button class="btn" data-sact="remove-avatar">Remove</button>' : ''}
                </div>
            </div>
        </div>
        <div class="card s-card"><h3>Name &amp; username</h3>
            <form data-sform="profile" class="s-form">
                <label class="field-label" for="s-name">Display name</label>
                <input class="input" id="s-name" name="name" required minlength="2" maxlength="60" value="${safe(me.name)}" autocomplete="name">
                <label class="field-label" for="s-username">Username</label>
                <input class="input" id="s-username" name="username" required minlength="3" maxlength="24" pattern="[a-zA-Z0-9_]+" value="${safe(me.username)}" autocomplete="username" ${me.guest ? 'disabled' : ''}>
                ${me.guest ? '<p class="s-sub">Guest sessions can\'t change their username. Create a full account to pick your own.</p>' : '<p class="s-sub">Letters, numbers and underscores only. You can also sign in with a verified email.</p>'}
                <div><button class="btn btn-primary" type="submit">Save changes</button></div>
            </form>
        </div>`;
}

function contactCard(kind) {
    const isEmail = kind === 'email', val = isEmail ? me.email : me.phone, verified = isEmail ? me.emailVerified : me.phoneVerified, demo = verifyDemo[kind];
    return `
        <div class="card s-card">
            <div class="s-head"><h3>${isEmail ? 'Email address' : 'Mobile number'}</h3>${val ? `<span class="pill ${verified ? '' : 'warn'}">${verified ? '✓ Verified' : 'Not verified'}</span>` : ''}</div>
            <p class="s-sub">${isEmail ? 'Used for receipts and account recovery. Once verified you can also sign in with it.' : 'Used for delivery updates. Philippine numbers like 09171234567 work.'}</p>
            <form data-sform="${kind}" class="s-form s-inline">
                <input class="input" name="value" type="${isEmail ? 'email' : 'tel'}" required maxlength="120" value="${safe(val || '')}" placeholder="${isEmail ? 'you@example.com' : '09171234567'}" aria-label="${isEmail ? 'Email' : 'Mobile number'}">
                <button class="btn btn-primary" type="submit">${!val ? 'Add & send code' : verified ? 'Change & verify' : 'Update & resend'}</button>
            </form>
            ${val && !verified ? `
                <form data-sform="${kind}-verify" class="s-form s-inline s-verify">
                    <input class="input" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required placeholder="6-digit code" aria-label="Verification code">
                    <button class="btn btn-primary" type="submit">Verify</button>
                </form>
                <div class="s-demo">${demo ? `<b>Demo mode:</b> no ${isEmail ? 'email' : 'SMS'} service is connected, so your code is shown here: <strong class="s-code">${safe(demo)}</strong>` : 'A code was generated. In demo mode it is printed in the server terminal — or tap Resend to see it here.'}</div>
                <div class="s-actions"><button class="link-btn" data-sact="resend" data-kind="${kind}">Resend code</button></div>` : ''}
            ${val ? `<div class="s-actions"><button class="link-btn s-danger" data-sact="remove-contact" data-kind="${kind}">Remove ${isEmail ? 'email' : 'number'}</button></div>` : ''}
        </div>`;
}
const tabContact = () => contactCard('email') + contactCard('phone');

function tabSecurity() {
    return `
        <div class="card s-card"><h3>Change password</h3>
            ${me.guest ? '<p class="s-sub">Guest sessions don\'t have a password. Create a full account to set one.</p>' : `
            <form data-sform="password" class="s-form">
                <label class="field-label" for="s-cur">Current password</label>
                <input class="input" id="s-cur" name="current" type="password" required autocomplete="current-password">
                <label class="field-label" for="s-new">New password</label>
                <input class="input" id="s-new" name="password" type="password" required minlength="6" maxlength="100" autocomplete="new-password" placeholder="At least 6 characters">
                <label class="field-label" for="s-conf">Confirm new password</label>
                <input class="input" id="s-conf" name="confirm" type="password" required minlength="6" maxlength="100" autocomplete="new-password">
                <p class="s-sub">Changing your password signs you out on your other devices.</p>
                <div><button class="btn btn-primary" type="submit">Update password</button></div>
            </form>`}
        </div>
        <div class="card s-card"><h3>Sign out everywhere</h3>
            <p class="s-sub">Ends every active session for this account${account ? ` (currently ${plural(account.sessions, 'session')})` : ''} on all browsers and devices, including this one.</p>
            <button class="btn s-danger-btn" data-sact="logout-all">Log out of all devices</button>
        </div>`;
}

function tabAddresses() {
    return `
        <div class="card s-card"><h3>Saved addresses</h3>
            ${data.addresses.length ? `<div class="s-addr-list">${data.addresses.map(a => `
                <div class="s-addr"><div><strong>${safe(a.label)}</strong><small>${safe(a.recipient)} · ${safe(a.phone)}</small><small>${safe(a.street)}, ${safe(a.city)}</small></div>
                <button class="link-btn s-danger" data-sact="delete-address" data-id="${a.id}">Delete</button></div>`).join('')}</div>` : '<div class="empty-state">No saved addresses yet.</div>'}
        </div>
        ${data.addresses.length >= 5 ? '<div class="card s-card"><p class="s-sub">You have reached the limit of 5 saved addresses.</p></div>' : `
        <div class="card s-card"><h3>Add a delivery address</h3>
            <form data-sform="address" class="s-form">
                <div class="s-grid">
                    <div><label class="field-label">Label</label><input class="input" name="label" required minlength="2" maxlength="30" placeholder="Home, Dorm, Office"></div>
                    <div><label class="field-label">Recipient</label><input class="input" name="recipient" required minlength="2" maxlength="60" value="${safe(me.name)}"></div>
                    <div><label class="field-label">Mobile number</label><input class="input" name="phone" type="tel" required value="${safe(me.phone || '')}" placeholder="09171234567"></div>
                    <div><label class="field-label">City / municipality</label><input class="input" name="city" required minlength="2" maxlength="60" placeholder="Butuan City"></div>
                </div>
                <label class="field-label">Street, barangay, landmarks</label>
                <input class="input" name="street" required minlength="5" maxlength="120" placeholder="Street, Brgy., building / landmark">
                <div><button class="btn btn-primary" type="submit">Save address</button></div>
            </form>
        </div>`}`;
}

function tabAppearance() {
    const opt = (key, icon, label, hint) => `<button type="button" class="theme-card ${themePref === key ? 'active' : ''}" data-theme-pref="${key}" data-sact="theme" data-value="${key}"><span class="theme-ico">${icon}</span><strong>${label}</strong><small>${hint}</small></button>`;
    return `
        <div class="card s-card"><h3>Theme</h3>
            <p class="s-sub">Choose how 7/11 looks on this device.</p>
            <div class="theme-cards">
                ${opt('light', '☀️', 'Light', 'Bright and clean')}
                ${opt('dark', '🌙', 'Dark', 'Easy on the eyes')}
                ${opt('system', '💻', 'System', 'Match your device')}
            </div>
        </div>`;
}

document.addEventListener('click', async e => {
    const tab = e.target.closest('[data-stab]');
    if (tab) { settingsTab = tab.dataset.stab; renderSettings(); if (settingsTab === 'overview') loadAccount(); return; }
    const b = e.target.closest('[data-sact]'); if (!b) return;
    const act = b.dataset.sact, kind = b.dataset.kind;
    try {
        if (act === 'theme') { setThemePref(b.dataset.value); }
        else if (act === 'pick-avatar') { $('#avatar-input').click(); }
        else if (act === 'remove-avatar') { me = await api('/api/account/avatar', { method: 'DELETE' }); paintIdentity(); await loadAccount(); notify('Profile picture removed.'); }
        else if (act === 'resend') {
            const r = await postForm('/api/account/' + kind, { value: kind === 'email' ? me.email : me.phone });
            me = r.user; verifyDemo[kind] = r.demoCode; renderSettings(); notify('A new code was generated.');
        } else if (act === 'remove-contact') {
            if (!confirm('Remove your ' + (kind === 'email' ? 'email address' : 'mobile number') + ' from this account?')) return;
            const r = await postForm('/api/account/' + kind, { value: '' });
            me = r.user; verifyDemo[kind] = null; await loadAccount(); notify((kind === 'email' ? 'Email' : 'Number') + ' removed.');
        } else if (act === 'logout-all') {
            if (!confirm('Sign out of every device, including this one?')) return;
            await api('/api/auth/logout-all', { method: 'POST' });
            me = null; cart.clear(); account = null; showLanding(); notify('You have been signed out of all devices.');
        } else if (act === 'delete-address') {
            const r = await api('/api/addresses/' + b.dataset.id, { method: 'DELETE' });
            data.addresses = r.addresses; renderSettings(); notify('Address deleted.');
        }
    } catch (err) { notify(err.message, true); }
});

document.addEventListener('submit', async e => {
    const form = e.target.closest('form[data-sform]'); if (!form) return;
    e.preventDefault();
    const kind = form.dataset.sform, values = Object.fromEntries(new FormData(form));
    const button = form.querySelector('[type=submit]'); if (button) button.disabled = true;
    try {
        if (kind === 'profile') {
            me = await postForm('/api/account/profile', values); paintIdentity(); await loadAccount(); notify('Profile updated.');
        } else if (kind === 'password') {
            if (values.password !== values.confirm) throw new Error('The new passwords do not match.');
            await postForm('/api/account/password', { current: values.current, password: values.password });
            form.reset(); notify('Password changed. Your other devices were signed out.');
        } else if (kind === 'email' || kind === 'phone') {
            const r = await postForm('/api/account/' + kind, { value: values.value });
            me = r.user; verifyDemo[kind] = r.demoCode; await loadAccount(); notify('Verification code generated.');
        } else if (kind === 'email-verify' || kind === 'phone-verify') {
            const which = kind.split('-')[0];
            me = await postForm('/api/account/' + which + '/verify', { code: values.code }); verifyDemo[which] = null;
            await loadAccount(); notify((which === 'email' ? 'Email' : 'Phone number') + ' verified ✓');
        } else if (kind === 'address') {
            const r = await postForm('/api/addresses', values); data.addresses = r.addresses; renderSettings(); notify('Address saved.');
        }
    } catch (err) { notify(err.message, true); }
    finally { if (button) button.disabled = false; }
});

// ---------------------------------------------------------------- Boot
(async function boot() {
    renderAuthTabs();
    initAuthBackground();
    try {
        const { user } = await api('/api/auth/me');
        if (user) { me = user; loadCart(); buildNav(); showApp(); switchView(isStaff() ? 'dashboard' : 'pos'); await refresh(); }
        else showLanding();
    } catch (err) {
        showLanding();
        notify(err.message, true);
    }
})();

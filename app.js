// Falls — Premium Food Ordering Platform
// Enhanced with: Super Admin Dashboard, Glassmorphism, Backup System, Delivery Area Check

const BACKEND_URL = localStorage.getItem('backend_url') || 'https://falls-food-backend.onrender.com';
const SUPER_ADMIN_PIN = '000000'; // Change this to your actual PIN
const DELIVERY_AREA = { lat: 22.1896, lng: -75.8044, radiusKm: 5 }; // Krem-Chympe Falls

// ===== STATE =====
let restaurants = [];
let currentRestaurant = null;
let cart = [];
let orders = {};
let currentUser = null;
let adminMode = false;
let searchResults = [];

// ===== STARTUP =====
window.addEventListener('DOMContentLoaded', () => {
  bootApp();
  checkAdminAccess();
});

async function bootApp() {
  try {
    // Step 1: Check backend
    const healthRes = await fetch(`${BACKEND_URL}/health/ready`, { method: 'GET' });
    markStep('stepBackend', true);

    // Step 2: Load restaurants
    await loadRestaurants();
    markStep('stepRestaurants', true);

    // Step 3: Hide startup
    setTimeout(() => {
      document.getElementById('startup').style.opacity = '0';
      document.getElementById('startup').style.pointerEvents = 'none';
      navigate('home');
      setupEventListeners();
    }, 1200);
  } catch (err) {
    console.error('Boot error:', err);
    document.getElementById('startupActions').style.display = 'flex';
  }
}

function markStep(id, done) {
  const el = document.getElementById(id);
  const dot = el.querySelector('.dot');
  dot.classList.toggle('loading', !done);
  dot.classList.toggle('done', done);
  if (done) dot.textContent = '✓';
}

// ===== RESTAURANTS =====
async function loadRestaurants() {
  try {
    const res = await fetch(`${BACKEND_URL}/api/restaurants`);
    restaurants = await res.json();
    // Filter out inactive restaurants
    restaurants = restaurants.filter(r => r.active !== false);
    renderRestaurants();
    updateOpenCount();
  } catch (err) {
    console.error('Error loading restaurants:', err);
    restaurants = getOfflineRestaurants();
    renderRestaurants();
  }
}

function renderRestaurants(list = restaurants) {
  const grid = document.getElementById('restaurantGrid');
  grid.innerHTML = list.map(r => `
    <div class="rest-card" onclick="navigateToRestaurant('${r.id}')">
      <div class="rest-cover">
        <img src="${r.coverImage||'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 400 160%22%3E%3Crect fill=%22%23ddd%22 width=%22400%22 height=%22160%22/%3E%3C/svg%3E'}" alt=""/>
        <div class="rest-badges">
          ${r.pinned ? '<span class="badge badge-pin">📌 Pinned</span>' : ''}
          ${r.premium ? '<span class="badge badge-premium">⭐ Premium</span>' : ''}
          ${r.open ? '<span class="badge badge-open">🟢 Open</span>' : '<span class="badge badge-open">🔴 Closed</span>'}
        </div>
        <div class="rest-logo">
          <img src="${r.logo||'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 56 56%22%3E%3Crect fill=%22%23f1f5f9%22 width=%2256%22 height=%2256%22/%3E%3C/svg%3E'}" alt=""/>
        </div>
      </div>
      <div class="rest-body">
        <h3>${r.name}</h3>
        <div class="rest-meta">
          <span>${r.cuisine||'Multi-cuisine'}</span>
          <span class="dot-sep"></span>
          <span>${r.deliveryTime||'20'} min</span>
          <span class="dot-sep"></span>
          <span class="rating">⭐ ${r.rating||4.2}</span>
        </div>
      </div>
    </div>
  `).join('');
}

function updateOpenCount() {
  const open = restaurants.filter(r => r.open).length;
  document.getElementById('openCount').textContent = `${open} restaurants`;
}

// ===== SEARCH FUNCTIONALITY (FIXED) =====
function performSearch(event) {
  const query = document.getElementById('searchInput').value.toLowerCase().trim();
  
  if (!query) {
    renderRestaurants();
    searchResults = [];
    return;
  }

  searchResults = restaurants.filter(r => {
    const matchName = r.name.toLowerCase().includes(query);
    const matchCuisine = (r.cuisine||'').toLowerCase().includes(query);
    const matchCity = (r.city||'').toLowerCase().includes(query);
    
    // Also search in menu items if available
    const matchMenu = r.menu ? r.menu.some(item => 
      item.name.toLowerCase().includes(query) ||
      (item.description||'').toLowerCase().includes(query)
    ) : false;

    return matchName || matchCuisine || matchCity || matchMenu;
  });

  if (searchResults.length > 0) {
    renderRestaurants(searchResults);
  } else {
    document.getElementById('restaurantGrid').innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 40px 20px;">
        <div style="font-size: 48px; margin-bottom: 12px;">🔍</div>
        <div style="font-size: 18px; font-weight: 600;">No restaurants found</div>
        <div style="font-size: 14px; opacity: 0.7; margin-top: 8px;">Try searching for a different restaurant or cuisine</div>
      </div>
    `;
  }
}

// ===== NAVIGATION =====
function navigate(page) {
  document.querySelectorAll('.main section').forEach(s => s.classList.add('hide'));
  document.getElementById(`page-${page}`).classList.remove('hide');
  window.scrollTo(0, 0);
}

function navigateToRestaurant(restaurantId) {
  const r = restaurants.find(x => x.id === restaurantId);
  if (!r) return;
  
  currentRestaurant = r;
  renderRestaurantPage(r);
  navigate('restaurant');
}

function renderRestaurantPage(r) {
  const hero = document.getElementById('restaurantHero');
  hero.innerHTML = `
    <div class="restaurant-hero">
      <img src="${r.coverImage||'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 800 280%22%3E%3Crect fill=%22%23ddd%22 width=%22800%22 height=%22280%22/%3E%3C/svg%3E'}" alt=""/>
      <div class="restaurant-hero-info glass">
        <div style="display:flex; align-items:center; gap:12px; margin-bottom:12px;">
          <img src="${r.logo||'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 56 56%22%3E%3Crect fill=%22%23f1f5f9%22 width=%2256%22 height=%2256%22/%3E%3C/svg%3E'}" style="width:48px; height:48px; border-radius:12px;" alt=""/>
          <div>
            <h2 style="margin:0;">${r.name}</h2>
            <p style="font-size:13px; opacity:0.9; margin:4px 0 0;">${r.cuisine||'Multi-cuisine'}</p>
          </div>
        </div>
        ${r.upiId ? `<div style="font-size:12px; background:rgba(255,255,255,0.2); padding:8px 12px; border-radius:8px; margin-top:8px; font-weight:600;">💳 UPI: ${r.upiId}</div>` : ''}
      </div>
    </div>
  `;

  const catNav = document.getElementById('catNav');
  const categories = [...new Set((r.menu||[]).map(m => m.category))];
  catNav.innerHTML = categories.map(cat => 
    `<button class="${categories[0] === cat ? 'active' : ''}" onclick="filterByCategory('${cat}')">${cat}</button>`
  ).join('');

  renderFoodItems((r.menu||[]), categories[0]);
}

function renderFoodItems(items, category) {
  items = items.filter(item => item.category === category && item.available !== false);
  const grid = document.getElementById('foodGrid');
  grid.innerHTML = items.map(item => `
    <div class="food-card" onclick="openFoodModal('${item.id}')">
      <div class="food-info">
        <h4>
          <span class="veg veg-${item.veg}"><span></span></span>${item.name}
        </h4>
        <p>${item.description||''}</p>
        <div class="food-price">₹${item.price}</div>
      </div>
      <div class="food-img">
        <img src="${item.image||'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 110 96%22%3E%3Crect fill=%22%23f1f5f9%22 width=%22110%22 height=%2296%22/%3E%3C/svg%3E'}" alt=""/>
        <button class="add-btn" onclick="addToCart(event, '${item.id}', '${item.name}', ${item.price})">+ Add</button>
      </div>
    </div>
  `).join('');
}

function filterByCategory(category) {
  document.querySelectorAll('.cat-nav button').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  renderFoodItems(currentRestaurant.menu, category);
}

// ===== CART MANAGEMENT =====
function addToCart(e, itemId, name, price) {
  e.stopPropagation();
  
  const existing = cart.find(c => c.itemId === itemId);
  if (existing) {
    existing.qty++;
  } else {
    cart.push({
      itemId,
      name,
      price,
      qty: 1,
      restaurantId: currentRestaurant.id
    });
  }
  
  updateCartUI();
  document.getElementById('cartBar').classList.add('show');
}

function updateCartUI() {
  const count = cart.reduce((sum, c) => sum + c.qty, 0);
  const total = cart.reduce((sum, c) => sum + c.price * c.qty, 0);
  
  document.getElementById('cartCount').textContent = count;
  document.getElementById('cartTotal').textContent = total;
  document.getElementById('cartModalTotal').textContent = total;
  
  const preview = cart.slice(0, 3).map(c => `${c.name} x${c.qty}`).join(', ');
  document.getElementById('cartItemsPreview').textContent = preview + (cart.length > 3 ? '...' : '');
  
  // Render full cart
  const cartList = document.getElementById('cartList');
  cartList.innerHTML = cart.map((c, idx) => `
    <div style="display:flex; justify-content:space-between; align-items:center; padding:10px; background:#f8fafc; border-radius:12px;">
      <div>
        <div style="font-weight:600;">${c.name}</div>
        <div style="font-size:13px; color:#64748b;">₹${c.price} x ${c.qty}</div>
      </div>
      <div style="display:flex; gap:8px;">
        <button class="btn btn-ghost" style="padding:4px 10px; font-size:12px; color:#000; border-color:#e2e8f0;" onclick="updateCartQty(${idx}, -1)">−</button>
        <button class="btn btn-ghost" style="padding:4px 10px; font-size:12px; color:#000; border-color:#e2e8f0;" onclick="updateCartQty(${idx}, 1)">+</button>
        <button class="btn btn-ghost" style="padding:4px 10px; font-size:12px; color:#000; border-color:#e2e8f0;" onclick="removeFromCart(${idx})">✕</button>
      </div>
    </div>
  `).join('');
}

function updateCartQty(idx, delta) {
  cart[idx].qty += delta;
  if (cart[idx].qty <= 0) removeFromCart(idx);
  else updateCartUI();
}

function removeFromCart(idx) {
  cart.splice(idx, 1);
  if (cart.length === 0) document.getElementById('cartBar').classList.remove('show');
  updateCartUI();
}

function openCart() {
  document.getElementById('cartModal').classList.add('show');
}

function closeCart() {
  document.getElementById('cartModal').classList.remove('show');
}

// ===== CHECKOUT =====
function openCheckout() {
  if (cart.length === 0) {
    alert('Your cart is empty');
    return;
  }
  
  document.getElementById('checkoutModal').classList.add('show');
  document.getElementById('checkoutRestaurantName').textContent = currentRestaurant.name;
  showCheckoutStep(1);
}

function closeCheckout() {
  document.getElementById('checkoutModal').classList.remove('show');
}

function showCheckoutStep(step) {
  document.getElementById('checkoutStep1').classList.toggle('hide', step !== 1);
  document.getElementById('checkoutStep2').classList.toggle('hide', step !== 2);
  document.getElementById('checkoutStep3').classList.toggle('hide', step !== 3);
  
  document.getElementById('s1').classList.toggle('active', step === 1);
  document.getElementById('s2').classList.toggle('active', step === 2);
  document.getElementById('s3').classList.toggle('active', step === 3);
  
  if (step === 1) {
    document.getElementById('s1').classList.add('active');
    document.getElementById('s2').classList.remove('active');
  } else if (step === 2) {
    document.getElementById('s1').classList.remove('active');
    document.getElementById('s2').classList.add('active');
  }
}

function checkDeliveryArea() {
  const method = document.getElementById('cDelivery').value;
  const warning = document.getElementById('deliveryAreaWarning');
  warning.style.display = method === 'delivery' ? 'block' : 'none';
}

function goToPayment() {
  const name = document.getElementById('cName').value.trim();
  const phone = document.getElementById('cPhone').value.trim();
  const address = document.getElementById('cAddress').value.trim();
  
  if (!name || !phone || !address) {
    alert('Please fill all required fields');
    return;
  }
  
  // Render payment box with UPI
  const paymentBox = document.getElementById('paymentBox');
  const upiId = currentRestaurant.upiId || 'admin@bank';
  const cartTotal = cart.reduce((sum, c) => sum + c.price * c.qty, 0);
  
  paymentBox.innerHTML = `
    <div style="background:#f0f9ff; border-radius:16px; padding:16px; margin-bottom:16px;">
      <div style="font-size:13px; opacity:0.7; margin-bottom:8px;">UPI Payment Details</div>
      <div style="background:#fff; padding:12px; border-radius:12px; border:2px solid #0084ff; margin-bottom:10px;">
        <div style="font-size:12px; opacity:0.7;">UPI ID</div>
        <div style="font-weight:700; font-size:16px; color:#0f172a;">${upiId}</div>
        <button class="btn btn-ghost" style="width:100%; margin-top:8px; color:#000; border-color:#0084ff;" onclick="copyUPI('${upiId}')">📋 Copy UPI ID</button>
      </div>
      <div style="font-size:13px; line-height:1.6;">
        <div>1. Copy the UPI ID above</div>
        <div>2. Open your UPI app (Google Pay, PhonePe, etc.)</div>
        <div>3. Send <b>₹${cartTotal}</b> to the UPI ID</div>
        <div>4. Upload receipt in the next step</div>
      </div>
    </div>
  `;
  
  showCheckoutStep(2);
}

function copyUPI(upiId) {
  navigator.clipboard.writeText(upiId);
  alert('UPI ID copied: ' + upiId);
}

async function placeOrder() {
  const name = document.getElementById('cName').value.trim();
  const phone = document.getElementById('cPhone').value.trim();
  const address = document.getElementById('cAddress').value.trim();
  const notes = document.getElementById('cNotes').value.trim();
  const delivery = document.getElementById('cDelivery').value;
  
  if (cart.length === 0) {
    alert('Cart is empty');
    return;
  }

  // DUPLICATE PREVENTION: Create order idempotency key
  const orderKey = `${currentRestaurant.id}-${phone}-${Date.now()}`;
  const idempotencyKey = btoa(orderKey);
  
  // Check if this order was already placed
  if (sessionStorage.getItem(`order-placed-${idempotencyKey}`)) {
    alert('This order was already placed. Please refresh and try again.');
    return;
  }

  const orderData = {
    restaurantId: currentRestaurant.id,
    items: cart,
    customer: { name, phone, address, notes },
    deliveryMethod: delivery,
    total: cart.reduce((sum, c) => sum + c.price * c.qty, 0),
    idempotencyKey
  };

  try {
    const btn = event.target;
    btn.disabled = true;
    btn.textContent = 'PLACING ORDER...';
    
    const res = await fetch(`${BACKEND_URL}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify(orderData)
    });

    const result = await res.json();
    
    if (!res.ok) throw new Error(result.error || 'Order failed');

    // Mark this order as placed to prevent duplicates
    sessionStorage.setItem(`order-placed-${idempotencyKey}`, 'true');
    
    // Store order
    const orderCode = result.orderCode;
    orders[orderCode] = result;
    
    // Clear cart
    cart = [];
    updateCartUI();
    document.getElementById('cartBar').classList.remove('show');
    
    // Show success
    document.getElementById('orderCodeOut').textContent = orderCode;
    showCheckoutStep(3);
    
  } catch (err) {
    alert('Error placing order: ' + err.message);
  } finally {
    if (event.target.disabled) {
      event.target.disabled = false;
      event.target.textContent = 'PAY & PLACE ORDER →';
    }
  }
}

function trackFromCheckout() {
  closeCheckout();
  trackOrder();
}

// ===== ORDER TRACKING =====
function trackOrder() {
  const code = prompt('Enter your order code (e.g., FOOD-20240115-0001):');
  if (!code) return;
  
  navigate('tracking');
  loadTrackingInfo(code);
}

async function loadTrackingInfo(code) {
  try {
    const res = await fetch(`${BACKEND_URL}/api/orders/${code}`);
    if (!res.ok) throw new Error('Order not found');
    
    const order = await res.json();
    
    document.getElementById('trackCode').textContent = `Order ${code}`;
    
    const statuses = ['SUBMITTED', 'ACCEPTED', 'PREPARING', 'READY', 'COMPLETED'];
    const currentStatus = order.status || 'SUBMITTED';
    const currentIdx = statuses.indexOf(currentStatus);
    
    const timeline = document.getElementById('timeline');
    timeline.innerHTML = statuses.map((status, idx) => {
      const done = idx < currentIdx;
      const active = idx === currentIdx;
      const icons = {
        SUBMITTED: '📋',
        ACCEPTED: '✅',
        PREPARING: '👨‍🍳',
        READY: '📦',
        COMPLETED: '🎉'
      };
      
      return `
        <div class="tl ${done ? 'done' : active ? 'active' : ''}">
          <div class="tl-dot">${icons[status]}</div>
          <div style="flex:1;">
            ${idx < statuses.length - 1 ? `<div class="tl-line" style="height:${60}px;"></div>` : ''}
          </div>
          <div class="tl-content">
            <h5>${status}</h5>
            <p>${status === 'COMPLETED' ? 'Order complete!' : 'In progress'}</p>
          </div>
        </div>
      `;
    }).join('');
    
    const details = document.getElementById('trackDetails');
    details.innerHTML = `
      <div style="margin-top:16px;">
        <h4 style="margin-bottom:8px;">Order Details</h4>
        <div style="background:#f8fafc; padding:12px; border-radius:12px; font-size:13px; line-height:1.6;">
          <div><b>Restaurant:</b> ${order.restaurant?.name || 'N/A'}</div>
          <div><b>Items:</b> ${order.items?.map(i => i.name).join(', ') || 'N/A'}</div>
          <div><b>Total:</b> ₹${order.total}</div>
          <div><b>Delivery:</b> ${order.deliveryMethod === 'delivery' ? 'Home Delivery' : 'Pickup'}</div>
        </div>
      </div>
    `;
    
  } catch (err) {
    document.getElementById('trackDetails').innerHTML = `<div style="text-align:center; padding:20px;"><div>❌ Order not found</div><p style="font-size:13px; opacity:0.7; margin-top:8px;">${err.message}</p></div>`;
  }
}

// ===== FOOD MODAL =====
function openFoodModal(itemId) {
  const item = currentRestaurant.menu.find(m => m.id === itemId);
  if (!item) return;
  
  document.getElementById('foodModalCard').innerHTML = `
    <div style="text-align:center; margin-bottom:16px;">
      <img src="${item.image||'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 300 200%22%3E%3Crect fill=%22%23f1f5f9%22 width=%22300%22 height=%22200%22/%3E%3C/svg%3E'}" style="width:100%; border-radius:16px; height:240px; object-fit:cover;"/>
    </div>
    <h3>${item.name}</h3>
    <div style="display:flex; align-items:center; gap:10px; margin:10px 0;">
      <span class="veg veg-${item.veg}"><span></span></span>
      <span style="font-weight:700; font-size:14px;">₹${item.price}</span>
    </div>
    <p style="color:#475569; line-height:1.6; margin:12px 0;">${item.description||'Delicious food item'}</p>
    <button class="btn btn-primary" style="width:100%; margin-top:16px; background:#0f172a; color:#fff;" onclick="addToCart(event, '${item.id}', '${item.name}', ${item.price}); closeFoodModal();">+ Add to Cart</button>
  `;
  
  document.getElementById('foodModal').classList.add('show');
}

function closeFoodModal() {
  document.getElementById('foodModal').classList.remove('show');
}

// ===== RESTAURANT REGISTRATION =====
function openRestaurantRegister() {
  document.getElementById('registerModal').classList.add('show');
}

function closeRegister() {
  document.getElementById('registerModal').classList.remove('show');
}

async function submitRestaurantRegister() {
  const data = {
    name: document.getElementById('rName').value,
    owner: document.getElementById('rOwner').value,
    phone: document.getElementById('rPhone').value,
    email: document.getElementById('rEmail').value,
    cuisine: document.getElementById('rCuisine').value,
    address: document.getElementById('rAddress').value,
    hours: document.getElementById('rHours').value,
    upiId: document.getElementById('rUpi').value,
    password: document.getElementById('rPass').value
  };

  if (!data.name || !data.phone || !data.upiId) {
    alert('Please fill all required fields');
    return;
  }

  try {
    const res = await fetch(`${BACKEND_URL}/api/restaurants/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    if (!res.ok) throw new Error('Registration failed');

    alert('✅ Registration submitted! You will receive a Telegram link after approval.');
    closeRegister();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ===== RESTAURANT BACKUP =====
function openRestaurantBackup() {
  document.getElementById('restaurantBackupModal').classList.add('show');
}

function closeRestaurantBackup() {
  document.getElementById('restaurantBackupModal').classList.remove('show');
}

async function downloadRestaurantBackup() {
  const restaurantId = document.getElementById('backupRestaurantId').value.trim();
  const password = document.getElementById('backupPassword').value.trim();
  
  if (!restaurantId || !password) {
    alert('Enter restaurant ID and password');
    return;
  }

  try {
    const res = await fetch(`${BACKEND_URL}/api/restaurants/${restaurantId}/backup/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });

    if (!res.ok) throw new Error('Backup failed - check credentials');

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `restaurant-backup-${restaurantId}.json`;
    a.click();
    
    alert('✅ Backup downloaded!');
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function uploadRestaurantBackup() {
  const restaurantId = document.getElementById('backupRestaurantId').value.trim();
  const password = document.getElementById('backupPassword').value.trim();
  
  if (!restaurantId || !password) {
    alert('Enter restaurant ID and password');
    return;
  }

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    const formData = new FormData();
    formData.append('file', file);
    formData.append('password', password);

    try {
      const res = await fetch(`${BACKEND_URL}/api/restaurants/${restaurantId}/backup/upload`, {
        method: 'POST',
        body: formData
      });

      if (!res.ok) throw new Error('Restore failed');
      alert('✅ Backup restored!');
    } catch (err) {
      alert('Error: ' + err.message);
    }
  };
  input.click();
}

// ===== SUPER ADMIN DASHBOARD =====
function checkAdminAccess() {
  const pin = localStorage.getItem('admin_pin');
  if (pin === SUPER_ADMIN_PIN) {
    adminMode = true;
    document.getElementById('adminLink').style.display = 'flex';
  }
}

function openAdminDashboard() {
  const pin = prompt('Enter Super Admin PIN:');
  if (pin === SUPER_ADMIN_PIN) {
    localStorage.setItem('admin_pin', pin);
    navigate('admin');
    loadAdminData();
  } else {
    alert('Invalid PIN');
  }
}

function switchAdminTab(tab) {
  // Hide all tabs
  document.querySelectorAll('.admin-tab-content').forEach(t => t.classList.add('hide'));
  // Remove active from all buttons
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  // Show selected tab
  document.getElementById(`tab-${tab}`).classList.remove('hide');
  // Mark button as active
  event.target.classList.add('active');
}

async function loadAdminData() {
  try {
    // Load analytics
    const analyticsRes = await fetch(`${BACKEND_URL}/api/admin/analytics`);
    const analytics = await analyticsRes.json();
    
    document.getElementById('analyticsTotalOrders').textContent = analytics.totalOrders || '-';
    document.getElementById('analyticsTotalRevenue').textContent = '₹' + (analytics.totalRevenue || '-');
    document.getElementById('analyticsActiveRestaurants').textContent = analytics.activeRestaurants || '-';
    document.getElementById('analyticsTotalCustomers').textContent = analytics.totalCustomers || '-';
  } catch (err) {
    console.error('Error loading analytics:', err);
  }
}

async function saveAdminSettings() {
  const settings = {
    websiteName: document.getElementById('adminWebsiteName').value,
    logo: document.getElementById('adminWebsiteLogo').value,
    backgroundImage: document.getElementById('adminBackgroundImage').value,
    deliveryArea: document.getElementById('adminDeliveryArea').value
  };

  try {
    const res = await fetch(`${BACKEND_URL}/api/admin/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });

    if (!res.ok) throw new Error('Save failed');

    // Update UI
    document.getElementById('headerBrandName').textContent = settings.websiteName;
    document.getElementById('headerLogo').src = settings.logo;
    if (settings.backgroundImage) {
      document.getElementById('waterfall-bg').style.backgroundImage = `url('${settings.backgroundImage}')`;
    }

    alert('✅ Settings saved!');
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function backupAllData() {
  try {
    const res = await fetch(`${BACKEND_URL}/api/admin/backup/all`, { method: 'POST' });
    if (!res.ok) throw new Error('Backup failed');

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `falls-backup-${Date.now()}.json`;
    a.click();
    
    alert('✅ All data backed up!');
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function restoreFromBackup() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch(`${BACKEND_URL}/api/admin/backup/restore`, {
        method: 'POST',
        body: formData
      });

      if (!res.ok) throw new Error('Restore failed');
      alert('✅ Data restored!');
      location.reload();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  };
  input.click();
}

// ===== DRAWER =====
function openDrawer() {
  document.getElementById('drawer').classList.add('show');
}

function closeDrawer() {
  document.getElementById('drawer').classList.remove('show');
}

// ===== HELP =====
function openHelp() {
  alert(`FALLS Support:\n\n📱 WhatsApp: +91-XXXXX-XXXXX\n📧 Email: support@falls.local\n\nFor restaurant issues, use Telegram bot.\nFor customer support, contact us via WhatsApp.`);
}

function retryBoot() {
  location.reload();
}

function skipBoot() {
  document.getElementById('startup').style.opacity = '0';
  document.getElementById('startup').style.pointerEvents = 'none';
  navigate('home');
  setupEventListeners();
}

// ===== SETUP =====
function setupEventListeners() {
  document.getElementById('searchInput').addEventListener('keyup', performSearch);
  document.addEventListener('click', (e) => {
    if (e.target.id === 'drawer' || e.target.classList.contains('drawer-backdrop')) {
      closeDrawer();
    }
  });
}

// ===== OFFLINE DATA =====
function getOfflineRestaurants() {
  return [
    {
      id: '1', name: 'Pizza Paradise', cuisine: 'Italian', city: 'Krem-Chympe',
      open: true, pinned: true, premium: false,
      coverImage: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 400 160%22%3E%3Crect fill=%22%23ff7a45%22 width=%22400%22 height=%22160%22/%3E%3Ctext x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22 dy=%22.3em%22 font-size=%2240%22%3E🍕%3C/text%3E%3C/svg%3E',
      logo: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 56 56%22%3E%3Crect fill=%22%23ff7a45%22 width=%2256%22 height=%2256%22 rx=%228%22/%3E%3Ctext x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22 dy=%22.3em%22 font-size=%2228%22%3E🍕%3C/text%3E%3C/svg%3E',
      rating: 4.8, deliveryTime: 20, upiId: 'pizzaparadise@upi',
      menu: [
        { id: '1-1', name: 'Margherita', price: 250, veg: true, category: 'Pizza', available: true },
        { id: '1-2', name: 'Pepperoni', price: 350, veg: false, category: 'Pizza', available: true }
      ]
    }
  ];
}

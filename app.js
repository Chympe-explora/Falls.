
// CONFIG - CHANGE THIS TO YOUR RENDER URL
const BACKEND_URL = localStorage.getItem('backend_url') || 'https://falls-food-backend.onrender.com';
// For local dev, set localStorage backend_url to http://localhost:10000
// localStorage.setItem('backend_url','http://localhost:10000')

let restaurants = [];
let currentRestaurant = null;
let cart = JSON.parse(localStorage.getItem('cart')||'[]');
let currentOrderCode = null;
let backendReady = false;

const $ = s=>document.querySelector(s);
const $$ = s=>document.querySelectorAll(s);

// STARTUP FLOW: GitHub -> animation -> check Render -> load restaurants
async function boot(){
  const stepBackend = $('#stepBackend');
  const stepRest = $('#stepRestaurants');
  const actions = $('#startupActions');
  try{
    // 1 website loaded already
    // 2 check backend
    stepBackend.innerHTML = '<span class="dot loading"></span><span>Connecting to ordering service</span>';
    let ready = false;
    let attempts = 0;
    const maxAttempts = 25; // Render cold start can take 60s
    while(attempts < maxAttempts && !ready){
      try{
        const res = await fetch(`${BACKEND_URL}/health/ready`, {cache:'no-store'});
        if(res.ok){
          const data = await res.json();
          if(data.status === 'ready' || data.status === 'degraded'){
            ready = true;
            backendReady = true;
            $('#backendStatus').textContent = '🟢 Ready ('+BACKEND_URL+')';
            stepBackend.innerHTML = '<span class="dot done">✓</span><span>Ordering service connected</span>';
            break;
          }
        }
      }catch(e){}
      attempts++;
      // polling
      await new Promise(r=>setTimeout(r, attempts<5?1200:2500));
    }
    if(!ready){
      stepBackend.innerHTML = '<span class="dot" style="background:#ff4d5a;color:#fff">!</span><span>Ordering service is temporarily unavailable</span>';
      actions.style.display='flex';
      $('#backendStatus').textContent = '🔴 Unavailable';
      return;
    }
    // 3 restaurants
    stepRest.innerHTML = '<span class="dot loading"></span><span>Checking restaurant availability</span>';
    await loadRestaurants();
    stepRest.innerHTML = '<span class="dot done">✓</span><span>Ready • '+restaurants.length+' restaurants</span>';
    // small delay for premium feel
    await new Promise(r=>setTimeout(r, 600));
    closeStartup();
  }catch(e){
    console.error(e);
    $('#stepBackend').innerHTML = '<span class="dot">!</span><span>Failed</span>';
    $('#startupActions').style.display='flex';
  }
}
function closeStartup(){
  const el = $('#startup');
  el.style.opacity='0';
  el.style.transform='scale(1.04)';
  setTimeout(()=>{ el.style.display='none'; }, 700);
}
function retryBoot(){ $('#startupActions').style.display='none'; boot(); }
function skipBoot(){ closeStartup(); loadRestaurantsOffline(); }

function loadRestaurantsOffline(){
  // fallback demo data if backend down
  $('#restaurantGrid').innerHTML = '<div class="glass-strong" style="padding:20px;border-radius:20px;">Backend offline — showing cached preview. Set backend URL in console: localStorage.setItem("backend_url","http://localhost:10000")</div>';
}

// CATEGORIES
const globalCategories = [
  {id:'all', name:'All', emoji:'✨'},
  {id:'burgers', name:'Burgers', emoji:'🍔'},
  {id:'pizza', name:'Pizza', emoji:'🍕'},
  {id:'noodles', name:'Noodles', emoji:'🍜'},
  {id:'chicken', name:'Chicken', emoji:'🍗'},
  {id:'veg', name:'Vegetarian', emoji:'🥗'},
  {id:'snacks', name:'Snacks', emoji:'🍟'},
  {id:'desserts', name:'Desserts', emoji:'🍰'},
  {id:'drinks', name:'Drinks', emoji:'🥤'},
];

function renderCategories(){
  const wrap = $('#categoryChips');
  wrap.innerHTML = globalCategories.map(c=>`<div class="chip ${c.id==='all'?'active':''}" onclick="filterByCategory('${c.id}', this)">${c.emoji} ${c.name}</div>`).join('');
}
function filterByCategory(cat, el){
  $$('.chip').forEach(ch=>ch.classList.remove('active'));
  if(el) el.classList.add('active');
  if(cat==='all') renderRestaurants(restaurants);
  else {
    const filtered = restaurants.filter(r=> r.cuisine.toLowerCase().includes(cat) || r.name.toLowerCase().includes(cat));
    // if no match, keep all but show search on items
    renderRestaurants(filtered.length?filtered:restaurants);
  }
}

// RESTAURANTS
async function loadRestaurants(){
  try{
    const res = await fetch(`${BACKEND_URL}/api/restaurants`);
    if(!res.ok) throw new Error('bad');
    restaurants = await res.json();
    $('#openCount').textContent = restaurants.filter(r=>r.isOpen).length + ' open';
    renderRestaurants(restaurants);
  }catch(e){
    console.error(e);
    // fallback if backend not reachable yet - use empty
    $('#restaurantGrid').innerHTML = '<div class="glass" style="padding:20px;border-radius:20px;">Failed to load restaurants. <button class="btn btn-primary" onclick="loadRestaurants()">Retry</button></div>';
  }
}
function renderRestaurants(list){
  const grid = $('#restaurantGrid');
  if(!list.length){ grid.innerHTML='<div class="glass" style="padding:24px;border-radius:20px;">No restaurants found</div>'; return; }
  grid.innerHTML = list.map(r=>`
    <div class="rest-card glass-strong" onclick="openRestaurant('${r.id}')">
      <div class="rest-cover"><img src="${r.coverUrl||'https://picsum.photos/seed/'+r.id+'/600/400'}" loading="lazy"/>
        <div class="rest-badges">
          ${r.isPinned?'<span class="badge badge-pin">📌 PINNED</span>':''}
          ${r.isHighlighted?'<span class="badge badge-highlight">✨ HIGHLIGHT</span>':''}
          <span class="badge badge-open">${r.isOpen?'🟢 Open':'🔴 Closed'}${r.isBusy?' • Busy':''}</span>
        </div>
        <div class="rest-logo"><img src="${r.logoUrl||'https://picsum.photos/seed/'+r.id+'logo/200/200'}"/></div>
      </div>
      <div class="rest-body">
        <div style="display:flex; justify-content:space-between; gap:8px;"><h3>${r.name}</h3><span class="rating">★ ${r.rating}</span></div>
        <div class="rest-meta"><span>${r.cuisine}</span><span class="dot-sep"></span><span>${r.deliveryTime}</span></div>
        <div class="rest-meta" style="margin-top:8px;"><span>₹${r.deliveryFee} delivery</span><span class="dot-sep"></span><span>Min ₹${r.minOrder}</span><span class="dot-sep"></span><span>${r.city}</span></div>
      </div>
    </div>
  `).join('');
}

// SEARCH
let searchTimeout;
$('#searchInput').addEventListener('input', (e)=>{
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(async ()=>{
    const q = e.target.value.trim();
    if(!q){ renderRestaurants(restaurants); return; }
    try{
      const res = await fetch(`${BACKEND_URL}/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if(data.restaurants && data.restaurants.length){
        renderRestaurants(data.restaurants);
      } else if(data.items){
        // show items as restaurant cards filtered
        const restIds = [...new Set(data.items.map(i=>i.restaurantId))];
        const filtered = restaurants.filter(r=> restIds.includes(r.id));
        renderRestaurants(filtered);
      }
    }catch{}
  }, 350);
});

// RESTAURANT PAGE
async function openRestaurant(id){
  try{
    const res = await fetch(`${BACKEND_URL}/api/restaurants/${id}`);
    const data = await res.json();
    currentRestaurant = data;
    // cart reset if different restaurant?
    if(cart.length && cart[0].restaurantId !== id){
      if(!confirm('Cart has items from another restaurant. Clear cart?')) return;
      cart = []; saveCart();
    }
    navigate('restaurant');
    // hero
    $('#restaurantHero').innerHTML = `
      <div class="restaurant-hero glass-strong">
        <img src="${data.coverUrl}"/>
        <div class="restaurant-hero-info glass">
          <div style="display:flex; gap:12px; align-items:center;">
            <img src="${data.logoUrl}" style="width:56px;height:56px;border-radius:16px; border:2px solid #fff;"/>
            <div>
              <h2 style="font-family:Fraunces; font-size:24px;">${data.name}</h2>
              <div style="font-size:13px; opacity:0.9;">${data.cuisine} • ${data.rating}★ • ${data.deliveryTime}</div>
              <div style="font-size:12px; margin-top:4px;">${data.isOpen?'🟢 Open':'🔴 Closed'} • ${data.openingHours} • ₹${data.deliveryFee} delivery</div>
            </div>
          </div>
        </div>
      </div>
    `;
    // categories nav
    const cats = data.categories || [];
    $('#catNav').innerHTML = '<div style="font-weight:700; margin-bottom:8px;">Menu</div>' + cats.map((c,i)=>`<button class="${i===0?'active':''}" onclick="scrollToCat('${c.id}', this)">${c.emoji||'🍽️'} ${c.name}</button>`).join('') + `<div style="margin-top:12px; font-size:12px; opacity:0.7;">${data.description||''}</div>`;
    // food grid grouped
    let html='';
    cats.forEach(cat=>{
      const items = (data.items||[]).filter(it=>it.categoryId===cat.id);
      html += `<div id="cat-${cat.id}" style="margin-top:18px;"><h3 style="font-family:Fraunces; font-size:20px; margin-bottom:10px;">${cat.name}</h3><div class="food-grid">`+
        items.map(item=>`
          <div class="food-card glass-strong" onclick="openFood('${item.id}')">
            <div class="food-info">
              <div style="display:flex; align-items:center;"><span class="veg ${item.isVeg?'veg-true':'veg-false'}"><span></span></span><h4>${item.name}</h4></div>
              <p>${item.description||''}</p>
              <div class="food-price">₹${item.price}</div>
              <div style="font-size:11px; color:#64748b; margin-top:2px;">${item.prepTime||''} • ${item.isAvailable?'Available':'Sold out'}</div>
            </div>
            <div class="food-img"><img src="${item.imageUrl}" loading="lazy"/><button class="add-btn" onclick="event.stopPropagation(); addToCart('${item.id}')">${getCartQty(item.id)?'ADD +'+getCartQty(item.id):'ADD'}</button></div>
          </div>
        `).join('')+
      `</div></div>`;
    });
    $('#foodGrid').innerHTML = html || '<div class="glass-strong" style="padding:20px;border-radius:20px;">No menu yet</div>';
  }catch(e){ console.error(e); }
}
function scrollToCat(catId, btn){
  $$('#catNav button').forEach(b=>b.classList.remove('active'));
  if(btn) btn.classList.add('active');
  document.getElementById('cat-'+catId)?.scrollIntoView({behavior:'smooth', block:'start'});
}

// FOOD DETAIL
function openFood(itemId){
  const item = currentRestaurant?.items?.find(i=>i.id===itemId) || restaurants.flatMap(r=>[]).find(()=>false);
  // find from currentRestaurant
  const it = currentRestaurant?.items?.find(x=>x.id===itemId);
  if(!it) return;
  $('#foodModalCard').innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:start; gap:12px;"><h3>${it.name}</h3><button class="btn btn-ghost" style="color:#000;border-color:#e2e8f0;" onclick="closeFoodModal()">✕</button></div>
    <img src="${it.imageUrl}" style="width:100%; height:220px; object-fit:cover; border-radius:16px; margin-top:12px;"/>
    <p style="margin-top:12px; color:#475569; font-size:14px; line-height:1.6;">${it.description}</p>
    <div style="margin-top:12px; display:flex; justify-content:space-between; align-items:center;"><b>₹${it.price}</b><button class="btn btn-primary" style="background:#0f172a;color:#fff;" onclick="addToCart('${it.id}'); closeFoodModal();">Add to cart</button></div>
  `;
  $('#foodModal').classList.add('show');
}
function closeFoodModal(){ $('#foodModal').classList.remove('show'); }

// CART
function getCartQty(itemId){ const f=cart.find(c=>c.id===itemId); return f?f.qty:0; }
function addToCart(itemId){
  const item = currentRestaurant?.items?.find(i=>i.id===itemId);
  if(!item) return;
  if(!item.isAvailable){ alert('Sold out'); return; }
  const existing = cart.find(c=>c.id===itemId);
  if(existing) existing.qty++;
  else cart.push({id:item.id, name:item.name, price:item.price, qty:1, restaurantId: currentRestaurant.id, isVeg:item.isVeg});
  saveCart();
  // update buttons
  if(currentRestaurant) openRestaurant(currentRestaurant.id); // cheap re-render for demo - ideally patch
  else renderCart();
}
// Prices in the cart are only ever a display cache (the server always
// re-reads the true price at checkout - see POST /api/orders), but a stale
// display is still a real problem: a customer could be shown - and pay via
// UPI - an amount that no longer matches what the restaurant actually
// charges once their order lands. This re-fetches the restaurant's live
// menu and updates every cart line to match before anything price-sensitive
// is shown (opening the cart, opening checkout, right before placing the
// order). Items a restaurant removed or marked unavailable are dropped from
// the cart automatically, with a heads-up to the customer either way.
let priceChangeNotice = '';
async function refreshCartPrices(){
  if(!cart.length) return;
  const restaurantId = cart[0].restaurantId;
  try{
    const res = await fetch(`${BACKEND_URL}/api/restaurants/${restaurantId}`);
    if(!res.ok) return; // offline/unreachable - keep showing last known cart rather than blocking the user
    const fresh = await res.json();
    const freshItems = fresh.items || [];
    const changed = [];
    const removed = [];
    cart = cart.filter(c=>{
      const liveItem = freshItems.find(i=>i.id===c.id);
      if(!liveItem || !liveItem.isAvailable){ removed.push(c.name); return false; }
      if(liveItem.price !== c.price){ changed.push(`${c.name}: ₹${c.price} → ₹${liveItem.price}`); c.price = liveItem.price; }
      if(liveItem.name !== c.name) c.name = liveItem.name;
      return true;
    });
    if(changed.length || removed.length){
      saveCart();
      const parts = [];
      if(changed.length) parts.push('Price updated - ' + changed.join(', '));
      if(removed.length) parts.push('No longer available, removed from cart: ' + removed.join(', '));
      priceChangeNotice = parts.join(' • ');
    } else {
      priceChangeNotice = '';
    }
  }catch(e){ /* stay on last known cart if the network call fails */ }
}
function saveCart(){
  localStorage.setItem('cart', JSON.stringify(cart));
  renderCartBar();
}
function renderCartBar(){
  const total = cart.reduce((s,c)=>s + c.price*c.qty, 0);
  const count = cart.reduce((s,c)=>s + c.qty,0);
  $('#cartCount').textContent = count;
  $('#cartTotal').textContent = total;
  $('#cartItemsPreview').textContent = cart.slice(0,2).map(c=>c.name).join(', ') + (cart.length>2?' + more':'');
  $('#cartBar').classList.toggle('show', count>0);
  $('#cartModalTotal').textContent = total + (currentRestaurant?currentRestaurant.deliveryFee:0);
  const notice = priceChangeNotice ? `<div style="padding:10px; border-radius:12px; background:#fff7ed; border:1px solid #fdba74; font-size:12px; color:#9a3412; margin-bottom:10px;">⚠️ ${priceChangeNotice}</div>` : '';
  $('#cartList').innerHTML = notice + cart.map(c=>`
    <div style="display:flex; justify-content:space-between; align-items:center; padding:10px; border-radius:12px; background:#f8fafc;">
      <div><div style="font-weight:600;">${c.name}</div><div style="font-size:12px; color:#64748b;">₹${c.price} × ${c.qty}</div></div>
      <div style="display:flex; gap:8px; align-items:center;">
        <button class="btn btn-ghost" style="padding:6px 10px; color:#000;border-color:#e2e8f0;" onclick="changeQty('${c.id}',-1)">-</button>
        <b>${c.qty}</b>
        <button class="btn btn-ghost" style="padding:6px 10px; color:#000;border-color:#e2e8f0;" onclick="changeQty('${c.id}',1)">+</button>
      </div>
    </div>
  `).join('');
}
function changeQty(id, delta){
  const item = cart.find(c=>c.id===id);
  if(!item) return;
  item.qty+=delta;
  if(item.qty<=0) cart = cart.filter(c=>c.id!==id);
  saveCart();
  renderCartBar();
  if(currentRestaurant) {} // keep page
}
async function openCart(){
  $('#cartModal').classList.add('show');
  renderCartBar(); // show cached values instantly, no flash of empty state
  await refreshCartPrices();
  renderCartBar(); // then reconcile with live prices
}
function closeCart(){ $('#cartModal').classList.remove('show'); }

// CHECKOUT
async function openCheckout(){
  if(!currentRestaurant) return;
  if(!cart.length) return alert('Cart empty');
  await refreshCartPrices(); // last live sync before anything payment-related is shown
  if(!cart.length) return alert('Everything in your cart is no longer available. Please add items again.');
  $('#checkoutRestaurantName').textContent = currentRestaurant.name;
  $('#checkoutModal').classList.add('show');
  showCheckoutStep(1);
  closeCart();
  // payment box
  const total = cart.reduce((s,c)=>s+c.price*c.qty,0) + currentRestaurant.deliveryFee;
  const notice = priceChangeNotice ? `<div style="padding:10px; border-radius:12px; background:#fff7ed; border:1px solid #fdba74; font-size:12px; color:#9a3412; margin-bottom:10px;">⚠️ ${priceChangeNotice}</div>` : '';
  $('#paymentBox').innerHTML = `
    ${notice}
    <div style="padding:14px; border-radius:14px; background:#f8fafc; border:1px solid #e2e8f0;">
      <div style="font-weight:700;">Pay using UPI</div>
      <div style="margin-top:8px; font-size:13px;">UPI ID: <b>${currentRestaurant.upiId||'restaurant@upi'}</b></div>
      ${currentRestaurant.upiQrUrl?`<img src="${currentRestaurant.upiQrUrl}" style="width:160px;height:160px;object-fit:contain; background:#fff; border-radius:12px; margin-top:10px;"/>`:'<div style="margin-top:8px; font-size:12px; color:#64748b;">QR will be shown after restaurant uploads via Telegram</div>'}
      <div style="margin-top:10px; font-size:13px;">Amount: <b>₹${total}</b></div>
      <div style="margin-top:6px; font-size:11px; color:#64748b;">Do not claim payment was verified merely because receipt uploaded. Restaurant verifies manually.</div>
    </div>
    <div style="margin-top:12px; font-size:13px;">Order summary: ₹${cart.reduce((s,c)=>s+c.price*c.qty,0)} + delivery ₹${currentRestaurant.deliveryFee} = <b>₹${total}</b></div>
  `;
}
function closeCheckout(){ $('#checkoutModal').classList.remove('show'); }
function showCheckoutStep(n){
  $('#checkoutStep1').classList.toggle('hide', n!==1);
  $('#checkoutStep2').classList.toggle('hide', n!==2);
  $('#checkoutStep3').classList.toggle('hide', n!==3);
  $('#s1').classList.toggle('active', n>=1);
  $('#s2').classList.toggle('active', n>=2);
  $('#s3').classList.toggle('active', n>=3);
}
function goToPayment(){
  const name=$('#cName').value.trim();
  const phone=$('#cPhone').value.trim();
  if(!name || !phone) return alert('Name and phone required');
  showCheckoutStep(2);
}
async function placeOrder(){
  await refreshCartPrices();
  if(!cart.length){ alert('Everything in your cart is no longer available.'); closeCheckout(); return; }
  const idempotencyKey = 'order_'+Date.now()+'_'+Math.random().toString(36).slice(2);
  const payload = {
    restaurantId: currentRestaurant.id,
    customerName: $('#cName').value.trim(),
    phone: $('#cPhone').value.trim(),
    address: $('#cAddress').value.trim(),
    deliveryType: $('#cDelivery').value,
    notes: $('#cNotes').value.trim(),
    items: cart.map(c=>({id:c.id, qty:c.qty})),
    paymentMethod: 'UPI',
    idempotencyKey
  };
  try{
    const res = await fetch(`${BACKEND_URL}/api/orders`, {
      method:'POST',
      headers:{'Content-Type':'application/json','X-Idempotency-Key': idempotencyKey},
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error||'Failed');
    // upload receipt if present
    const fileInput = $('#receiptFile');
    let receiptWarning = '';
    if(fileInput.files[0]){
      try{
        const fd = new FormData();
        fd.append('receipt', fileInput.files[0]);
        const rres = await fetch(`${BACKEND_URL}/api/orders/${data.code}/receipt`, {method:'POST', body: fd});
        if(!rres.ok){
          const rdata = await rres.json().catch(()=>({}));
          receiptWarning = rdata.error || 'Receipt upload failed - please resend it to the restaurant directly.';
        }
      }catch(e){
        receiptWarning = 'Receipt upload failed (network error) - please resend it to the restaurant directly.';
      }
    }
    currentOrderCode = data.code;
    $('#orderCodeOut').textContent = data.code;
    if(receiptWarning) alert('⚠️ Order placed, but: '+receiptWarning);
    showCheckoutStep(3);
    cart=[]; saveCart();
    // polling for tracking not needed here
  }catch(e){
    alert('Order failed: '+e.message);
  }
}
function trackFromCheckout(){
  closeCheckout();
  trackOrder(currentOrderCode);
}

// TRACKING
async function trackOrder(code){
  code = code || prompt('Enter order code (e.g. FOOD-20260808-XXXX)');
  if(!code) return;
  navigate('tracking');
  $('#trackCode').textContent = 'Order '+code;
  try{
    const res = await fetch(`${BACKEND_URL}/api/orders/${code}/tracking`);
    const data = await res.json();
    if(!res.ok) throw new Error('Not found');
    const order = data.order;
    const history = data.history;
    const flow = ['SUBMITTED','ACCEPTED','PREPARING','READY','COMPLETED'];
    const currentIdx = flow.indexOf(order.status);
    $('#timeline').innerHTML = flow.map((s,idx)=>{
      const isDone = idx < currentIdx || order.status===s || (order.status==='COMPLETED');
      const isActive = order.status===s;
      const label = {SUBMITTED:'Order submitted', ACCEPTED:'Restaurant accepted', PREPARING:'Preparing', READY:'Ready', COMPLETED:'Completed'}[s];
      return `<div class="tl ${isDone?'done':''} ${isActive?'active':''}"><div style="display:flex; flex-direction:column; align-items:center;"><div class="tl-dot">${isDone?'✓':'•'}</div><div class="tl-line" style="flex:1; margin-top:6px; ${idx===flow.length-1?'display:none':''}"></div></div><div class="tl-content"><h5>${label}</h5><p>${idx===0?'We sent it to restaurant in Telegram': idx===1?'Restaurant confirmed': idx===2?'Kitchen is cooking': idx===3?'Ready for pickup/delivery':'Enjoy!'}</p></div></div>`;
    }).join('');
    $('#trackDetails').innerHTML = `
      <div style="padding:12px; background:#f8fafc; border-radius:12px; font-size:13px;">
        <div><b>${order.restaurantId}</b> • ₹${order.total} • ${order.deliveryType}</div>
        <div style="margin-top:8px;">${order.items.map(i=>`${i.name} ×${i.qty} — ₹${i.total}`).join('<br/>')}</div>
        <div style="margin-top:10px; display:flex; gap:8px;">
          <button class="btn btn-ghost" style="color:#000;border-color:#e2e8f0;" onclick="trackOrder('${code}')">Refresh</button>
          <button class="btn btn-primary" style="background:#0f172a;color:#fff;" onclick="openWhatsAppSupport('${code}')">💬 WhatsApp Support</button>
        </div>
      </div>
    `;
    // auto poll if not completed
    if(!['COMPLETED','REJECTED'].includes(order.status)){
      setTimeout(()=>trackOrder(code), 5000);
    }
  }catch(e){
    $('#timeline').innerHTML = '<div style="padding:16px;">Order not found</div>';
  }
}

function openWhatsAppSupport(code){
  const num = '919999999999'; // from config
  const msg = encodeURIComponent(`Hi, need help with order ${code}`);
  window.open(`https://wa.me/${num}?text=${msg}`,'_blank');
}

// NAVIGATION
function navigate(page){
  ['home','restaurant','tracking','about','admin'].forEach(p=>{
    $('#page-'+p).classList.toggle('hide', p!==page);
  });
  if(page==='home') window.scrollTo({top:0, behavior:'smooth'});
  if(page==='admin') initAdminPage();
}

// DRAWER
function openDrawer(){ $('#drawer').classList.add('show'); }
function closeDrawer(){ $('#drawer').classList.remove('show'); }

// HELP
function openHelp(){
  const code = currentOrderCode || '';
  const msg = encodeURIComponent(`Hi, I need help${code?' with order '+code:''}`);
  window.open(`https://wa.me/919999999999?text=${msg}`,'_blank');
}

// RESTAURANT REGISTER
function openRestaurantRegister(){ $('#registerModal').classList.add('show'); }
function closeRegister(){ $('#registerModal').classList.remove('show'); }
async function submitRestaurantRegister(){
  const payload = {
    name: $('#rName').value.trim(),
    ownerName: $('#rOwner').value.trim(),
    phone: $('#rPhone').value.trim(),
    email: $('#rEmail').value.trim(),
    city: $('#rCity').value.trim(),
    cuisine: $('#rCuisine').value.trim(),
    address: $('#rAddress').value.trim(),
    openingHours: $('#rHours').value.trim(),
    upiId: $('#rUpi').value.trim(),
    password: $('#rPass').value.trim()
  };
  if(!payload.name || !payload.ownerName || !payload.phone || !payload.email || !payload.password) return alert('Fill required fields');
  try{
    const res = await fetch(`${BACKEND_URL}/api/restaurants/register`, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)});
    const data = await res.json();
    if(!res.ok) throw new Error(data.error);
    alert('Registration submitted! Awaiting admin approval via Telegram (silent notification). You will get linking code after approval.');
    closeRegister();
  }catch(e){ alert('Failed: '+e.message); }
}

// ===== SUPER ADMIN DASHBOARD =====
// Auth: a server-verified key (ADMIN_API_KEY env var on the backend), never a
// client-side PIN. The key lives only in sessionStorage (cleared when the tab
// closes) and is sent as the X-Admin-Key header on every admin request.
function adminHeaders(){
  return { 'Content-Type':'application/json', 'X-Admin-Key': sessionStorage.getItem('admin_key')||'' };
}
function initAdminPage(){
  const key = sessionStorage.getItem('admin_key');
  if(key){
    $('#adminLoginGate').style.display = 'none';
    $('#adminPanel').style.display = 'block';
    loadAdminData();
  } else {
    $('#adminLoginGate').style.display = 'block';
    $('#adminPanel').style.display = 'none';
  }
}
async function adminLogin(){
  const key = $('#adminKeyInput').value.trim();
  if(!key) return alert('Enter the admin key');
  try{
    const res = await fetch(`${BACKEND_URL}/api/admin/restaurants`, { headers: {'X-Admin-Key': key} });
    if(!res.ok){
      if(res.status===401) return alert('Invalid admin key');
      if(res.status===503) return alert('Admin API not enabled on the backend yet — set ADMIN_API_KEY in Render env vars');
      return alert('Login failed ('+res.status+')');
    }
    sessionStorage.setItem('admin_key', key);
    $('#adminKeyInput').value='';
    initAdminPage();
  }catch(e){ alert('Could not reach backend: '+e.message); }
}
function adminLogout(){
  sessionStorage.removeItem('admin_key');
  initAdminPage();
}
async function loadAdminData(){
  try{
    const [analyticsRes, dataRes] = await Promise.all([
      fetch(`${BACKEND_URL}/api/admin/analytics`, { headers: adminHeaders() }),
      fetch(`${BACKEND_URL}/api/admin/restaurants`, { headers: adminHeaders() })
    ]);
    if(analyticsRes.status===401 || dataRes.status===401){ alert('Session expired, please log in again'); return adminLogout(); }
    const analytics = await analyticsRes.json();
    const data = await dataRes.json();
    renderAdminAnalytics(analytics);
    renderAdminApplications(data.applications||[]);
    renderAdminRestaurants(data.restaurants||[]);
  }catch(e){ console.error(e); }
}
function renderAdminAnalytics(a){
  const cards = [
    ['Orders today', a.ordersToday],
    ['Total orders', a.totalOrders],
    ['Revenue (completed)', '₹'+(a.totalRevenue||0)],
    ['Active restaurants', a.activeRestaurants],
    ['Pending applications', a.pendingApplications],
    ['Unique customers', a.totalCustomers]
  ];
  $('#adminAnalyticsGrid').innerHTML = cards.map(([label,val])=>`
    <div style="background:#f8fafc; border-radius:14px; padding:14px;">
      <div style="font-size:12px; color:#64748b;">${label}</div>
      <div style="font-size:20px; font-weight:800; margin-top:4px;">${val}</div>
    </div>`).join('');
}
function renderAdminApplications(list){
  const pending = list.filter(a=>a.status==='PENDING');
  if(!pending.length){ $('#adminApplicationsList').innerHTML = '<div style="font-size:13px; color:#64748b;">No pending applications</div>'; return; }
  $('#adminApplicationsList').innerHTML = pending.map(a=>`
    <div style="background:#f8fafc; border-radius:14px; padding:12px;">
      <div style="font-weight:700;">${a.restaurantName}</div>
      <div style="font-size:12px; color:#64748b; margin-top:2px;">${a.ownerName} • ${a.phone} • ${a.email}</div>
      <div style="display:flex; gap:8px; margin-top:10px;">
        <button class="btn btn-primary" style="background:#16a34a; color:#fff; padding:6px 14px; font-size:13px;" onclick="adminApprove('${a.id}')">✅ Approve</button>
        <button class="btn btn-ghost" style="color:#000; border-color:#e2e8f0; padding:6px 14px; font-size:13px;" onclick="adminReject('${a.id}')">❌ Reject</button>
      </div>
    </div>`).join('');
}
function renderAdminRestaurants(list){
  if(!list.length){ $('#adminRestaurantsList').innerHTML = '<div style="font-size:13px; color:#64748b;">No restaurants yet</div>'; return; }
  $('#adminRestaurantsList').innerHTML = list.map(r=>`
    <div style="background:#f8fafc; border-radius:14px; padding:12px;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <div>
          <div style="font-weight:700;">${r.name}</div>
          <div style="font-size:12px; color:#64748b;">${r.status} • ${r.city||''} • ${r.isOpen?'🟢 Open':'🔴 Closed'}</div>
        </div>
      </div>
      <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:10px;">
        <button class="btn btn-ghost" style="padding:5px 10px; font-size:12px; color:#000; border-color:${r.isPinned?'#0084ff':'#e2e8f0'};" onclick="adminToggle('${r.id}','pin')">📌 ${r.isPinned?'Unpin':'Pin'}</button>
        <button class="btn btn-ghost" style="padding:5px 10px; font-size:12px; color:#000; border-color:${r.isHighlighted?'#0084ff':'#e2e8f0'};" onclick="adminToggle('${r.id}','highlight')">✨ ${r.isHighlighted?'Unhighlight':'Highlight'}</button>
        <button class="btn btn-ghost" style="padding:5px 10px; font-size:12px; color:#000; border-color:${r.premium?'#0084ff':'#e2e8f0'};" onclick="adminToggle('${r.id}','premium')">⭐ ${r.premium?'Remove premium':'Make premium'}</button>
        <button class="btn btn-ghost" style="padding:5px 10px; font-size:12px; color:${r.status==='SUSPENDED'?'#ff4d5a':'#000'}; border-color:#e2e8f0;" onclick="adminToggle('${r.id}','suspend')">${r.status==='SUSPENDED'?'▶️ Unsuspend':'⛔ Suspend'}</button>
      </div>
    </div>`).join('');
}
async function adminToggle(id, action){
  try{
    const res = await fetch(`${BACKEND_URL}/api/admin/restaurants/${id}/${action}`, { method:'POST', headers: adminHeaders() });
    if(!res.ok) throw new Error('Action failed');
    loadAdminData();
  }catch(e){ alert('Error: '+e.message); }
}
async function adminApprove(appId){
  try{
    const res = await fetch(`${BACKEND_URL}/api/admin/applications/${appId}/approve`, { method:'POST', headers: adminHeaders() });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error||'Approve failed');
    alert('Approved! Send this Telegram link to the restaurant owner:\n'+data.linkUrl);
    loadAdminData();
  }catch(e){ alert('Error: '+e.message); }
}
async function adminReject(appId){
  if(!confirm('Reject this application?')) return;
  try{
    const res = await fetch(`${BACKEND_URL}/api/admin/applications/${appId}/reject`, { method:'POST', headers: adminHeaders() });
    if(!res.ok) throw new Error('Reject failed');
    loadAdminData();
  }catch(e){ alert('Error: '+e.message); }
}

// ORDER PAGE via URL ?code=
function checkUrlForOrder(){
  const params = new URLSearchParams(location.search);
  const code = params.get('code') || params.get('order');
  if(code) trackOrder(code);
}

// INIT
renderCategories();
renderCartBar();
boot();
checkUrlForOrder();

// expose for inline handlers
window.openRestaurant = openRestaurant;
window.navigate = navigate;
window.openDrawer = openDrawer;
window.closeDrawer = closeDrawer;
window.retryBoot = retryBoot;
window.skipBoot = skipBoot;
window.filterByCategory = filterByCategory;
window.loadRestaurants = loadRestaurants;
window.addToCart = addToCart;
window.openFood = openFood;
window.closeFoodModal = closeFoodModal;
window.openCart = openCart;
window.closeCart = closeCart;
window.changeQty = changeQty;
window.openCheckout = openCheckout;
window.closeCheckout = closeCheckout;
window.goToPayment = goToPayment;
window.placeOrder = placeOrder;
window.trackFromCheckout = trackFromCheckout;
window.trackOrder = trackOrder;
window.openWhatsAppSupport = openWhatsAppSupport;
window.openRestaurantRegister = openRestaurantRegister;
window.closeRegister = closeRegister;
window.submitRestaurantRegister = submitRestaurantRegister;
window.openHelp = openHelp;
window.scrollToCat = scrollToCat;
window.showCheckoutStep = showCheckoutStep;
window.adminLogin = adminLogin;
window.adminLogout = adminLogout;
window.adminToggle = adminToggle;
window.adminApprove = adminApprove;
window.adminReject = adminReject;

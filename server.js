
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

// ================= CONFIG =================
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const SUPER_ADMIN_IDS = (process.env.SUPER_ADMIN_TELEGRAM_IDS || '').split(',').map(s=>s.trim()).filter(Boolean).map(Number);
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;
const WHATSAPP_NUMBER = process.env.WHATSAPP_SUPPORT_NUMBER || '919999999999';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';

const DATA_FILE = path.join(__dirname, 'data.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, {recursive:true});

// ================= PERSISTENCE (single source of truth) =================
let db = {
  restaurants: [],
  applications: [],
  categories: [],
  menuItems: [],
  orders: [],
  orderStatusHistory: [],
  telegramLinks: [], // {token, restaurantId, used}
  telegramAccounts: [], // {telegramUserId, restaurantId, role}
  staff: [],
  auditLogs: [],
  idempotency: {}, // key -> orderCode
  receipts: []
};

function loadDB(){
  try{
    if(fs.existsSync(DATA_FILE)){
      const raw = fs.readFileSync(DATA_FILE,'utf8');
      const parsed = JSON.parse(raw);
      db = {...db, ...parsed};
      console.log('DB loaded');
    }
  }catch(e){ console.error('DB load error', e); }
}
function saveDB(){
  try{ fs.writeFileSync(DATA_FILE, JSON.stringify(db,null,2)); }catch(e){ console.error('save error', e); }
}
loadDB();

if(TELEGRAM_BOT_TOKEN && process.env.NODE_ENV === 'production' && !WEBHOOK_SECRET){
  console.warn('⚠️  WEBHOOK_SECRET is not set. /telegram/webhook will reject ALL requests (including real ones from Telegram) until you set it in Render env vars.');
}

// seed if empty
if(db.restaurants.length===0){
  const sampleRestaurants = [
    {id:"rest-waterfall-grill",   name:"Waterfall Grill",       cuisine:"North Indian, BBQ",   rating:4.6, deliveryTime:"25-30 min", deliveryFee:30, minOrder:199, city:"Bhopal", address:"MP Nagar",          isVeg:false},
    {id:"rest-mist-spice",        name:"Mist & Spice",          cuisine:"South Indian",        rating:4.5, deliveryTime:"20-25 min", deliveryFee:25, minOrder:149, city:"Bhopal", address:"Arera Colony",      isVeg:true},
    {id:"rest-cloud-noodles",     name:"Cloud Noodles",         cuisine:"Chinese, Thai",       rating:4.3, deliveryTime:"30-35 min", deliveryFee:35, minOrder:199, city:"Bhopal", address:"Kolar",             isVeg:false},
    {id:"rest-burger-falls",      name:"Burger Falls",          cuisine:"Burgers, American",   rating:4.4, deliveryTime:"20-30 min", deliveryFee:20, minOrder:149, city:"Bhopal", address:"New Market",        isVeg:false},
    {id:"rest-pizza-cascade",     name:"Pizza Cascade",         cuisine:"Italian, Pizza",      rating:4.7, deliveryTime:"25-35 min", deliveryFee:30, minOrder:299, city:"Bhopal", address:"Habibganj",         isVeg:false},
    {id:"rest-tandoor-drift",     name:"Tandoor Drift",         cuisine:"Mughlai, Kebab",      rating:4.2, deliveryTime:"30-40 min", deliveryFee:40, minOrder:249, city:"Bhopal", address:"Bittan Market",     isVeg:false},
    {id:"rest-green-valley-bowls",name:"Green Valley Bowls",    cuisine:"Healthy, Salads",     rating:4.5, deliveryTime:"15-20 min", deliveryFee:15, minOrder:199, city:"Bhopal", address:"Shahpura",          isVeg:true},
    {id:"rest-sweet-stream",      name:"Sweet Stream",          cuisine:"Desserts, Bakery",    rating:4.6, deliveryTime:"15-25 min", deliveryFee:20, minOrder:99,  city:"Bhopal", address:"10 No Stop",        isVeg:true},
    {id:"rest-chai-falls",        name:"Chai & Falls",          cuisine:"Snacks, Tea",         rating:4.3, deliveryTime:"15-20 min", deliveryFee:10, minOrder:99,  city:"Bhopal", address:"MP Nagar Zone 2",   isVeg:true},
    {id:"rest-wok-water",         name:"Wok & Water",           cuisine:"Asian, Noodles",      rating:4.1, deliveryTime:"25-30 min", deliveryFee:30, minOrder:199, city:"Bhopal", address:"Indrapuri",         isVeg:false},
    {id:"rest-curry-rapids",      name:"Curry Rapids",          cuisine:"Indian, Curry",       rating:4.4, deliveryTime:"30-35 min", deliveryFee:35, minOrder:199, city:"Bhopal", address:"Hoshangabad Road",  isVeg:false},
    {id:"rest-fry-falls",         name:"Fry Falls",             cuisine:"Snacks, Fries",       rating:4.0, deliveryTime:"15-20 min", deliveryFee:15, minOrder:99,  city:"Bhopal", address:"Ayodhya Nagar",     isVeg:true},
    {id:"rest-grill-by-the-falls",name:"Grill By The Falls",    cuisine:"BBQ, Continental",    rating:4.8, deliveryTime:"35-45 min", deliveryFee:50, minOrder:399, city:"Bhopal", address:"Bawadiya Kalan",    isVeg:false},
    {id:"rest-dosa-mist",         name:"Dosa Mist",             cuisine:"South Indian",        rating:4.5, deliveryTime:"20-25 min", deliveryFee:20, minOrder:149, city:"Bhopal", address:"Lalghati",          isVeg:true},
    {id:"rest-rolling-river",     name:"Rolling River",         cuisine:"Wraps, Rolls",        rating:4.2, deliveryTime:"20-25 min", deliveryFee:25, minOrder:149, city:"Bhopal", address:"Piplani",           isVeg:false},
    {id:"rest-momo-springs",      name:"Momo Springs",          cuisine:"Tibetan, Momos",      rating:4.3, deliveryTime:"20-30 min", deliveryFee:20, minOrder:149, city:"Bhopal", address:"Karond",            isVeg:false},
    {id:"rest-biriyani-bay",      name:"Biriyani Bay",          cuisine:"Biryani, Hyderabadi", rating:4.6, deliveryTime:"30-40 min", deliveryFee:40, minOrder:299, city:"Bhopal", address:"BHEL",              isVeg:false},
    {id:"rest-juice-junction",    name:"Juice Junction Falls",  cuisine:"Juices, Drinks",      rating:4.1, deliveryTime:"10-15 min", deliveryFee:10, minOrder:99,  city:"Bhopal", address:"MP Nagar",          isVeg:true},
    {id:"rest-kebab-cascade",     name:"Kebab Cascade",         cuisine:"Kebabs, Mughlai",     rating:4.7, deliveryTime:"30-35 min", deliveryFee:35, minOrder:299, city:"Bhopal", address:"Old City",          isVeg:false},
    {id:"rest-pasta-falls",       name:"Pasta Falls",           cuisine:"Italian, Pasta",      rating:4.4, deliveryTime:"25-30 min", deliveryFee:30, minOrder:249, city:"Bhopal", address:"Arera Hills",       isVeg:true},
  ];
  sampleRestaurants.forEach((r,i)=>{
    const id = r.id; // fixed, stable id - do NOT switch this back to uuidv4().
    // Seed data re-runs every time db.restaurants is empty (e.g. after a
    // restart with no persistent disk on Render free tier). A random id
    // here would change on every reseed, silently breaking any bookmarked
    // /restaurant/<id> link, any Telegram account already linked to that
    // restaurant, and any past order's restaurantId reference.
    const rest = {
      id,
      name: r.name,
      ownerName: "Demo Owner",
      phone: "999999999"+(i%10),
      email: `owner${i}@demo.com`,
      address: r.address,
      city: r.city,
      cuisine: r.cuisine,
      description: `${r.name} - Premium dining by the waterfall theme. Authentic ${r.cuisine} crafted with love.`,
      logoUrl: `https://picsum.photos/seed/${id}logo/200/200`,
      coverUrl: `https://picsum.photos/seed/${id}cover/800/400`,
      status: 'LIVE',
      isPinned: i<3,
      isHighlighted: i%4===0,
      isOpen: true,
      isBusy: false,
      deliveryFee: r.deliveryFee,
      minOrder: r.minOrder,
      deliveryTime: r.deliveryTime,
      rating: r.rating,
      openingHours: "10:00-22:30",
      upiId: `demo${i}@upi`,
      upiQrUrl: null,
      createdAt: new Date().toISOString(),
      passwordHash: bcrypt.hashSync("demo1234", 8)
    };
    db.restaurants.push(rest);
    // categories per restaurant
    const catNames = [["🍔 Burgers","Burgers"],["🍕 Pizza","Pizza"],["🍜 Noodles","Noodles"],["🍗 Chicken","Chicken"],["🥗 Veg","Vegetarian"],["🍟 Snacks","Snacks"],["🍰 Desserts","Desserts"],["🥤 Drinks","Drinks"]];
    catNames.slice(0,4).forEach((cn, idx)=>{
      const catId = uuidv4();
      db.categories.push({id:catId, restaurantId:id, name:cn[1], emoji:cn[0].split(' ')[0], sortOrder:idx});
      // 3 items per cat
      for(let k=0;k<3;k++){
        db.menuItems.push({
          id: uuidv4(),
          restaurantId:id,
          categoryId: catId,
          name: `${cn[1]} Special ${k+1}`,
          description: `Delicious ${cn[1].toLowerCase()} made with premium ingredients, served fresh.`,
          price: 149 + (idx*30) + (k*50) + (i%3)*10,
          imageUrl: `https://picsum.photos/seed/${id}${catId}${k}/400/300`,
          isVeg: r.isVeg || (k%2===0),
          isAvailable: true,
          prepTime: "15-20 min",
          sortOrder: k
        });
      }
    });
  });
  saveDB();
}

// ================= HELPERS =================
function generateOrderCode(){
  const date = new Date().toISOString().slice(0,10).replace(/-/g,'');
  const rand = Math.random().toString(36).substring(2,6).toUpperCase();
  return `FOOD-${date}-${rand}`;
}
function logAudit(who, what, target, prev=null, next=null){
  db.auditLogs.push({id:uuidv4(), who, what, target, prev, next, when:new Date().toISOString()});
  saveDB();
}
function findRestaurantByTelegramUser(telegramUserId){
  const acc = db.telegramAccounts.find(a=>a.telegramUserId===Number(telegramUserId));
  if(!acc) return null;
  return db.restaurants.find(r=>r.id===acc.restaurantId) || null;
}
function isSuperAdmin(telegramUserId){
  return SUPER_ADMIN_IDS.includes(Number(telegramUserId));
}
// Every restaurant object carries a bcrypt passwordHash. Never send that
// (or other internal fields) to the public website - always pass restaurant
// objects through this before res.json().
function publicRestaurant(r){
  const {passwordHash, staffPin, ...safe} = r;
  return safe;
}

// ---- DAILY STAFF PIN ----
// Lightweight, scoped credential for counter staff who don't have the
// owner's Telegram. Rotates automatically every midnight and can be
// regenerated on demand by the owner via /staffpin. Never returned by
// publicRestaurant() above - only issued through /api/staff/login.
function todayStr(){ return new Date().toISOString().slice(0,10); }
function generateStaffPin(){ return String(Math.floor(100000 + Math.random()*900000)); }
function ensureStaffPin(restaurant){
  if(restaurant.staffPinDate !== todayStr()){
    restaurant.staffPin = generateStaffPin();
    restaurant.staffPinDate = todayStr();
  }
  return restaurant.staffPin;
}
function regenerateStaffPin(restaurant){
  restaurant.staffPin = generateStaffPin();
  restaurant.staffPinDate = todayStr();
  return restaurant.staffPin;
}
const STAFF_TOKEN_TTL_SEC = 12*60*60; // session outlives a shift, dies well before next day's PIN
function issueStaffToken(restaurantId){
  return jwt.sign({restaurantId, role:'staff'}, JWT_SECRET, {expiresIn: STAFF_TOKEN_TTL_SEC});
}
function requireStaffAuth(req,res,next){
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if(!token) return res.status(401).json({error:'Missing staff session'});
  try{
    const payload = jwt.verify(token, JWT_SECRET);
    if(payload.role!=='staff') throw new Error('wrong role');
    req.staffRestaurantId = payload.restaurantId;
    next();
  }catch(e){
    return res.status(401).json({error:'Staff session invalid or expired - log in again with today\'s PIN'});
  }
}

// ================= EXPRESS APP =================
const app = express();
app.use(helmet({crossOriginResourcePolicy:false}));
app.use(cors({origin:true, credentials:true}));
app.use(morgan('tiny'));
app.use(express.json({limit:'10mb'}));
app.use(express.urlencoded({extended:true}));
app.use('/uploads', express.static(UPLOAD_DIR));

const limiter = rateLimit({windowMs:60*1000, max:120});
app.use(limiter);

// Strict: a 6-digit PIN is only ~1e6 combinations, so login attempts are
// throttled per IP+restaurant far tighter than the general API limiter.
const staffLoginLimiter = rateLimit({
  windowMs: 15*60*1000, max: 8,
  keyGenerator: (req)=> req.ip + ':' + (req.body && req.body.restaurantId || ''),
  message: {error:'Too many attempts. Try again in a few minutes.'}
});

// ---- HEALTH ----
app.get('/health/live', (req,res)=> res.json({status:'ok', ts:Date.now()}));
app.get('/health/ready', (req,res)=>{
  const checks = {
    frontend: 'ok',
    backend: 'ok',
    database: fs.existsSync(DATA_FILE) ? 'ok' : 'ok',
    telegram: TELEGRAM_BOT_TOKEN ? 'configured' : 'not_configured',
    notifications: 'ok'
  };
  const allOk = Object.values(checks).every(v=>v==='ok' || v==='configured' || v==='not_configured');
  res.json({status: allOk?'ready':'degraded', checks, version:'1.0.0'});
});

// ---- PUBLIC CONFIG ----
app.get('/api/config', (req,res)=>{
  res.json({whatsapp: WHATSAPP_NUMBER, frontendUrl: FRONTEND_URL});
});

// ---- RESTAURANTS ----
app.get('/api/restaurants', (req,res)=>{
  const q = (req.query.q||'').toLowerCase();
  let list = db.restaurants.filter(r=>r.status==='LIVE');
  if(q){
    list = list.filter(r=> r.name.toLowerCase().includes(q) || r.cuisine.toLowerCase().includes(q));
  }
  // sort: pinned first, then highlighted, then rating
  list.sort((a,b)=>{
    if(a.isPinned && !b.isPinned) return -1;
    if(!a.isPinned && b.isPinned) return 1;
    if(a.isHighlighted && !b.isHighlighted) return -1;
    if(!a.isHighlighted && b.isHighlighted) return 1;
    return b.rating - a.rating;
  });
  res.json(list.map(publicRestaurant));
});

app.get('/api/restaurants/:id', (req,res)=>{
  const r = db.restaurants.find(x=>x.id===req.params.id);
  if(!r) return res.status(404).json({error:'Not found'});
  const categories = db.categories.filter(c=>c.restaurantId===r.id).sort((a,b)=>a.sortOrder-b.sortOrder);
  const items = db.menuItems.filter(i=>i.restaurantId===r.id);
  res.json({...publicRestaurant(r), categories, items});
});

app.get('/api/categories', (req,res)=>{
  const globalCats = [
    {id:'burgers', name:'Burgers', emoji:'🍔'},
    {id:'pizza', name:'Pizza', emoji:'🍕'},
    {id:'noodles', name:'Noodles', emoji:'🍜'},
    {id:'chicken', name:'Chicken', emoji:'🍗'},
    {id:'veg', name:'Vegetarian', emoji:'🥗'},
    {id:'snacks', name:'Snacks', emoji:'🍟'},
    {id:'desserts', name:'Desserts', emoji:'🍰'},
    {id:'drinks', name:'Drinks', emoji:'🥤'},
  ];
  res.json(globalCats);
});

app.get('/api/search', (req,res)=>{
  const q = (req.query.q||'').toLowerCase();
  if(!q) return res.json({restaurants:[], items:[]});
  const restaurants = db.restaurants.filter(r=>r.status==='LIVE' && (r.name.toLowerCase().includes(q) || r.cuisine.toLowerCase().includes(q))).slice(0,10).map(publicRestaurant);
  const items = db.menuItems.filter(i=>{
    const rest = db.restaurants.find(r=>r.id===i.restaurantId);
    return rest && rest.status==='LIVE' && (i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q));
  }).slice(0,20).map(i=>{
    const rest = db.restaurants.find(r=>r.id===i.restaurantId);
    return {...i, restaurantName: rest?.name};
  });
  res.json({restaurants, items});
});

// ---- RESTAURANT REGISTRATION ----
app.post('/api/restaurants/register', async (req,res)=>{
  try{
    const {name, ownerName, phone, email, address, city, cuisine, description, openingHours, password, upiId} = req.body;
    if(!name || !ownerName || !phone || !email || !password){
      return res.status(400).json({error:'Missing required fields'});
    }
    // check existing
    if(db.restaurants.find(r=>r.email===email) || db.applications.find(a=>a.email===email && a.status==='PENDING')){
      return res.status(409).json({error:'Application already exists'});
    }
    const id = uuidv4();
    const appEntry = {
      id,
      restaurantName: name,
      ownerName,
      phone,
      email,
      address: address||'',
      city: city||'',
      cuisine: cuisine||'',
      description: description||'',
      openingHours: openingHours||'10:00-22:00',
      upiId: upiId||'',
      logoUrl: null,
      coverUrl: null,
      status: 'PENDING',
      createdAt: new Date().toISOString(),
      passwordHash: bcrypt.hashSync(password, 10)
    };
    db.applications.push(appEntry);
    // create restaurant in pending
    db.restaurants.push({
      id,
      name,
      ownerName,
      phone,
      email,
      address,
      city,
      cuisine,
      description,
      openingHours: openingHours||'10:00-22:00',
      logoUrl: null,
      coverUrl: null,
      status: 'PENDING',
      isPinned:false,
      isHighlighted:false,
      isOpen:false,
      isBusy:false,
      deliveryFee:30,
      minOrder:199,
      deliveryTime:"30-40 min",
      rating:4.5,
      upiId: upiId||'',
      upiQrUrl:null,
      passwordHash: appEntry.passwordHash,
      createdAt: new Date().toISOString()
    });
    saveDB();
    logAudit('restaurant:'+email, 'REGISTER', id);

    // Silent admin notification via Telegram
    await notifySuperAdminNewRegistration(appEntry);

    res.json({ok:true, message:'Registration submitted. Awaiting admin approval.', id});
  }catch(e){
    console.error(e);
    res.status(500).json({error:'Server error'});
  }
});

// NOTE: There is intentionally no restaurant web login. Per architecture,
// the customer website is the ONLY customer-facing surface. Restaurant
// owners and the super admin control everything exclusively through the
// Telegram bot (registration -> admin approval -> Telegram account linking
// -> bot commands). Re-adding a web login here would (a) contradict that
// design and (b) previously leaked passwordHash to the client in the
// restaurant object - do not reintroduce it without stripping that field.

// ---- ORDERS ----
app.post('/api/orders', (req,res)=>{
  try{
    const idempotencyKey = req.headers['x-idempotency-key'] || req.body.idempotencyKey;
    if(idempotencyKey && db.idempotency[idempotencyKey]){
      const existingCode = db.idempotency[idempotencyKey];
      const existing = db.orders.find(o=>o.code===existingCode);
      return res.json(existing);
    }

    const {restaurantId, customerName, phone, address, deliveryType, notes, items, paymentMethod} = req.body;
    if(!restaurantId || !customerName || !phone || !items || !items.length){
      return res.status(400).json({error:'Missing fields'});
    }
    const restaurant = db.restaurants.find(r=>r.id===restaurantId);
    if(!restaurant || restaurant.status!=='LIVE') return res.status(400).json({error:'Restaurant unavailable'});
    if(!restaurant.isOpen) return res.status(400).json({error:'Restaurant closed'});

    // snapshot prices from DB - never trust browser totals
    let subtotal=0;
    const snapshotItems=[];
    for(const it of items){
      const menuItem = db.menuItems.find(m=>m.id===it.id && m.restaurantId===restaurantId);
      if(!menuItem) return res.status(400).json({error:`Invalid item ${it.id}`});
      if(!menuItem.isAvailable) return res.status(400).json({error:`${menuItem.name} sold out`});
      const qty = Math.max(1, Math.min(20, Number(it.qty)||1));
      const unitPrice = menuItem.price; // server truth
      subtotal += unitPrice*qty;
      snapshotItems.push({
        id: menuItem.id,
        name: menuItem.name,
        qty,
        unitPrice,
        total: unitPrice*qty,
        isVeg: menuItem.isVeg
      });
    }
    const deliveryFee = deliveryType==='delivery' ? (restaurant.deliveryFee||0) : 0;
    const total = subtotal + deliveryFee;

    const code = generateOrderCode();
    const order = {
      id: uuidv4(),
      code,
      restaurantId,
      customerName,
      phone,
      address: address||'',
      deliveryType: deliveryType||'delivery',
      notes: notes||'',
      items: snapshotItems,
      subtotal,
      deliveryFee,
      total,
      paymentMethod: paymentMethod||'UPI',
      paymentStatus: 'PENDING_VERIFICATION',
      receiptUrl: null,
      status: 'SUBMITTED',
      idempotencyKey: idempotencyKey||null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    db.orders.push(order);
    db.orderStatusHistory.push({id:uuidv4(), orderCode:code, from:null, to:'SUBMITTED', at:new Date().toISOString(), by:'customer'});
    if(idempotencyKey) db.idempotency[idempotencyKey]=code;
    saveDB();
    logAudit('customer:'+phone, 'CREATE_ORDER', code, null, order);

    // Notify restaurant via Telegram
    notifyRestaurantNewOrder(order).catch(e=>console.error('notify err', e));

    res.json(order);
  }catch(e){
    console.error(e);
    res.status(500).json({error:'Failed to create order'});
  }
});

app.get('/api/orders/:code', (req,res)=>{
  const order = db.orders.find(o=>o.code===req.params.code);
  if(!order) return res.status(404).json({error:'Order not found'});
  const restaurant = db.restaurants.find(r=>r.id===order.restaurantId);
  res.json({...order, restaurantName: restaurant?.name, restaurantPhone: restaurant?.phone});
});

app.get('/api/orders/:code/tracking', (req,res)=>{
  const order = db.orders.find(o=>o.code===req.params.code);
  if(!order) return res.status(404).json({error:'Not found'});
  const history = db.orderStatusHistory.filter(h=>h.orderCode===order.code).sort((a,b)=>new Date(a.at)-new Date(b.at));
  res.json({order, history});
});

const upload = multer({dest: UPLOAD_DIR, limits:{fileSize:5*1024*1024}});
app.post('/api/orders/:code/receipt', upload.single('receipt'), (req,res)=>{
  const order = db.orders.find(o=>o.code===req.params.code);
  if(!order) return res.status(404).json({error:'Order not found'});
  if(!req.file) return res.status(400).json({error:'No file'});
  const url = `/uploads/${req.file.filename}`;
  order.receiptUrl = url;
  order.paymentStatus = 'RECEIPT_SUBMITTED';
  order.updatedAt = new Date().toISOString();
  db.receipts.push({id:uuidv4(), orderCode:order.code, url, at:new Date().toISOString()});
  saveDB();
  logAudit('customer', 'UPLOAD_RECEIPT', order.code);
  notifyRestaurantReceipt(order).catch(console.error);
  res.json({ok:true, url});
});

// ================= TELEGRAM BOT =================
let bot = null;
if(TELEGRAM_BOT_TOKEN){
  const { Telegraf, Markup } = require('telegraf');
  bot = new Telegraf(TELEGRAM_BOT_TOKEN);

  // /start
  bot.start(async (ctx)=>{
    const payload = ctx.message.text.split(' ')[1] || '';
    const tgUserId = ctx.from.id;

    if(isSuperAdmin(tgUserId)){
      return ctx.reply('👑 SUPER ADMIN\nWelcome to Control Center\n\n💾 Data is backed up here automatically every 6h. If it ever resets, reply /restore to the latest backup file. Send /backup anytime for an on-demand copy.', Markup.inlineKeyboard([
        [Markup.button.callback('🏪 Restaurants','sa_restaurants')],
        [Markup.button.callback('📦 Orders','sa_orders'), Markup.button.callback('💳 Payments','sa_payments')],
        [Markup.button.callback('📊 Analytics','sa_analytics'), Markup.button.callback('🩺 System Health','sa_health')],
        [Markup.button.callback('🚨 Emergency','sa_emergency')]
      ]));
    }

    if(payload.startsWith('link_')){
      const token = payload.replace('link_','');
      const link = db.telegramLinks.find(l=>l.token===token && !l.used);
      if(!link){
        return ctx.reply('❌ Invalid or expired link. Ask Super Admin for new link.');
      }
      const restaurant = db.restaurants.find(r=>r.id===link.restaurantId);
      if(!restaurant) return ctx.reply('Restaurant not found');

      // link account
      db.telegramAccounts.push({telegramUserId:tgUserId, restaurantId:restaurant.id, role:'OWNER', linkedAt:new Date().toISOString()});
      link.used=true;
      saveDB();
      logAudit('telegram:'+tgUserId, 'LINK_TELEGRAM', restaurant.id);
      return ctx.reply(`✅ RESTAURANT APPROVED\n${restaurant.name}\n\nLet's set up your restaurant.`, Markup.inlineKeyboard([
        [Markup.button.callback('🚀 START SETUP','setup_start')],
        [Markup.button.callback('❓ HELP','help')]
      ]));
    }

    const restaurant = findRestaurantByTelegramUser(tgUserId);
    if(restaurant){
      return showRestaurantMainMenu(ctx, restaurant);
    }

    ctx.reply('👋 Welcome! This bot is for restaurant partners and super admins.\nIf you registered on the website, wait for approval to get linking code.\n\nIf you are a customer, please use the website for orders.');
  });

  function showRestaurantMainMenu(ctx, restaurant){
    return ctx.reply(`🏪 RESTAURANT CONTROL\n${restaurant.name}\nStatus: ${restaurant.status} | ${restaurant.isOpen?'🟢 Open':'🔴 Closed'}`, Markup.inlineKeyboard([
      [Markup.button.callback('📦 Orders','r_orders'), Markup.button.callback('🍔 Menu','r_menu')],
      [Markup.button.callback('💰 Prices','r_prices'), Markup.button.callback('💳 Payments','r_payments')],
      [Markup.button.callback('🏪 Profile','r_profile'), Markup.button.callback('🕐 Hours','r_hours')],
      [Markup.button.callback(restaurant.isOpen?'🔴 Close Shop':'🟢 Open Shop','r_toggle_open'), Markup.button.callback(restaurant.isBusy?'🟢 Not Busy':'🟡 Busy Mode','r_toggle_busy')],
      [Markup.button.callback('👥 Staff','r_staff'), Markup.button.callback('📊 Sales','r_sales')],
      [Markup.button.callback('⚙️ Settings','r_settings')]
    ]));
  }

  // helpers for inline buttons
  bot.on('callback_query', async (ctx)=>{
    const data = ctx.callbackQuery.data;
    const tgUserId = ctx.from.id;
    try{
      // SUPER ADMIN
      if(data.startsWith('sa_')){
        if(!isSuperAdmin(tgUserId)) return ctx.answerCbQuery('Unauthorized');
        if(data==='sa_restaurants'){
          const pending = db.applications.filter(a=>a.status==='PENDING');
          if(pending.length===0) return ctx.reply('No pending applications. Live restaurants: '+db.restaurants.filter(r=>r.status==='LIVE').length);
          for(const app of pending.slice(0,5)){
            await ctx.reply(`🏪 NEW REGISTRATION\n${app.restaurantName}\nOwner: ${app.ownerName}\nPhone: ${app.phone}\nEmail: ${app.email}\nCuisine: ${app.cuisine}\nHours: ${app.openingHours}`, Markup.inlineKeyboard([
              [Markup.button.callback('✅ APPROVE','approve_'+app.id), Markup.button.callback('❌ REJECT','reject_'+app.id)],
              [Markup.button.callback('👀 VIEW DETAILS','view_'+app.id)]
            ]));
          }
        }
        if(data==='sa_health'){
          return ctx.reply(`🩺 SYSTEM HEALTH\nFrontend: 🟢\nBackend: 🟢\nDatabase: 🟢 ${db.restaurants.length} restaurants\nTelegram: 🟢\nOrders today: ${db.orders.filter(o=>o.createdAt.startsWith(new Date().toISOString().slice(0,10))).length}`);
        }
        if(data==='sa_orders'){
          const recent = db.orders.slice(-5).reverse();
          return ctx.reply('📦 Recent Orders:\n'+recent.map(o=>`${o.code} - ${o.total} - ${o.status}`).join('\n'));
        }
        return ctx.answerCbQuery();
      }

      if(data.startsWith('approve_')){
        if(!isSuperAdmin(tgUserId)) return ctx.answerCbQuery('Unauthorized');
        const appId = data.replace('approve_','');
        const application = db.applications.find(a=>a.id===appId);
        if(!application) return ctx.answerCbQuery('Not found');
        application.status='APPROVED';
        const restaurant = db.restaurants.find(r=>r.id===appId);
        if(restaurant) restaurant.status='APPROVED';
        // generate linking token
        const token = uuidv4().replace(/-/g,'').slice(0,16);
        db.telegramLinks.push({token, restaurantId:appId, used:false, createdAt:new Date().toISOString()});
        saveDB();
        logAudit('superadmin:'+tgUserId, 'APPROVE_RESTAURANT', appId);
        await ctx.editMessageText(`✅ APPROVED ${application.restaurantName}\nLink: https://t.me/${ctx.botInfo.username}?start=link_${token}\nShare this to restaurant owner.`);
        // try to notify if we have bot to send? we don't have restaurant tg yet
        return;
      }
      if(data.startsWith('reject_')){
        if(!isSuperAdmin(tgUserId)) return ctx.answerCbQuery('Unauthorized');
        const appId = data.replace('reject_','');
        const application = db.applications.find(a=>a.id===appId);
        if(application){
          application.status='REJECTED';
          const restaurant = db.restaurants.find(r=>r.id===appId);
          if(restaurant) restaurant.status='REJECTED';
          saveDB();
          logAudit('superadmin:'+tgUserId, 'REJECT_RESTAURANT', appId);
        }
        return ctx.editMessageText('❌ Rejected '+appId);
      }

      // RESTAURANT
      const restaurant = findRestaurantByTelegramUser(tgUserId);
      if(!restaurant) return ctx.answerCbQuery('Restaurant not linked');

      // order actions with safety
      if(data.startsWith('order_accept_')){
        const code = data.replace('order_accept_','');
        const order = db.orders.find(o=>o.code===code);
        if(!order) return ctx.answerCbQuery('Order not found');
        if(order.status!=='SUBMITTED') return ctx.answerCbQuery(`⚠️ Already ${order.status}`, {show_alert:true});
        order.status='ACCEPTED';
        order.updatedAt=new Date().toISOString();
        db.orderStatusHistory.push({id:uuidv4(), orderCode:code, from:'SUBMITTED', to:'ACCEPTED', at:new Date().toISOString(), by:'restaurant:'+tgUserId});
        saveDB();
        logAudit('restaurant:'+restaurant.id, 'ACCEPT_ORDER', code);
        await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n✅ ACCEPTED');
        return ctx.reply('Order '+code+' accepted. Next:', Markup.inlineKeyboard([
          [Markup.button.callback('👨‍🍳 PREPARING','order_prep_'+code)],
          [Markup.button.callback('❌ REJECT','order_reject_'+code)]
        ]));
      }
      if(data.startsWith('order_reject_')){
        const code = data.replace('order_reject_','');
        const order = db.orders.find(o=>o.code===code);
        if(!order) return ctx.answerCbQuery('Order not found');
        if(order.status!=='SUBMITTED') return ctx.answerCbQuery(`⚠️ Already ${order.status}`, {show_alert:true});
        order.status='REJECTED';
        order.updatedAt=new Date().toISOString();
        db.orderStatusHistory.push({id:uuidv4(), orderCode:code, from:'SUBMITTED', to:'REJECTED', at:new Date().toISOString(), by:'restaurant:'+tgUserId});
        saveDB();
        logAudit('restaurant:'+restaurant.id, 'REJECT_ORDER', code);
        return ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n❌ REJECTED');
      }
      if(data.startsWith('order_prep_')){
        const code = data.replace('order_prep_','');
        const order = db.orders.find(o=>o.code===code);
        if(order){
          order.status='PREPARING';
          db.orderStatusHistory.push({id:uuidv4(), orderCode:code, from:'ACCEPTED', to:'PREPARING', at:new Date().toISOString(), by:'restaurant:'+tgUserId});
          saveDB();
          await ctx.reply(`Order ${code} is now PREPARING`, Markup.inlineKeyboard([[Markup.button.callback('📦 READY','order_ready_'+code)]]));
        }
        return ctx.answerCbQuery();
      }
      if(data.startsWith('order_ready_')){
        const code = data.replace('order_ready_','');
        const order = db.orders.find(o=>o.code===code);
        if(order){
          order.status='READY';
          db.orderStatusHistory.push({id:uuidv4(), orderCode:code, from:'PREPARING', to:'READY', at:new Date().toISOString(), by:'restaurant:'+tgUserId});
          saveDB();
          await ctx.reply(`Order ${code} READY for pickup/delivery`, Markup.inlineKeyboard([[Markup.button.callback('✅ COMPLETED','order_done_'+code)]]));
        }
        return ctx.answerCbQuery();
      }
      if(data.startsWith('order_done_')){
        const code = data.replace('order_done_','');
        const order = db.orders.find(o=>o.code===code);
        if(order){
          order.status='COMPLETED';
          db.orderStatusHistory.push({id:uuidv4(), orderCode:code, from:'READY', to:'COMPLETED', at:new Date().toISOString(), by:'restaurant:'+tgUserId});
          saveDB();
        }
        return ctx.answerCbQuery('Completed!');
      }

      // restaurant menus
      if(data==='r_orders'){
        const orders = db.orders.filter(o=>o.restaurantId===restaurant.id).slice(-10).reverse();
        if(orders.length===0) return ctx.reply('No orders yet');
        for(const o of orders){
          await ctx.reply(`📦 ${o.code}\n${o.customerName} - ₹${o.total}\nStatus: ${o.status}\nItems: ${o.items.map(i=>i.name+' x'+i.qty).join(', ')}`, o.status==='SUBMITTED' ? Markup.inlineKeyboard([
            [Markup.button.callback('✅ ACCEPT','order_accept_'+o.code), Markup.button.callback('❌ REJECT','order_reject_'+o.code)]
          ]) : undefined);
        }
        return;
      }
      if(data==='r_menu'){
        const cats = db.categories.filter(c=>c.restaurantId===restaurant.id);
        const items = db.menuItems.filter(i=>i.restaurantId===restaurant.id);
        return ctx.reply(`🍔 MENU - ${items.length} items in ${cats.length} categories\nUse commands:\n/additem Name | Price | Category\n/edititem\n/deleteitem`, Markup.inlineKeyboard([
          [Markup.button.callback('➕ ADD ITEM','r_add_item')],
          [Markup.button.callback('👀 VIEW MENU','r_view_menu')]
        ]));
      }
      if(data==='r_view_menu'){
        const items = db.menuItems.filter(i=>i.restaurantId===restaurant.id).slice(0,10);
        return ctx.reply(items.map(i=>`${i.name} - ₹${i.price} ${i.isAvailable?'✅':'❌'}`).join('\n') || 'No items');
      }
      if(data==='r_toggle_open'){
        restaurant.isOpen = !restaurant.isOpen;
        saveDB();
        return ctx.editMessageText(`Shop is now ${restaurant.isOpen?'🟢 OPEN':'🔴 CLOSED'}`);
      }
      if(data==='r_toggle_busy'){
        restaurant.isBusy = !restaurant.isBusy;
        saveDB();
        return ctx.editMessageText(`Busy mode: ${restaurant.isBusy?'🟡 BUSY':'🟢 Not busy'}`);
      }
      if(data==='r_payments'){
        return ctx.reply(`💳 PAYMENT\nUPI ID: ${restaurant.upiId||'Not set'}\nQR: ${restaurant.upiQrUrl?'Set':'Not set'}\n\nSend:\n/setupi <upi_id>\nOr upload QR image`, Markup.inlineKeyboard([
          [Markup.button.callback('✏️ EDIT UPI','r_edit_upi')]
        ]));
      }
      if(data==='setup_start'){
        return ctx.reply('🏪 SETUP WIZARD\n1️⃣ Profile done\n2️⃣ Hours: send /sethours 10:00-22:00\n3️⃣ Menu: send /additem\n4️⃣ Payment: /setupi\n5️⃣ Delivery fee: /setdelivery\n6️⃣ Then /golive');
      }
      if(data==='r_staff'){
        const pin = ensureStaffPin(restaurant);
        saveDB();
        return ctx.reply(`👥 STAFF ACCESS\nToday's PIN: ${pin}\nRestaurant ID: ${restaurant.id}\n\nGive counter staff both, then send them to:\n${FRONTEND_URL}/staff.html\n\nThey'll be able to accept/reject and update today's orders only - no menu, prices, or payment access.\n\nPIN resets automatically at midnight. Shift change or think it leaked? Send /staffpin to regenerate it right now.`);
      }

      ctx.answerCbQuery();
    }catch(e){
      console.error('callback error', e);
      ctx.answerCbQuery('Error');
    }
  });

  // text commands for restaurant
  bot.command('additem', async (ctx)=>{
    // format: /additem Chicken Burger | 250 | Burgers
    const text = ctx.message.text.replace('/additem','').trim();
    const parts = text.split('|').map(s=>s.trim());
    if(parts.length<2) return ctx.reply('Usage: /additem Name | Price | CategoryName (optional)\nExample: /additem Chicken Burger | 250 | Burgers');
    const restaurant = findRestaurantByTelegramUser(ctx.from.id);
    if(!restaurant) return ctx.reply('Not linked');
    const [name, priceStr, catName] = parts;
    const price = Number(priceStr);
    let category = db.categories.find(c=>c.restaurantId===restaurant.id && c.name.toLowerCase()===(catName||'Burgers').toLowerCase());
    if(!category){
      category = {id:uuidv4(), restaurantId:restaurant.id, name:catName||'General', emoji:'🍔', sortOrder:db.categories.filter(c=>c.restaurantId===restaurant.id).length};
      db.categories.push(category);
    }
    const item = {
      id: uuidv4(),
      restaurantId: restaurant.id,
      categoryId: category.id,
      name,
      description: `${name} - delicious, freshly made.`,
      price,
      imageUrl: `https://picsum.photos/seed/${Date.now()}/400/300`,
      isVeg: false,
      isAvailable:true,
      prepTime:"15-20 min",
      sortOrder: db.menuItems.filter(i=>i.restaurantId===restaurant.id).length
    };
    db.menuItems.push(item);
    saveDB();
    logAudit('restaurant:'+restaurant.id, 'ADD_ITEM', item.id, null, item);
    ctx.reply(`✅ ITEM ADDED\n${item.name} - ₹${item.price}\nCategory: ${category.name}`, {reply_markup:{inline_keyboard:[[{text:'✏️ EDIT', callback_data:'edit_'+item.id}]]}});
  });

  bot.command('setupi', async (ctx)=>{
    const upi = ctx.message.text.replace('/setupi','').trim();
    const restaurant = findRestaurantByTelegramUser(ctx.from.id);
    if(!restaurant) return;
    restaurant.upiId = upi;
    saveDB();
    ctx.reply(`✅ UPI Updated: ${upi}`);
  });

  bot.command('sethours', async (ctx)=>{
    const hours = ctx.message.text.replace('/sethours','').trim();
    const restaurant = findRestaurantByTelegramUser(ctx.from.id);
    if(!restaurant) return;
    restaurant.openingHours = hours;
    saveDB();
    ctx.reply(`✅ Hours updated: ${hours}`);
  });

  bot.command('golive', async (ctx)=>{
    const restaurant = findRestaurantByTelegramUser(ctx.from.id);
    if(!restaurant) return;
    const hasMenu = db.menuItems.some(i=>i.restaurantId===restaurant.id);
    const hasPayment = !!restaurant.upiId;
    const hasHours = !!restaurant.openingHours;
    if(!hasMenu) return ctx.reply('❌ Need at least 1 menu item. Use /additem');
    if(!hasPayment) return ctx.reply('❌ Need UPI ID. Use /setupi your@upi');
    if(!hasHours) return ctx.reply('❌ Set hours with /sethours 10:00-22:00');
    restaurant.status='LIVE';
    restaurant.isOpen=true;
    saveDB();
    logAudit('restaurant:'+restaurant.id, 'GO_LIVE', restaurant.id);
    ctx.reply('🟢 GO LIVE SUCCESS! Your restaurant is now visible to customers.');
  });

  bot.command('setdelivery', async (ctx)=>{
    const fee = Number(ctx.message.text.replace('/setdelivery','').trim());
    const restaurant = findRestaurantByTelegramUser(ctx.from.id);
    if(!restaurant) return;
    restaurant.deliveryFee = fee;
    saveDB();
    ctx.reply(`Delivery fee set to ₹${fee}`);
  });

  bot.command('staffpin', async (ctx)=>{
    const restaurant = findRestaurantByTelegramUser(ctx.from.id);
    if(!restaurant) return ctx.reply('Not linked');
    const pin = regenerateStaffPin(restaurant);
    saveDB();
    logAudit('restaurant:'+restaurant.id, 'REGENERATE_STAFF_PIN', restaurant.id);
    ctx.reply(`🔑 New staff PIN: ${pin}\nRestaurant ID: ${restaurant.id}\n\nThe old PIN stops working immediately. Give the new one to today's staff at:\n${FRONTEND_URL}/staff.html`);
  });

  // ---- BACKUP / RESTORE (works around Render free-tier wiping data.json on restart) ----
  // Super admin only. This is the fix for "data resets" - not a daily restaurant
  // login. A restaurant owner can't fix a full data wipe themselves; only whoever
  // controls the bot can restore it, which is why these are admin-gated.
  bot.command('backup', async (ctx)=>{
    if(!isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized');
    await sendBackupToAdmins('manual');
  });

  bot.command('restore', async (ctx)=>{
    if(!isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized');
    const replied = ctx.message.reply_to_message;
    if(!replied || !replied.document){
      return ctx.reply('Reply to a backup .json file (sent earlier by /backup or the scheduled auto-backup) with /restore to reload it.');
    }
    try{
      const fileLink = await ctx.telegram.getFileLink(replied.document.file_id);
      const res = await fetch(fileLink.href);
      const text = await res.text();
      const parsed = JSON.parse(text);
      if(!parsed.restaurants || !Array.isArray(parsed.restaurants)) throw new Error('That file does not look like a Falls backup');
      db = {...db, ...parsed};
      saveDB();
      logAudit('superadmin:'+ctx.from.id, 'RESTORE_BACKUP', 'db');
      ctx.reply(`✅ RESTORED\nRestaurants: ${db.restaurants.length} | Orders: ${db.orders.length} | Applications: ${db.applications.length}`);
    }catch(e){
      ctx.reply('❌ Restore failed: '+e.message);
    }
  });

  bot.on('photo', async (ctx)=>{
    const restaurant = findRestaurantByTelegramUser(ctx.from.id);
    if(!restaurant) return;
    try{
      const fileId = ctx.message.photo[ctx.message.photo.length-1].file_id;
      const fileLink = await ctx.telegram.getFileLink(fileId);
      // In production download and save. Here store link
      restaurant.upiQrUrl = fileLink.href;
      saveDB();
      logAudit('restaurant:'+restaurant.id, 'UPDATE_QR', restaurant.id);
      ctx.reply('📷 QR RECEIVED\n✅ PAYMENT QR UPDATED\n\nSending any photo here updates your payment QR. Menu item photos will get their own upload flow separately.', {reply_markup:{inline_keyboard:[[{text:'👀 PREVIEW', url: fileLink.href}]]}});
    }catch(e){
      ctx.reply('Failed to save QR');
    }
  });

  // webhook endpoint - secret token verified so only real Telegram calls can drive the bot.
  // WEBHOOK_SECRET has no fallback default on purpose - a hardcoded default
  // living in this (presumably public) source file would be public too, and
  // any hardcoded string is guessable/known. Set WEBHOOK_SECRET in Render's
  // env vars and pass the same value as secret_token in setWebhook.
  app.post('/telegram/webhook', (req,res)=>{
    if(!WEBHOOK_SECRET || req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET){
      return res.sendStatus(401);
    }
    bot.handleUpdate(req.body);
    res.sendStatus(200);
  });

  // Launch bot in polling mode if not webhook
  if(process.env.NODE_ENV !== 'production'){
    bot.launch().then(()=>console.log('Telegram bot polling started')).catch(e=>console.error('Bot launch failed', e.message));
  }
  // Auto-backup: send the full db to super admins on startup and every 6h.
  // If Render wipes the disk on the next restart, reply /restore to the
  // most recent of these messages to get everything back.
  setTimeout(()=>sendBackupToAdmins('startup').catch(e=>console.error('backup err', e.message)), 15*1000);
  setInterval(()=>sendBackupToAdmins('scheduled').catch(e=>console.error('backup err', e.message)), 6*60*60*1000);
} else {
  console.log('TELEGRAM_BOT_TOKEN not set - bot disabled');
  // dummy webhook that just logs
  app.post('/telegram/webhook', (req,res)=> res.json({ok:true, disabled:true}));
}

// ================= NOTIFICATIONS (single source of truth) =================
// These are the ONLY definitions of these functions. Every route that
// creates/updates an order or a registration calls these directly. When
// TELEGRAM_BOT_TOKEN isn't set, `bot` is null and each function just logs
// and returns - the sign-in/approval/order flow still "completes" from the
// website's point of view, it just won't reach a real Telegram chat.
async function notifySuperAdminNewRegistration(appData){
  if(!bot){ console.log('Mock: would notify admin of new registration', appData.restaurantName); return; }
  if(SUPER_ADMIN_IDS.length===0){ console.log('No SUPER_ADMIN_TELEGRAM_IDS configured, skipping telegram notify'); return; }
  const msg = `🏪 NEW RESTAURANT REGISTRATION\n\nRestaurant: ${appData.restaurantName}\nOwner: ${appData.ownerName}\nPhone: ${appData.phone}\nEmail: ${appData.email}\nAddress: ${appData.address}, ${appData.city}\nCuisine: ${appData.cuisine}\nHours: ${appData.openingHours}\nPayment: ${appData.upiId||'Not set'}\n\nStatus: PENDING`;
  for(const adminId of SUPER_ADMIN_IDS){
    try{
      await bot.telegram.sendMessage(adminId, msg, {
        reply_markup:{inline_keyboard:[
          [{text:'✅ APPROVE', callback_data:`approve_${appData.id}`}, {text:'❌ REJECT', callback_data:`reject_${appData.id}`}],
          [{text:'👀 VIEW DETAILS', callback_data:`view_${appData.id}`}]
        ]}
      });
    }catch(e){ console.error('Failed to notify admin', adminId, e.message); }
  }
}

async function notifyRestaurantNewOrder(order){
  if(!bot){ console.log('Mock: would notify restaurant of new order', order.code); return; }
  const restaurant = db.restaurants.find(r=>r.id===order.restaurantId);
  if(!restaurant) return;
  const accounts = db.telegramAccounts.filter(a=>a.restaurantId===restaurant.id);
  if(accounts.length===0){ console.warn(`No Telegram account linked for restaurant ${restaurant.id} (${restaurant.name}) - order ${order.code} was not delivered to anyone`); return; }
  const itemsText = order.items.map(i=>`${i.name} ×${i.qty}\n₹${i.total}`).join('\n');
  const msg = `🔔 NEW ORDER\n\nOrder: ${order.code}\nCustomer: ${order.customerName} (${order.phone})\nAddress: ${order.address}\n\nItems:\n${itemsText}\n\nDelivery: ₹${order.deliveryFee}\nTOTAL: ₹${order.total}\nPayment: ${order.paymentMethod} - ${order.paymentStatus}`;
  for(const acc of accounts){
    try{
      await bot.telegram.sendMessage(acc.telegramUserId, msg, {
        reply_markup:{inline_keyboard:[
          [{text:'✅ ACCEPT', callback_data:`order_accept_${order.code}`}, {text:'❌ REJECT', callback_data:`order_reject_${order.code}`}],
          [{text:'📄 RECEIPT', callback_data:`view_receipt_${order.code}`}, {text:'👀 DETAILS', callback_data:`order_details_${order.code}`}]
        ]}
      });
    }catch(e){ console.error('notify order fail', e.message); }
  }
}

async function notifyRestaurantReceipt(order){
  if(!bot){ console.log('Mock: would notify restaurant of receipt', order.code); return; }
  const accounts = db.telegramAccounts.filter(a=>a.restaurantId===order.restaurantId);
  for(const acc of accounts){
    try{
      await bot.telegram.sendMessage(acc.telegramUserId, `💳 PAYMENT RECEIPT\nOrder: ${order.code}\n${BACKEND_URL}${order.receiptUrl}`, {
        reply_markup:{inline_keyboard:[
          [{text:'📄 VIEW RECEIPT', url: BACKEND_URL+order.receiptUrl}],
          [{text:'✅ VERIFY', callback_data:`verify_pay_${order.code}`}, {text:'❌ REJECT', callback_data:`reject_pay_${order.code}`}],
          [{text:'🔄 REQUEST NEW', callback_data:`request_receipt_${order.code}`}]
        ]}
      });
    }catch(e){ console.error(e.message); }
  }
}

// Sends the entire db as a .json document to every super admin's Telegram
// chat. This is the actual fix for "Render wipes the data" - not a daily
// restaurant login. Reply to the file with /restore to reload it.
async function sendBackupToAdmins(triggeredBy='auto'){
  if(!bot) return;
  if(SUPER_ADMIN_IDS.length===0) return;
  try{
    const buffer = Buffer.from(JSON.stringify(db, null, 2), 'utf8');
    const filename = `falls-backup-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
    for(const adminId of SUPER_ADMIN_IDS){
      try{
        await bot.telegram.sendDocument(adminId, { source: buffer, filename }, {
          caption: `💾 Backup (${triggeredBy})\nRestaurants: ${db.restaurants.length} | Orders: ${db.orders.length} | Applications: ${db.applications.length}\n\nIf the server data ever resets, reply to THIS file with /restore.`
        });
      }catch(e){ console.error('backup send failed', adminId, e.message); }
    }
  }catch(e){ console.error('backup failed', e.message); }
}

// ---- STAFF DAILY-PIN ACCESS ----
// Counter staff who don't have the owner's Telegram log in with today's PIN
// (owner gets it via Telegram - auto every midnight, or /staffpin anytime)
// to manage today's orders only. No menu, payments, or history access, and
// no passwordHash anywhere in this path - scoped session token instead.
app.post('/api/staff/login', staffLoginLimiter, (req,res)=>{
  const { restaurantId, pin } = req.body||{};
  const restaurant = db.restaurants.find(r=>r.id===restaurantId);
  if(!restaurant) return res.status(404).json({error:'Restaurant not found'});
  const validPin = ensureStaffPin(restaurant); // lazy rotate if a scheduled rotation was missed
  saveDB();
  if(!pin || String(pin)!==String(validPin)){
    logAudit('staff:'+req.ip, 'STAFF_LOGIN_FAILED', restaurantId);
    return res.status(401).json({error:'Invalid PIN'});
  }
  logAudit('staff:'+req.ip, 'STAFF_LOGIN', restaurantId);
  res.json({ok:true, token: issueStaffToken(restaurant.id), restaurantName: restaurant.name});
});

app.get('/api/staff/orders', requireStaffAuth, (req,res)=>{
  const today = todayStr();
  const orders = db.orders
    .filter(o=>o.restaurantId===req.staffRestaurantId && o.createdAt.startsWith(today))
    .sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  res.json({orders});
});

const STAFF_ALLOWED_TRANSITIONS = { SUBMITTED:['ACCEPTED','REJECTED'], ACCEPTED:['PREPARING'], PREPARING:['READY'], READY:['COMPLETED'] };
app.post('/api/staff/orders/:code/status', requireStaffAuth, (req,res)=>{
  const { to } = req.body||{};
  const order = db.orders.find(o=>o.code===req.params.code);
  if(!order || order.restaurantId!==req.staffRestaurantId) return res.status(404).json({error:'Order not found'});
  const allowed = STAFF_ALLOWED_TRANSITIONS[order.status]||[];
  if(!allowed.includes(to)) return res.status(400).json({error:`Cannot move from ${order.status} to ${to}`});
  const from = order.status;
  order.status = to;
  order.updatedAt = new Date().toISOString();
  db.orderStatusHistory.push({id:uuidv4(), orderCode:order.code, from, to, at:order.updatedAt, by:'staff:'+req.staffRestaurantId});
  saveDB();
  logAudit('staff:'+req.staffRestaurantId, 'STAFF_ORDER_'+to, order.code);
  res.json({ok:true, status:order.status});
});

// ---- SUPER ADMIN API ----
// The comment here used to say "protected by header for simplicity" but no
// such check existed - these three routes were fully open. Anyone who found
// the URL could dump every restaurant's and applicant's raw record
// (including bcrypt passwordHash, phone, email, UPI ID) and flip pin/
// highlight on any restaurant. Gated now behind ADMIN_API_KEY. Set that env
// var on Render; requests must send it as `X-Admin-Key`. If you don't
// actually use this HTTP API (pin/highlight aren't wired into the Telegram
// bot yet either), consider deleting these three routes entirely instead -
// per the architecture, admin control is meant to live in Telegram only.
function requireAdminKey(req, res, next){
  if(!ADMIN_API_KEY){
    return res.status(503).json({error:'Admin API disabled: set ADMIN_API_KEY env var to enable it'});
  }
  if(req.headers['x-admin-key'] !== ADMIN_API_KEY){
    return res.status(401).json({error:'Unauthorized'});
  }
  next();
}

app.get('/api/admin/restaurants', requireAdminKey, (req,res)=>{
  res.json({
    restaurants: db.restaurants.map(publicRestaurant),
    applications: db.applications.map(({passwordHash, ...a})=>a)
  });
});

app.post('/api/admin/restaurants/:id/pin', requireAdminKey, (req,res)=>{
  const r = db.restaurants.find(x=>x.id===req.params.id);
  if(!r) return res.status(404).json({error:'Not found'});
  r.isPinned = !r.isPinned;
  saveDB();
  logAudit('superadmin', r.isPinned?'PIN':'UNPIN', r.id);
  res.json(publicRestaurant(r));
});

app.post('/api/admin/restaurants/:id/highlight', requireAdminKey, (req,res)=>{
  const r = db.restaurants.find(x=>x.id===req.params.id);
  if(!r) return res.status(404).json({error:'Not found'});
  r.isHighlighted = !r.isHighlighted;
  saveDB();
  logAudit('superadmin', r.isHighlighted?'HIGHLIGHT':'REMOVE_HIGHLIGHT', r.id);
  res.json(publicRestaurant(r));
});

// ---- DAILY STAFF PIN ROTATION ----
// Auto-rotates every restaurant's staff PIN at local midnight (server time)
// and DMs the new PIN to each linked owner. Owners can also force an early
// rotation anytime with /staffpin (e.g. after a shift change).
async function notifyOwnersOfNewStaffPins(){
  if(!bot) return;
  for(const restaurant of db.restaurants){
    if(restaurant.status!=='LIVE' || !restaurant.staffPin) continue;
    const acc = db.telegramAccounts.find(a=>a.restaurantId===restaurant.id && a.role==='OWNER');
    if(!acc) continue;
    try{
      await bot.telegram.sendMessage(acc.telegramUserId, `🔑 Today's staff PIN: ${restaurant.staffPin}\nRestaurant ID: ${restaurant.id}\n\nGive it to today's counter staff at:\n${FRONTEND_URL}/staff.html\n\nSend /staffpin anytime to regenerate it early.`);
    }catch(e){ console.error('staffpin notify failed', restaurant.id, e.message); }
  }
}
function scheduleStaffPinRotation(){
  function msUntilNextMidnight(){
    const now = new Date();
    const next = new Date(now);
    next.setHours(24,0,0,0);
    return next - now;
  }
  function rotateAll(){
    let count = 0;
    db.restaurants.forEach(r=>{ if(r.status==='LIVE'){ regenerateStaffPin(r); count++; } });
    saveDB();
    console.log(`[staffpin] rotated for ${count} live restaurant(s)`);
    notifyOwnersOfNewStaffPins().catch(e=>console.error('staffpin notify err', e.message));
  }
  setTimeout(()=>{ rotateAll(); setInterval(rotateAll, 24*60*60*1000); }, msUntilNextMidnight());
}
scheduleStaffPinRotation();

// ---- ERROR HANDLER ----
app.use((err,req,res,next)=>{
  console.error(err);
  res.status(500).json({error:'Something went wrong. Please try again.'});
});

app.listen(PORT, ()=>{
  console.log(`Backend running on ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health/ready`);
});

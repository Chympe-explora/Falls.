
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

// DATA_DIR controls where data.json and /uploads actually live on disk.
// Render's FREE plan gives every deploy a brand-new, empty filesystem - so
// by default (DATA_DIR unset) everything here is wiped on every restart,
// and the Telegram auto-backup + /restore flow below is the ONLY thing
// standing between you and losing all restaurant data.
// To make it genuinely restart-proof with no manual /restore step:
//   1. Upgrade the Render service off the Free plan (a persistent Disk is
//      not available on Free - see backend/render.yaml, which has a disk
//      block ready to enable once you're on a paid plan).
//   2. Set DATA_DIR in Render's env vars to the disk's mount path
//      (render.yaml mounts it at /var/data).
// With that done, every write below (saveDB + every image upload) lands on
// the persistent disk directly - a restart or redeploy no longer touches
// it at all. The Telegram backup keeps running either way as a second
// safety net (e.g. accidental data.json edits), it just stops being the
// only thing keeping you safe.
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, {recursive:true});
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, {recursive:true});
console.log(process.env.DATA_DIR
  ? `💾 Persistent disk in use (DATA_DIR=${DATA_DIR}) - data survives restarts automatically.`
  : `⚠️  No DATA_DIR set - data.json and /uploads live on Render's ephemeral disk and WILL be wiped on restart/redeploy. Relying on the Telegram auto-backup + /restore for persistence. See the DATA_DIR comment above to make this permanent.`);

// ---- GITHUB-BACKED CONTENT PERSISTENCE (survives resets with NO paid plan) ----
// This is the real fix for "the website's restaurant data must survive a
// Render reset": restaurants/categories/menu items/pending changes get
// committed straight to your GitHub repo as a data file, in addition to
// the local data.json write. Render always redeploys by re-cloning your
// repo from scratch - so unlike anything written to local disk (which is
// wiped every restart on the Free plan), a git commit is permanent. It's
// genuinely part of "the code" now, exactly as asked for.
// On boot, this repo file is read FIRST (source of truth for content), and
// only falls back to the local file / blank 200-slot seed if GitHub isn't
// configured or the repo file doesn't exist yet.
// Orders/receipts/audit logs deliberately stay OUT of git (local disk +
// existing Telegram backup only) - those change on every single order, and
// committing that volume to git would spam your repo history and quickly
// burn through GitHub's API rate limit. Menu/restaurant content changes far
// less often, so it's a good fit for "the code" model.
// Setup: create a GitHub Personal Access Token with "repo" scope, then set
// GITHUB_TOKEN and GITHUB_REPO=("yourname/yourrepo") in Render's env vars.
// Nothing else to do - it activates automatically once both are set.
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || ''; // "owner/repo"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_CONTENT_PATH = process.env.GITHUB_CONTENT_PATH || 'backend/content-data.json';
const GITHUB_CONTENT_FIELDS = ['restaurants','categories','menuItems','pendingChanges'];
const GITHUB_API = 'https://api.github.com';
function githubConfigured(){ return !!(GITHUB_TOKEN && GITHUB_REPO); }
async function githubGetContentFile(){
  const res = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(GITHUB_CONTENT_PATH)}?ref=${GITHUB_BRANCH}`, {
    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept:'application/vnd.github+json' }
  });
  if(res.status===404) return {content:null, sha:null};
  if(!res.ok) throw new Error(`GitHub GET ${res.status}: ${await res.text().catch(()=> '')}`);
  const data = await res.json();
  return {content: JSON.parse(Buffer.from(data.content,'base64').toString('utf8')), sha: data.sha};
}
async function githubPutContentFile(contentObj, sha, message){
  const body = {
    message,
    content: Buffer.from(JSON.stringify(contentObj,null,2)).toString('base64'),
    branch: GITHUB_BRANCH
  };
  if(sha) body.sha = sha;
  const res = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(GITHUB_CONTENT_PATH)}`, {
    method:'PUT',
    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept:'application/vnd.github+json', 'Content-Type':'application/json' },
    body: JSON.stringify(body)
  });
  if(!res.ok) throw new Error(`GitHub PUT ${res.status}: ${await res.text().catch(()=> '')}`);
  return res.json();
}
// Simple in-process queue so two near-simultaneous edits (e.g. approving two
// pending changes back to back) don't race on the file's SHA and clobber
// each other - each commit waits for the previous one to finish first.
let githubSyncQueue = Promise.resolve();
function syncContentToGitHub(message){
  if(!githubConfigured()) return Promise.resolve();
  githubSyncQueue = githubSyncQueue.then(async ()=>{
    try{
      const {sha} = await githubGetContentFile();
      const contentObj = {};
      for(const f of GITHUB_CONTENT_FIELDS) contentObj[f] = db[f];
      await githubPutContentFile(contentObj, sha, `content update: ${message}`);
      console.log('✅ GitHub content commit OK:', message);
    }catch(e){
      console.error('❌ GitHub content commit FAILED:', e.message);
    }
  });
  return githubSyncQueue;
}
async function loadContentFromGitHub(){
  if(!githubConfigured()) return false;
  try{
    const {content} = await githubGetContentFile();
    if(!content) return false; // file doesn't exist in the repo yet - first-ever boot, nothing to restore
    for(const f of GITHUB_CONTENT_FIELDS){
      if(content[f] !== undefined) db[f] = content[f];
    }
    console.log(`💾 Content restored from GitHub (${GITHUB_REPO}) - restaurants/menu survive resets automatically.`);
    return true;
  }catch(e){
    console.error('loadContentFromGitHub failed:', e.message);
    return false;
  }
}

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
  pendingChanges: [], // items/prices/images submitted by a restaurant, awaiting Super Admin approval before going live
  auditLogs: [],
  idempotency: {}, // key -> orderCode
  receipts: [],
  systemPaused: false // platform-wide emergency pause, toggled from the Super Admin bot
};

let dbFileExistedAtBoot = true;
function loadDB(){
  try{
    if(fs.existsSync(DATA_FILE)){
      const raw = fs.readFileSync(DATA_FILE,'utf8');
      const parsed = JSON.parse(raw);
      db = {...db, ...parsed};
      console.log('DB loaded');
    } else {
      dbFileExistedAtBoot = false;
    }
  }catch(e){ console.error('DB load error', e); }
}
function saveDB(){
  try{ fs.writeFileSync(DATA_FILE, JSON.stringify(db,null,2)); }catch(e){ console.error('save error', e); }
}
loadDB();
// If data.json didn't exist at boot (typical after a Render Free restart)
// AND there's no persistent DATA_DIR, the 200 slots would normally get
// reseeded blank below - UNLESS GitHub content persistence is configured
// and successfully restores real data first (see bootstrapContent below,
// which finalizes this flag after attempting that restore).
let dbLikelyWiped = !dbFileExistedAtBoot && !process.env.DATA_DIR;

if(TELEGRAM_BOT_TOKEN && process.env.NODE_ENV === 'production' && !WEBHOOK_SECRET){
  console.warn('⚠️  WEBHOOK_SECRET is not set. /telegram/webhook will reject ALL requests (including real ones from Telegram) until you set it in Render env vars.');
}

// seed if empty
// ---- 200 NUMBERED RESTAURANT SLOTS (001-200) ----
// These are blank/placeholder slots reserved up front, NOT demo/fake
// restaurants. Each carries a permanent 3-digit `code` (001-200) that the
// Super Admin uses in Telegram (/show 001, /hide 001) to control visibility
// on the live website. A slot starts EMPTY (status:'DRAFT', isVisible:false)
// and gets filled in when a real restaurant registers and is approved - see
// claimNextOpenSlot() in the registration route below. Codes/ids never
// change once created, so bookmarked links, Telegram account links, and
// past order.restaurantId references never break on reseed.
const TOTAL_RESTAURANT_SLOTS = 200;
function seedRestaurantSlotsIfEmpty(){
  if(db.restaurants.length!==0) return false;
  for(let n=1;n<=TOTAL_RESTAURANT_SLOTS;n++){
    const code = String(n).padStart(3,'0');
    const id = `rest-${code}`;
    db.restaurants.push({
      id,
      code,                    // permanent 3-digit identifier, e.g. "001"
      name: `Slot ${code} (unassigned)`,
      ownerName: null,
      phone: null,
      email: null,
      address: '',
      city: '',
      cuisine: '',
      description: '',
      logoUrl: null,
      coverUrl: null,
      status: 'DRAFT',         // DRAFT (empty slot) -> PENDING -> APPROVED -> LIVE
      isVisible: false,        // separate admin-only gate; see /api/restaurants filter
      isPinned: false,
      isHighlighted: false,
      isOpen: false,
      isBusy: false,
      deliveryFee: 30,
      minOrder: 149,
      deliveryTime: "25-35 min",
      rating: 0,
      openingHours: '',
      upiId: '',
      upiQrUrl: null,
      createdAt: new Date().toISOString(),
      passwordHash: null
    });
  }
  saveDB();
  return true;
}
// Runs once at boot: tries to restore restaurant/menu content from GitHub
// first (source of truth when configured), and only falls back to seeding
// 200 blank slots if that didn't produce anything. Resolving this BEFORE
// app.listen() (see the very bottom of this file) avoids serving requests
// off an empty/half-initialized db during the brief window a cold boot
// takes to reach GitHub.
async function bootstrapContent(){
  const restored = await loadContentFromGitHub();
  if(restored){
    // Real content came back from git - this was not actually a loss, just
    // Render's normal ephemeral-disk restart. Don't alarm the admin over it.
    dbLikelyWiped = false;
    console.log(`Slots in use after GitHub restore: ${db.restaurants.filter(r=>r.status!=='DRAFT').length}/${TOTAL_RESTAURANT_SLOTS}`);
  }
  const seeded = seedRestaurantSlotsIfEmpty();
  if(seeded && githubConfigured()){
    // First-ever boot with GitHub configured but no content file in the
    // repo yet - commit the initial 200 blank slots so they exist in git
    // (as "the code") from this point forward.
    await syncContentToGitHub('initial 200-slot seed');
  }
}
const contentBootstrapPromise = bootstrapContent();
// real restaurant. Used by registration instead of minting a brand new id,
// so every restaurant that ever exists on this platform has a stable
// 3-digit code the admin can reference in Telegram.
function claimNextOpenSlot(){
  const open = db.restaurants
    .filter(r=>r.status==='DRAFT')
    .sort((a,b)=> a.code.localeCompare(b.code));
  return open[0] || null;
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

// ---- REVIEW-BEFORE-PUBLISH PIPELINE ----
// Every item/price/image a restaurant submits from Telegram lands here
// first as a PENDING change - nothing touches the live menu (and therefore
// nothing a customer sees) until the Super Admin taps APPROVE. This is the
// "everything goes through me first" control the admin asked for. Applying
// a change only ever writes db.menuItems[].price/name/etc - it never
// touches an already-placed order, since orders always store their own
// price snapshot taken at checkout time (see POST /api/orders above).
function submitForReview(restaurant, type, payload, summary){
  const change = {
    id: uuidv4(),
    restaurantId: restaurant.id,
    code: restaurant.code,
    restaurantName: restaurant.name,
    type, // 'ADD_ITEM' | 'EDIT_PRICE' | 'EDIT_ITEM' | 'ITEM_IMAGE'
    payload,
    summary,
    status: 'PENDING',
    createdAt: new Date().toISOString()
  };
  db.pendingChanges.push(change);
  saveDB();
  logAudit('restaurant:'+restaurant.id, 'SUBMIT_CHANGE_'+type, change.id, null, change);
  if(bot && SUPER_ADMIN_IDS.length){
    const text = `📝 CHANGE SUBMITTED FOR REVIEW\n[${restaurant.code}] ${restaurant.name}\n\n${summary}\n\nNothing goes live on the website until you approve this.`;
    for(const adminId of SUPER_ADMIN_IDS){
      bot.telegram.sendMessage(adminId, text, {reply_markup:{inline_keyboard:[
        [{text:'✅ APPROVE & PUBLISH', callback_data:'pc_approve_'+change.id}, {text:'❌ REJECT', callback_data:'pc_reject_'+change.id}]
      ]}}).catch(e=>console.error('submitForReview notify failed', e.message));
    }
  }
  return change;
}
function applyPendingChange(change){
  const restaurant = db.restaurants.find(r=>r.id===change.restaurantId);
  if(!restaurant) return {ok:false, error:'Restaurant no longer exists'};
  if(change.type==='ADD_ITEM'){
    const { name, price, catName } = change.payload;
    let category = db.categories.find(c=>c.restaurantId===restaurant.id && c.name.toLowerCase()===(catName||'General').toLowerCase());
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
      isAvailable: true,
      prepTime: "15-20 min",
      sortOrder: db.menuItems.filter(i=>i.restaurantId===restaurant.id).length
    };
    db.menuItems.push(item);
  } else if(change.type==='EDIT_PRICE'){
    const item = db.menuItems.find(i=>i.id===change.payload.itemId && i.restaurantId===restaurant.id);
    if(!item) return {ok:false, error:'Item no longer exists'};
    // Only the live price field changes. Every order already placed keeps
    // the unitPrice it snapshotted at checkout - this can never retroactively
    // change a past order's total.
    item.price = change.payload.newPrice;
  } else if(change.type==='ITEM_IMAGE'){
    const item = db.menuItems.find(i=>i.id===change.payload.itemId && i.restaurantId===restaurant.id);
    if(!item) return {ok:false, error:'Item no longer exists'};
    item.imageUrl = change.payload.imageUrl;
  } else {
    return {ok:false, error:'Unknown change type'};
  }
  saveDB();
  return {ok:true};
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
  // A restaurant only ever appears to customers when BOTH are true:
  // (1) it went LIVE itself (menu+payment+hours set, via /golive), AND
  // (2) the Super Admin explicitly allowed it via Telegram (/show <code>).
  // (1) alone is not enough - this is the deliberate admin visibility gate.
  let list = db.restaurants.filter(r=>r.status==='LIVE' && r.isVisible===true);
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
  if(!r || r.status!=='LIVE' || r.isVisible!==true) return res.status(404).json({error:'Not found'});
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
    const slot = claimNextOpenSlot();
    if(!slot){
      return res.status(409).json({error:'All 200 restaurant slots are full. Contact the admin.'});
    }
    const id = slot.id; // reuse the pre-numbered slot's stable id/code - never mint a new one
    const appEntry = {
      id,
      code: slot.code,
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
    // fill in the reserved slot - keep its id/code, isVisible stays false
    // until the Super Admin explicitly allows it via /show <code> in Telegram
    Object.assign(slot, {
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
      isVisible: false,
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
      passwordHash: appEntry.passwordHash
    });
    saveDB();
    logAudit('restaurant:'+email, 'REGISTER', id);

    // Silent admin notification via Telegram
    await notifySuperAdminNewRegistration(appEntry);

    res.json({ok:true, message:'Registration submitted. Awaiting admin approval.', id, code: slot.code});
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
    if(db.systemPaused) return res.status(503).json({error:'Ordering is temporarily paused. Please try again shortly.'});
    const restaurant = db.restaurants.find(r=>r.id===restaurantId);
    if(!restaurant || restaurant.status!=='LIVE' || restaurant.isVisible!==true) return res.status(400).json({error:'Restaurant unavailable'});
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
  // Send the receipt image itself (not just a link) straight into the
  // restaurant's Telegram chat, with the full order attached as the caption.
  notifyRestaurantReceipt(order, req.file.path, req.file.mimetype).catch(console.error);
  res.json({ok:true, url});
});

// ================= TELEGRAM BOT =================
let bot = null;
if(TELEGRAM_BOT_TOKEN){
  const { Telegraf, Markup } = require('telegraf');
  bot = new Telegraf(TELEGRAM_BOT_TOKEN);
  // Super admins who tapped "📢 Announcements" and whose next text message
  // should be broadcast to every live restaurant, instead of being treated
  // as a normal chat message.
  const pendingBroadcastAdmins = new Set();

  // /start
  bot.start(async (ctx)=>{
    const payload = ctx.message.text.split(' ')[1] || '';
    const tgUserId = ctx.from.id;

    if(isSuperAdmin(tgUserId)){
      return showSuperAdminMenu(ctx);
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

  function showSuperAdminMenu(ctx){
    return ctx.reply(`👑 SUPER ADMIN\nWelcome to Control Center\nOrdering: ${db.systemPaused ? '⏸ PAUSED' : '🟢 ACTIVE'}\nSlots used: ${db.restaurants.filter(r=>r.status!=='DRAFT').length}/${TOTAL_RESTAURANT_SLOTS}\n\n👁 VISIBILITY: /show 001 makes restaurant 001 visible on the website, /hide 001 hides it. This is the only way a restaurant becomes visible - required even after it goes LIVE.\n\n✏️ PENDING EDITS: /pending lists menu/price/image changes submitted by restaurants that are waiting for your approval before they go live.\n\n💾 data.json is sent here automatically whenever a restaurant goes live or updates its info. Send /backup anytime for an on-demand copy. If data ever resets, reply /restore to the latest file.`, Markup.inlineKeyboard([
      [Markup.button.callback('🏪 Restaurants','sa_restaurants')],
      [Markup.button.callback('📦 Orders','sa_orders'), Markup.button.callback('💳 Payments','sa_payments')],
      [Markup.button.callback('📊 Analytics','sa_analytics'), Markup.button.callback('🩺 System Health','sa_health')],
      [Markup.button.callback('📢 Announcements','sa_announce'), Markup.button.callback('🚨 Emergency','sa_emergency')]
    ]));
  }

  function showRestaurantMainMenu(ctx, restaurant){
    return ctx.reply(`🏪 RESTAURANT CONTROL\n${restaurant.name}\nStatus: ${restaurant.status} | ${restaurant.isOpen?'🟢 Open':'🔴 Closed'}`, Markup.inlineKeyboard([
      [Markup.button.callback('📦 Orders','r_orders'), Markup.button.callback('🍔 Menu','r_menu')],
      [Markup.button.callback('💰 Prices','r_prices'), Markup.button.callback('💳 Payments','r_payments')],
      [Markup.button.callback('🏪 Profile','r_profile'), Markup.button.callback('🕐 Hours','r_hours')],
      [Markup.button.callback(restaurant.isOpen?'🔴 Close Shop':'🟢 Open Shop','r_toggle_open'), Markup.button.callback(restaurant.isBusy?'🟢 Not Busy':'🟡 Busy Mode','r_toggle_busy')],
      [Markup.button.callback('👥 Staff','r_staff'), Markup.button.callback('📊 Sales','r_sales')],
      [Markup.button.callback(restaurant.status==='LIVE' ? '🟢 LIVE (tap to re-check)' : '🟢 GO LIVE','r_golive')],
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
          for(const app of pending.slice(0,5)){
            await ctx.reply(`🏪 NEW REGISTRATION [${app.code}]\n${app.restaurantName}\nOwner: ${app.ownerName}\nPhone: ${app.phone}\nEmail: ${app.email}\nCuisine: ${app.cuisine}\nHours: ${app.openingHours}`, Markup.inlineKeyboard([
              [Markup.button.callback('✅ APPROVE','approve_'+app.id), Markup.button.callback('❌ REJECT','reject_'+app.id)],
              [Markup.button.callback('👀 VIEW DETAILS','view_'+app.id)]
            ]));
          }
          // Restaurants that finished their own setup (/golive) but are still
          // hidden from customers until you explicitly allow them below.
          const awaitingVisibility = db.restaurants.filter(r=>r.status==='LIVE' && !r.isVisible);
          if(awaitingVisibility.length){
            await ctx.reply(`👁 ${awaitingVisibility.length} restaurant(s) are LIVE but HIDDEN from the website. Tap to allow them:`, Markup.inlineKeyboard(
              awaitingVisibility.slice(0,15).map(r=>[Markup.button.callback(`✅ SHOW [${r.code}] ${r.name}`, 'sa_show_'+r.id)])
            ));
          }
          const visibleNow = db.restaurants.filter(r=>r.status==='LIVE' && r.isVisible);
          if(visibleNow.length){
            await ctx.reply(`🌐 ${visibleNow.length} restaurant(s) currently visible on the website. Tap to hide:`, Markup.inlineKeyboard(
              visibleNow.slice(0,15).map(r=>[Markup.button.callback(`🚫 HIDE [${r.code}] ${r.name}`, 'sa_hide_'+r.id)])
            ));
          }
          if(pending.length===0 && awaitingVisibility.length===0 && visibleNow.length===0){
            return ctx.reply('No pending applications and no restaurants yet. Slots used: '+db.restaurants.filter(r=>r.status!=='DRAFT').length+'/'+TOTAL_RESTAURANT_SLOTS);
          }
          return;
        }
        if(data==='sa_health'){
          return ctx.reply(`🩺 SYSTEM HEALTH\nFrontend: 🟢\nBackend: 🟢\nDatabase: 🟢 ${db.restaurants.length} restaurants\nTelegram: 🟢\nOrdering: ${db.systemPaused ? '⏸ PAUSED' : '🟢 ACTIVE'}\nOrders today: ${db.orders.filter(o=>o.createdAt.startsWith(todayStr())).length}`);
        }
        if(data==='sa_orders'){
          const recent = db.orders.slice(-5).reverse();
          if(recent.length===0) return ctx.reply('📦 No orders yet');
          return ctx.reply('📦 Recent Orders:\n'+recent.map(o=>`${o.code} - ₹${o.total} - ${o.status}`).join('\n'));
        }
        if(data==='sa_payments'){
          const totalRevenue = db.orders.filter(o=>o.status==='COMPLETED').reduce((s,o)=>s+o.total,0);
          const pendingVerification = db.orders.filter(o=>o.paymentStatus==='RECEIPT_SUBMITTED').length;
          const liveRestaurants = db.restaurants.filter(r=>r.status==='LIVE');
          const missingUpi = liveRestaurants.filter(r=>!r.upiId);
          return ctx.reply(`💳 PAYMENTS OVERVIEW\n\nTotal revenue (completed orders): ₹${totalRevenue}\nReceipts awaiting verification: ${pendingVerification}\nLive restaurants missing a UPI ID: ${missingUpi.length}${missingUpi.length ? '\n' + missingUpi.slice(0,10).map(r=>'• '+r.name).join('\n') : ''}`);
        }
        if(data==='sa_analytics'){
          const today = todayStr();
          const ordersToday = db.orders.filter(o=>o.createdAt.startsWith(today));
          const revenueToday = ordersToday.reduce((s,o)=>s+o.total,0);
          const weekAgoIso = new Date(Date.now()-7*24*60*60*1000).toISOString();
          const ordersWeek = db.orders.filter(o=>o.createdAt >= weekAgoIso);
          const counts = {};
          ordersWeek.forEach(o=>{ counts[o.restaurantId] = (counts[o.restaurantId]||0)+1; });
          const top = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,3)
            .map(([rid,c])=>{ const r = db.restaurants.find(x=>x.id===rid); return `${r ? r.name : 'Unknown'} — ${c} orders`; });
          const avgOrder = ordersWeek.length ? Math.round(ordersWeek.reduce((s,o)=>s+o.total,0)/ordersWeek.length) : 0;
          return ctx.reply(`📊 ANALYTICS\n\nToday: ${ordersToday.length} orders, ₹${revenueToday}\nLast 7 days: ${ordersWeek.length} orders, avg ₹${avgOrder}/order\n\nTop restaurants (7d):\n${top.join('\n') || 'No orders yet'}`);
        }
        if(data==='sa_announce'){
          pendingBroadcastAdmins.add(tgUserId);
          return ctx.reply('📢 Send the announcement text now and I\'ll deliver it to every live restaurant\'s Telegram.\n\nSend /cancel to abort instead.');
        }
        if(data==='sa_emergency'){
          return ctx.reply(`🚨 EMERGENCY CONTROLS\nOrdering is currently: ${db.systemPaused ? '⏸ PAUSED' : '🟢 ACTIVE'}`, Markup.inlineKeyboard([
            [Markup.button.callback(db.systemPaused ? '▶️ RESUME ORDERING' : '⏸ PAUSE ALL ORDERING','sa_toggle_pause')],
            [Markup.button.callback('🚫 Suspend / unsuspend a restaurant','sa_suspend_list')],
            [Markup.button.callback('◀️ Back','sa_back')]
          ]));
        }
        if(data==='sa_toggle_pause'){
          db.systemPaused = !db.systemPaused;
          saveDB();
          logAudit('superadmin:'+tgUserId, db.systemPaused ? 'PAUSE_ORDERING' : 'RESUME_ORDERING', 'platform');
          return ctx.editMessageText(`Ordering is now ${db.systemPaused ? '⏸ PAUSED — customers cannot place new orders' : '🟢 ACTIVE again'}`);
        }
        if(data==='sa_suspend_list'){
          const candidates = db.restaurants.filter(r=>r.status==='LIVE' || r.status==='SUSPENDED').slice(0,10);
          if(candidates.length===0) return ctx.reply('No live restaurants to suspend.');
          return ctx.reply('Tap a restaurant to suspend or unsuspend it:', Markup.inlineKeyboard(
            candidates.map(r=>[Markup.button.callback(`${r.status==='SUSPENDED' ? '🚫 (suspended) ' : '🟢 '}${r.name}`, 'sa_suspend_'+r.id)])
          ));
        }
        if(data.startsWith('sa_suspend_')){
          const rid = data.replace('sa_suspend_','');
          const r = db.restaurants.find(x=>x.id===rid);
          if(!r) return ctx.answerCbQuery('Not found');
          if(r.status==='SUSPENDED'){ r.status='LIVE'; }
          else if(r.status==='LIVE'){ r.status='SUSPENDED'; }
          else { return ctx.answerCbQuery('Restaurant is not live'); }
          saveDB();
          logAudit('superadmin:'+tgUserId, r.status==='SUSPENDED' ? 'SUSPEND_RESTAURANT' : 'UNSUSPEND_RESTAURANT', r.id);
          persistContentChange((r.status==='SUSPENDED' ? 'suspend:' : 'unsuspend:')+r.name).catch(e=>console.error('backup send failed', e.message));
          return ctx.editMessageText(`${r.name} is now ${r.status==='SUSPENDED' ? '🚫 SUSPENDED (hidden from customers, no new orders)' : '🟢 LIVE again'}`);
        }
        if(data.startsWith('sa_show_') || data.startsWith('sa_hide_')){
          const makeVisible = data.startsWith('sa_show_');
          const rid = data.replace(makeVisible ? 'sa_show_' : 'sa_hide_','');
          const r = db.restaurants.find(x=>x.id===rid);
          if(!r) return ctx.answerCbQuery('Not found');
          if(r.status!=='LIVE') return ctx.answerCbQuery('Restaurant is not LIVE yet');
          r.isVisible = makeVisible;
          saveDB();
          logAudit('superadmin:'+tgUserId, makeVisible?'SHOW_RESTAURANT':'HIDE_RESTAURANT', r.id);
          persistContentChange((makeVisible?'show:':'hide:')+r.code).catch(e=>console.error('backup send failed', e.message));
          return ctx.editMessageText(`[${r.code}] ${r.name} is now ${makeVisible ? '🌐 VISIBLE on the website' : '🚫 HIDDEN from the website'}`);
        }
        if(data==='sa_back'){
          return showSuperAdminMenu(ctx);
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

      if(data.startsWith('pc_approve_') || data.startsWith('pc_reject_')){
        if(!isSuperAdmin(tgUserId)) return ctx.answerCbQuery('Unauthorized');
        const approve = data.startsWith('pc_approve_');
        const changeId = data.replace(approve?'pc_approve_':'pc_reject_','');
        const change = db.pendingChanges.find(c=>c.id===changeId);
        if(!change) return ctx.answerCbQuery('Not found (already handled?)');
        if(change.status!=='PENDING') return ctx.answerCbQuery('Already '+change.status, {show_alert:true});
        const restaurant = db.restaurants.find(r=>r.id===change.restaurantId);
        if(approve){
          const result = applyPendingChange(change);
          change.status = result.ok ? 'APPROVED' : 'FAILED';
          saveDB();
          logAudit('superadmin:'+tgUserId, 'APPROVE_CHANGE', change.id);
          await ctx.editMessageText(ctx.callbackQuery.message.text + (result.ok ? '\n\n✅ APPROVED & LIVE' : `\n\n⚠️ FAILED: ${result.error}`));
          if(result.ok){
            persistContentChange('approve_change:'+change.code).catch(e=>console.error('backup send failed', e.message));
            const acc = restaurant && db.telegramAccounts.find(a=>a.restaurantId===restaurant.id && a.role==='OWNER');
            if(acc) bot.telegram.sendMessage(acc.telegramUserId, `✅ Your change was approved and is now live:\n${change.summary}`).catch(()=>{});
          }
        } else {
          change.status = 'REJECTED';
          saveDB();
          logAudit('superadmin:'+tgUserId, 'REJECT_CHANGE', change.id);
          await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n❌ REJECTED');
          const acc = restaurant && db.telegramAccounts.find(a=>a.restaurantId===restaurant.id && a.role==='OWNER');
          if(acc) bot.telegram.sendMessage(acc.telegramUserId, `❌ Your submitted change was rejected by admin:\n${change.summary}`).catch(()=>{});
        }
        return;
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
        return ctx.reply(`🍔 MENU - ${items.length} items in ${cats.length} categories\nUse commands:\n/additem Name | Price | Category\n/myitems - list with numbers\n/setprice <number> <new price>\n/itemimage <number> (then send a photo)\n/mycats - list categories\n/renamecat <number> <new name> - goes live instantly\n/reordercat <numbers in new order> - goes live instantly\n\nItems/prices/images go to admin for approval first. Category renames/reorders go live immediately (admin is notified and can override).`, Markup.inlineKeyboard([
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
        persistContentChange('update:toggle_open:'+restaurant.name).catch(e=>console.error('backup send failed', e.message));
        return ctx.editMessageText(`Shop is now ${restaurant.isOpen?'🟢 OPEN':'🔴 CLOSED'}`);
      }
      if(data==='r_toggle_busy'){
        restaurant.isBusy = !restaurant.isBusy;
        saveDB();
        persistContentChange('update:toggle_busy:'+restaurant.name).catch(e=>console.error('backup send failed', e.message));
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
      if(data==='r_golive'){
        await ctx.answerCbQuery();
        return performGoLive(ctx, restaurant);
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
    if(!name || !Number.isFinite(price) || price<=0) return ctx.reply('❌ Invalid name or price. Example: /additem Chicken Burger | 250 | Burgers');
    submitForReview(restaurant, 'ADD_ITEM', {name, price, catName: catName||'General'}, `➕ NEW ITEM\n${name} - ₹${price}\nCategory: ${catName||'General'}`);
    ctx.reply(`📤 Submitted for admin approval:\n${name} - ₹${price}\nIt will appear on the website once approved.`);
  });

  // /setprice <itemId> <newPrice> - routed through admin review, same as
  // adding a new item. Editing a price never touches orders already placed
  // (those keep their own checkout-time price snapshot), so once approved
  // it only affects new orders from that point forward.
  bot.command('setprice', async (ctx)=>{
    const text = ctx.message.text.replace('/setprice','').trim();
    const parts = text.split(/\s+/);
    const restaurant = findRestaurantByTelegramUser(ctx.from.id);
    if(!restaurant) return ctx.reply('Not linked');
    if(parts.length<2) return ctx.reply('Usage: /setprice <item number> <new price>\nSend /myitems first to see item numbers.');
    const idx = Number(parts[0]) - 1;
    const newPrice = Number(parts[1]);
    const items = db.menuItems.filter(i=>i.restaurantId===restaurant.id);
    const item = items[idx];
    if(!item) return ctx.reply('❌ No item with that number. Send /myitems to see the list.');
    if(!Number.isFinite(newPrice) || newPrice<=0) return ctx.reply('❌ Invalid price.');
    submitForReview(restaurant, 'EDIT_PRICE', {itemId:item.id, newPrice}, `💰 PRICE CHANGE\n${item.name}\n₹${item.price} → ₹${newPrice}`);
    ctx.reply(`📤 Submitted for admin approval:\n${item.name}: ₹${item.price} → ₹${newPrice}\nCurrent price stays live until approved (existing orders are never affected either way).`);
  });

  bot.command('myitems', async (ctx)=>{
    const restaurant = findRestaurantByTelegramUser(ctx.from.id);
    if(!restaurant) return ctx.reply('Not linked');
    const items = db.menuItems.filter(i=>i.restaurantId===restaurant.id);
    if(items.length===0) return ctx.reply('No items yet. Add one with /additem Name | Price | Category');
    ctx.reply(items.map((i,idx)=>`${idx+1}. ${i.name} - ₹${i.price} ${i.isAvailable?'✅':'❌'}`).join('\n')+'\n\nUse /setprice <number> <new price> or /itemimage <number> (then send a photo) to change one.');
  });

  // /itemimage <item number>, then send a photo in the next message - the
  // photo handler below picks this up. Also routed through admin review.
  const pendingItemImage = new Map(); // telegramUserId -> {restaurantId, itemId}
  bot.command('itemimage', async (ctx)=>{
    const restaurant = findRestaurantByTelegramUser(ctx.from.id);
    if(!restaurant) return ctx.reply('Not linked');
    const idx = Number(ctx.message.text.replace('/itemimage','').trim()) - 1;
    const items = db.menuItems.filter(i=>i.restaurantId===restaurant.id);
    const item = items[idx];
    if(!item) return ctx.reply('❌ No item with that number. Send /myitems to see the list.');
    pendingItemImage.set(ctx.from.id, {restaurantId:restaurant.id, itemId:item.id, itemName:item.name});
    ctx.reply(`📷 Now send a photo for "${item.name}". It'll be sent to admin for approval before it goes live.`);
  });

  // ---- CATEGORY MANAGEMENT ----
  // Unlike items/prices/images (which need admin approval before going
  // live), a restaurant renaming or reordering its OWN categories applies
  // immediately - the customer sees it right away. The admin is still
  // notified every time (informational, not an approval gate) and can
  // override any category's name or order at any point with /setcatname or
  // /setcatorder below - an admin override always wins and stays exactly as
  // the admin set it until the admin changes it again.
  bot.command('mycats', async (ctx)=>{
    const restaurant = findRestaurantByTelegramUser(ctx.from.id);
    if(!restaurant) return ctx.reply('Not linked');
    const cats = db.categories.filter(c=>c.restaurantId===restaurant.id).sort((a,b)=>a.sortOrder-b.sortOrder);
    if(cats.length===0) return ctx.reply('No categories yet - one is created automatically the first time you /additem.');
    ctx.reply(cats.map((c,idx)=>`${idx+1}. ${c.emoji||''} ${c.name}`.trim()).join('\n')+
      '\n\nUse /renamecat <number> <new name> or /reordercat <numbers in new order, e.g. 3,1,2>\nBoth go live immediately.');
  });

  bot.command('renamecat', async (ctx)=>{
    const restaurant = findRestaurantByTelegramUser(ctx.from.id);
    if(!restaurant) return ctx.reply('Not linked');
    const text = ctx.message.text.replace('/renamecat','').trim();
    const spaceIdx = text.indexOf(' ');
    if(spaceIdx<0) return ctx.reply('Usage: /renamecat <number> <new name>\nSend /mycats to see numbers.');
    const idx = Number(text.slice(0,spaceIdx)) - 1;
    const newName = text.slice(spaceIdx+1).trim();
    const cats = db.categories.filter(c=>c.restaurantId===restaurant.id).sort((a,b)=>a.sortOrder-b.sortOrder);
    const cat = cats[idx];
    if(!cat) return ctx.reply('❌ No category with that number. Send /mycats to see the list.');
    if(!newName) return ctx.reply('❌ New name cannot be empty.');
    const oldName = cat.name;
    cat.name = newName;
    saveDB();
    logAudit('restaurant:'+restaurant.id, 'RENAME_CATEGORY', cat.id, {name:oldName}, {name:newName});
    ctx.reply(`✅ Category renamed: "${oldName}" → "${newName}"\nLive on the website now.`);
    notifyAdminsCategoryChange(restaurant, `✏️ CATEGORY RENAMED\n[${restaurant.code}] ${restaurant.name}\n"${oldName}" → "${newName}"\nAlready live. Override anytime with /setcatname ${restaurant.code} ...`);
    persistContentChange('update:renamecat:'+restaurant.name).catch(e=>console.error('backup send failed', e.message));
  });

  bot.command('reordercat', async (ctx)=>{
    const restaurant = findRestaurantByTelegramUser(ctx.from.id);
    if(!restaurant) return ctx.reply('Not linked');
    const text = ctx.message.text.replace('/reordercat','').trim();
    const cats = db.categories.filter(c=>c.restaurantId===restaurant.id).sort((a,b)=>a.sortOrder-b.sortOrder);
    const order = text.split(',').map(s=>Number(s.trim())-1);
    if(order.length!==cats.length || order.some(i=>!Number.isInteger(i) || i<0 || i>=cats.length) || new Set(order).size!==order.length){
      return ctx.reply(`❌ Send all ${cats.length} numbers, each exactly once, comma-separated. Example: /reordercat ${cats.map((_,i)=>i+1).join(',')}\nSend /mycats to see current numbers.`);
    }
    order.forEach((origIdx, newPos)=>{ cats[origIdx].sortOrder = newPos; });
    saveDB();
    logAudit('restaurant:'+restaurant.id, 'REORDER_CATEGORIES', restaurant.id, null, order);
    const newOrderNames = order.map(i=>cats[i].name).join(' → ');
    ctx.reply(`✅ Category order updated: ${newOrderNames}\nLive on the website now.`);
    notifyAdminsCategoryChange(restaurant, `🔀 CATEGORIES REORDERED\n[${restaurant.code}] ${restaurant.name}\nNew order: ${newOrderNames}\nAlready live. Override anytime with /setcatorder ${restaurant.code} ...`);
    persistContentChange('update:reordercat:'+restaurant.name).catch(e=>console.error('backup send failed', e.message));
  });

  // Super Admin overrides - same effect as the restaurant commands above,
  // but by restaurant code and always wins/stays until changed again.
  bot.command('setcatname', async (ctx)=>{
    if(!isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized');
    const text = ctx.message.text.replace('/setcatname','').trim();
    const parts = text.split(' ');
    if(parts.length<3) return ctx.reply('Usage: /setcatname <code> <category number> <new name>\nExample: /setcatname 001 2 Cold Drinks');
    const code = parts[0].padStart(3,'0');
    const idx = Number(parts[1]) - 1;
    const newName = parts.slice(2).join(' ').trim();
    const restaurant = db.restaurants.find(r=>r.code===code);
    if(!restaurant) return ctx.reply(`No restaurant with code ${code}`);
    const cats = db.categories.filter(c=>c.restaurantId===restaurant.id).sort((a,b)=>a.sortOrder-b.sortOrder);
    const cat = cats[idx];
    if(!cat) return ctx.reply('❌ No category with that number for that restaurant.');
    const oldName = cat.name;
    cat.name = newName;
    saveDB();
    logAudit('superadmin:'+ctx.from.id, 'ADMIN_RENAME_CATEGORY', cat.id, {name:oldName}, {name:newName});
    persistContentChange('admin_renamecat:'+code).catch(e=>console.error('backup send failed', e.message));
    ctx.reply(`✅ [${code}] "${oldName}" → "${newName}" - locked in until you change it again.`);
  });
  bot.command('setcatorder', async (ctx)=>{
    if(!isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized');
    const text = ctx.message.text.replace('/setcatorder','').trim();
    const firstSpace = text.indexOf(' ');
    if(firstSpace<0) return ctx.reply('Usage: /setcatorder <code> <numbers in new order, e.g. 3,1,2>');
    const code = text.slice(0,firstSpace).trim().padStart(3,'0');
    const orderText = text.slice(firstSpace+1).trim();
    const restaurant = db.restaurants.find(r=>r.code===code);
    if(!restaurant) return ctx.reply(`No restaurant with code ${code}`);
    const cats = db.categories.filter(c=>c.restaurantId===restaurant.id).sort((a,b)=>a.sortOrder-b.sortOrder);
    const order = orderText.split(',').map(s=>Number(s.trim())-1);
    if(order.length!==cats.length || order.some(i=>!Number.isInteger(i) || i<0 || i>=cats.length) || new Set(order).size!==order.length){
      return ctx.reply(`❌ Send all ${cats.length} numbers, each exactly once. Current: `+cats.map((c,i)=>`${i+1}.${c.name}`).join(', '));
    }
    order.forEach((origIdx, newPos)=>{ cats[origIdx].sortOrder = newPos; });
    saveDB();
    logAudit('superadmin:'+ctx.from.id, 'ADMIN_REORDER_CATEGORIES', restaurant.id, null, order);
    persistContentChange('admin_reordercat:'+code).catch(e=>console.error('backup send failed', e.message));
    ctx.reply(`✅ [${code}] order updated: ${order.map(i=>cats[i].name).join(' → ')} - locked in until you change it again.`);
  });

  bot.command('setupi', async (ctx)=>{
    const upi = ctx.message.text.replace('/setupi','').trim();
    const restaurant = findRestaurantByTelegramUser(ctx.from.id);
    if(!restaurant) return;
    restaurant.upiId = upi;
    saveDB();
    ctx.reply(`✅ UPI Updated: ${upi}`);
    persistContentChange('update:setupi:'+restaurant.name).catch(e=>console.error('backup send failed', e.message));
  });

  bot.command('sethours', async (ctx)=>{
    const hours = ctx.message.text.replace('/sethours','').trim();
    const restaurant = findRestaurantByTelegramUser(ctx.from.id);
    if(!restaurant) return;
    restaurant.openingHours = hours;
    saveDB();
    ctx.reply(`✅ Hours updated: ${hours}`);
    persistContentChange('update:sethours:'+restaurant.name).catch(e=>console.error('backup send failed', e.message));
  });

  // Shared by both the /golive text command and the tappable "🟢 GO LIVE"
  // button, so typing or tapping does exactly the same thing.
  async function performGoLive(ctx, restaurant){
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

    // Send the admin an updated data.json the moment a restaurant actually
    // goes live — this is the point the data is worth having a fresh copy
    // of, since Render's free tier wipes the disk on restart.
    persistContentChange('go_live:'+restaurant.name).catch(e=>console.error('go-live backup send failed', e.message));
  }

  bot.command('golive', async (ctx)=>{
    const restaurant = findRestaurantByTelegramUser(ctx.from.id);
    if(!restaurant) return;
    await performGoLive(ctx, restaurant);
  });

  bot.command('setdelivery', async (ctx)=>{
    const fee = Number(ctx.message.text.replace('/setdelivery','').trim());
    const restaurant = findRestaurantByTelegramUser(ctx.from.id);
    if(!restaurant) return;
    restaurant.deliveryFee = fee;
    saveDB();
    ctx.reply(`Delivery fee set to ₹${fee}`);
    persistContentChange('update:setdelivery:'+restaurant.name).catch(e=>console.error('backup send failed', e.message));
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

  // /show 001  and  /hide 001 - the primary way you (Super Admin) control
  // which of the 200 numbered restaurants customers can actually see and
  // order from. This is independent of the restaurant's own /golive - a
  // restaurant can be fully set up and LIVE and still be invisible until
  // you run this. Visibility is persisted in data.json (and backed up to
  // your Telegram on every toggle) so it stays exactly as you set it.
  function setVisibilityByCode(ctx, code, makeVisible){
    if(!isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized');
    const r = db.restaurants.find(x=>x.code===code);
    if(!r) return ctx.reply(`No restaurant with code ${code}`);
    if(r.status!=='LIVE') return ctx.reply(`[${code}] ${r.name} is not LIVE yet (status: ${r.status}) - it must finish its own setup and /golive first.`);
    r.isVisible = makeVisible;
    saveDB();
    logAudit('superadmin:'+ctx.from.id, makeVisible?'SHOW_RESTAURANT':'HIDE_RESTAURANT', r.id);
    persistContentChange((makeVisible?'show:':'hide:')+code).catch(e=>console.error('backup send failed', e.message));
    ctx.reply(`[${code}] ${r.name} is now ${makeVisible ? '🌐 VISIBLE on the website' : '🚫 HIDDEN from the website'}`);
  }
  bot.command('pending', async (ctx)=>{
    if(!isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized');
    const pending = db.pendingChanges.filter(c=>c.status==='PENDING');
    if(pending.length===0) return ctx.reply('✅ No pending changes to review.');
    for(const change of pending.slice(0,15)){
      const restaurant = db.restaurants.find(r=>r.id===change.restaurantId);
      await ctx.reply(`📝 [${change.code}] ${restaurant ? restaurant.name : '?'}\n${change.summary}`, {reply_markup:{inline_keyboard:[
        [{text:'✅ APPROVE & PUBLISH', callback_data:'pc_approve_'+change.id}, {text:'❌ REJECT', callback_data:'pc_reject_'+change.id}]
      ]}});
    }
  });
  bot.command('show', (ctx)=>{
    const code = ctx.message.text.replace('/show','').trim().padStart(3,'0');
    setVisibilityByCode(ctx, code, true);
  });
  bot.command('hide', (ctx)=>{
    const code = ctx.message.text.replace('/hide','').trim().padStart(3,'0');
    setVisibilityByCode(ctx, code, false);
  });

  bot.command('cancel', async (ctx)=>{
    if(pendingBroadcastAdmins.has(ctx.from.id)){
      pendingBroadcastAdmins.delete(ctx.from.id);
      return ctx.reply('❌ Announcement cancelled.');
    }
    return ctx.reply('Nothing to cancel.');
  });

  // Any plain text from a super admin who just tapped "📢 Announcements" is
  // treated as the announcement body and broadcast to every live
  // restaurant's linked Telegram account(s). Registered after every
  // bot.command(...) above, so commands (which start with '/') are always
  // handled by their own handler first and never reach here.
  bot.on('text', async (ctx)=>{
    const tgUserId = ctx.from.id;
    if(!isSuperAdmin(tgUserId) || !pendingBroadcastAdmins.has(tgUserId)) return;
    pendingBroadcastAdmins.delete(tgUserId);
    const text = ctx.message.text;
    const liveRestaurants = db.restaurants.filter(r=>r.status==='LIVE');
    const accounts = db.telegramAccounts.filter(a=> liveRestaurants.some(r=>r.id===a.restaurantId));
    let sent = 0;
    for(const acc of accounts){
      try{
        await withRetries(()=> bot.telegram.sendMessage(acc.telegramUserId, `📢 ANNOUNCEMENT FROM FALLS\n\n${text}`));
        sent++;
      }catch(e){ console.error('announcement send failed', acc.telegramUserId, e.message); }
    }
    logAudit('superadmin:'+tgUserId, 'BROADCAST_ANNOUNCEMENT', 'platform', null, {text, sent});
    ctx.reply(`✅ Announcement sent to ${sent} of ${accounts.length} restaurant contact(s).`);
  });

  bot.on('photo', async (ctx)=>{
    const restaurant = findRestaurantByTelegramUser(ctx.from.id);
    if(!restaurant) return;
    try{
      const fileId = ctx.message.photo[ctx.message.photo.length-1].file_id;
      const fileLink = await ctx.telegram.getFileLink(fileId);

      const itemImageReq = pendingItemImage.get(ctx.from.id);
      if(itemImageReq && itemImageReq.restaurantId===restaurant.id){
        pendingItemImage.delete(ctx.from.id);
        submitForReview(restaurant, 'ITEM_IMAGE', {itemId:itemImageReq.itemId, imageUrl:fileLink.href}, `🖼 IMAGE CHANGE\n${itemImageReq.itemName}`);
        return ctx.reply(`📤 Image submitted for admin approval on "${itemImageReq.itemName}". It'll appear on the website once approved.`);
      }

      // No pending /itemimage request -> treat any photo as a payment QR
      // update. This one applies immediately (it's payment routing info the
      // restaurant needs live right away), not a content/menu change.
      restaurant.upiQrUrl = fileLink.href;
      saveDB();
      logAudit('restaurant:'+restaurant.id, 'UPDATE_QR', restaurant.id);
      ctx.reply('📷 QR RECEIVED\n✅ PAYMENT QR UPDATED\n\nTip: to change a menu item\'s photo instead, send /itemimage <item number> first, then the photo.', {reply_markup:{inline_keyboard:[[{text:'👀 PREVIEW', url: fileLink.href}]]}});
      persistContentChange('update:qr:'+restaurant.name).catch(e=>console.error('backup send failed', e.message));
    }catch(e){
      ctx.reply('Failed to process photo');
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
    bot.launch().then(()=>{
      console.log('Telegram bot polling started');
      warnAdminsIfDbLikelyWiped();
    }).catch(e=>console.error('Bot launch failed', e.message));
  } else {
    // In production (webhook mode) the bot is ready as soon as it's constructed.
    warnAdminsIfDbLikelyWiped();
  }
  // No startup/scheduled auto-backup on purpose — per request, data.json is
  // only pushed to admins on GO LIVE and on a restaurant data update (see
  // sendBackupToAdmins() call sites below), plus on-demand via /backup.
} else {
  console.log('TELEGRAM_BOT_TOKEN not set - bot disabled');
  // dummy webhook that just logs
  app.post('/telegram/webhook', (req,res)=> res.json({ok:true, disabled:true}));
}

// Fires once, right after boot, only when data.json was missing AND no
// persistent DATA_DIR is configured - i.e. Render's Free ephemeral disk
// almost certainly just wiped it and the 200 slots got reseeded blank.
// Tells the admin exactly what to do instead of letting it pass silently.
async function warnAdminsIfDbLikelyWiped(){
  await contentBootstrapPromise; // don't check dbLikelyWiped until GitHub restore had its chance to clear it
  if(!dbLikelyWiped || !bot || SUPER_ADMIN_IDS.length===0) return;
  const text = githubConfigured()
    ? `⚠️ SERVER RESTARTED WITH NO data.json FOUND, and GitHub restore also came back empty.\n\nEither this is genuinely the first-ever boot, or GITHUB_TOKEN/GITHUB_REPO is misconfigured - check the logs.\n\nIf you have a recent 💾 backup file in this chat, reply to it with /restore.`
    : `⚠️ SERVER RESTARTED WITH NO data.json FOUND\n\nThis usually means Render's free ephemeral disk was wiped and all 200 slots just got reseeded BLANK - any restaurants you'd filled in may be gone from this running server (their data still exists in your most recent backup here in this chat).\n\nTo restore: find my most recent 💾 data.json file in this chat and reply to it with /restore.\n\nTo stop this happening for good: set GITHUB_TOKEN + GITHUB_REPO in Render's env vars so restaurant/menu content is committed straight to your repo and restored automatically on every boot - see the GITHUB-BACKED CONTENT PERSISTENCE comment near the top of backend/server.js.`;
  for(const adminId of SUPER_ADMIN_IDS){
    bot.telegram.sendMessage(adminId, text).catch(e=>console.error('warnAdminsIfDbLikelyWiped failed', adminId, e.message));
  }
}

// ================= NOTIFICATIONS (single source of truth) =================
// These are the ONLY definitions of these functions. Every route that
// creates/updates an order or a registration calls these directly. When
// TELEGRAM_BOT_TOKEN isn't set, `bot` is null and each function just logs
// and returns - the sign-in/approval/order flow still "completes" from the
// website's point of view, it just won't reach a real Telegram chat.
// Informational only - the category change already went live before this
// fires. Just keeps the admin aware, since they retain override power via
// /setcatname and /setcatorder regardless.
async function notifyAdminsCategoryChange(restaurant, text){
  if(!bot || SUPER_ADMIN_IDS.length===0) return;
  for(const adminId of SUPER_ADMIN_IDS){
    try{ await bot.telegram.sendMessage(adminId, text); }
    catch(e){ console.error('notifyAdminsCategoryChange failed', adminId, e.message); }
  }
}

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

// Builds a full, human-readable order summary — customer info, delivery
// details, every item with qty/price, and totals — reused everywhere the
// restaurant needs to see the complete order (new order alert, receipt alert).
function formatOrderDetails(order){
  const itemLines = order.items.map(i=> `${i.isVeg?'🟢':'🔴'} ${i.name} × ${i.qty} — ₹${i.total}`).join('\n');
  return `Order: ${order.code}\n`+
    `👤 ${order.customerName} • 📞 ${order.phone}\n`+
    `${order.deliveryType==='delivery' ? '🛵 Delivery' : '🏪 Pickup'}${order.address ? '\n📍 '+order.address : ''}\n`+
    (order.notes ? `📝 ${order.notes}\n` : '')+
    `\n${itemLines}\n\n`+
    `Subtotal: ₹${order.subtotal}\n`+
    (order.deliveryFee ? `Delivery: ₹${order.deliveryFee}\n` : '')+
    `Total: ₹${order.total}\n`+
    `Payment: ${order.paymentMethod}`;
}

async function notifyRestaurantReceipt(order, localFilePath, mimetype){
  if(!bot){ console.log('Mock: would notify restaurant of receipt', order.code); return; }
  const accounts = db.telegramAccounts.filter(a=>a.restaurantId===order.restaurantId);
  const caption = `💳 PAYMENT RECEIPT RECEIVED\n\n${formatOrderDetails(order)}`;
  const isImage = mimetype && mimetype.startsWith('image/');
  for(const acc of accounts){
    try{
      const buttons = {reply_markup:{inline_keyboard:[
        [{text:'✅ VERIFY', callback_data:`verify_pay_${order.code}`}, {text:'❌ REJECT', callback_data:`reject_pay_${order.code}`}],
        [{text:'🔄 REQUEST NEW', callback_data:`request_receipt_${order.code}`}]
      ]}};
      if(isImage){
        // Sends the actual receipt photo inline in the chat, with the full
        // order (customer, items, totals) as the caption underneath it.
        await withRetries(()=> bot.telegram.sendPhoto(acc.telegramUserId, { source: localFilePath }, { caption, ...buttons }));
      } else {
        // Non-image receipts (e.g. a PDF) can't render as a photo, so send
        // as a document instead — still inline in the chat, not just a link.
        await withRetries(()=> bot.telegram.sendDocument(acc.telegramUserId, { source: localFilePath }, { caption, ...buttons }));
      }
    }catch(e){
      console.error('notifyRestaurantReceipt failed', e.message);
      // Fallback: if sending the actual file fails for any reason (too
      // large, Telegram hiccup), at least get the order details through
      // with a link, so the restaurant isn't left with nothing.
      try{
        await bot.telegram.sendMessage(acc.telegramUserId, `${caption}\n\n📄 ${BACKEND_URL}${order.receiptUrl}`, buttons);
      }catch(e2){ console.error('notifyRestaurantReceipt fallback failed', e2.message); }
    }
  }
}

// Sends the entire db to every super admin's Telegram chat as a file named
// exactly "data.json" — the same name the server itself reads/writes
// (DATA_FILE) — so it can be dragged straight into backend/data.json in
// GitHub with no renaming. Only fires on the two triggers the owner asked
// for: (1) a restaurant going LIVE, and (2) an already-registered restaurant
// changing any of its info/data (menu, hours, UPI, delivery fee, QR, staff
// PIN, open/busy toggle). Reply to the file with /restore to reload it.
// Small helper: retries a flaky network call a few times before giving up.
// "socket hang up" from Render -> Telegram on file uploads is usually a
// transient dropped connection, not a real error - a short retry clears it
// almost every time without needing any config change.
async function withRetries(fn, attempts=3, delayMs=1500){
  let lastErr;
  for(let i=1;i<=attempts;i++){
    try{ return await fn(); }
    catch(e){
      lastErr = e;
      const transient = /socket hang up|ETIMEDOUT|ECONNRESET|network|EAI_AGAIN/i.test(e.message||'');
      if(!transient || i===attempts) throw e;
      console.warn(`retrying after transient error (attempt ${i}/${attempts}): ${e.message}`);
      await new Promise(r=>setTimeout(r, delayMs*i));
    }
  }
  throw lastErr;
}

// Fires on every restaurant/menu/category/pending-change mutation, from
// both Telegram commands and the website admin dashboard. Does two things
// in parallel: (1) pushes a data.json snapshot to your Telegram (the
// existing safety net), and (2) commits the content fields straight to
// GitHub (see GITHUB-BACKED CONTENT PERSISTENCE above) so the change is
// "in the code" and survives a Render reset with no manual step at all,
// whenever GITHUB_TOKEN/GITHUB_REPO are configured. Both are fire-and-forget
// from call sites - a slow/failed backup never blocks the actual response
// to the restaurant, admin, or customer.
function persistContentChange(label){
  return Promise.allSettled([
    sendBackupToAdmins(label),
    syncContentToGitHub(label)
  ]);
}
async function sendBackupToAdmins(triggeredBy='auto'){
  if(!bot){ console.log('sendBackupToAdmins skipped: TELEGRAM_BOT_TOKEN not set'); return; }
  if(SUPER_ADMIN_IDS.length===0){ console.log('sendBackupToAdmins skipped: SUPER_ADMIN_TELEGRAM_IDS not set'); return; }
  let buffer;
  try{
    buffer = Buffer.from(JSON.stringify(db, null, 2), 'utf8');
  }catch(e){
    console.error('sendBackupToAdmins: could not serialize db', e.message);
    return;
  }
  const filename = `data.json`;
  for(const adminId of SUPER_ADMIN_IDS){
    try{
      await withRetries(()=> bot.telegram.sendDocument(adminId, { source: buffer, filename }, {
        caption: `💾 Updated data.json (${triggeredBy})\nRestaurants: ${db.restaurants.length} | Orders: ${db.orders.length} | Applications: ${db.applications.length}\n\nUpload this file directly over backend/data.json in GitHub to persist it. Reply to THIS file with /restore to reload it into a running server instead.`
      }));
    }catch(e){
      // The old version only logged this to Render's server logs, which is
      // why the file could silently never arrive with no visible reason.
      // Now the admin gets a plain-text explanation right in Telegram too,
      // after retries have already been exhausted.
      console.error('backup send failed after retries', adminId, e.message);
      try{
        await bot.telegram.sendMessage(adminId, `⚠️ Tried to send the updated data.json (${triggeredBy}) 3 times but it kept failing:\n${e.message}\n\nThis is usually a dropped connection between the server and Telegram - try /backup again in a minute. If it keeps happening, check that you've sent /start to this bot and that SUPER_ADMIN_TELEGRAM_IDS on Render matches your numeric Telegram ID.`);
      }catch(e2){
        console.error('failure notice also failed to send', adminId, e2.message);
      }
    }
  }
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

app.post('/api/admin/restaurants/:id/premium', requireAdminKey, (req,res)=>{
  const r = db.restaurants.find(x=>x.id===req.params.id);
  if(!r) return res.status(404).json({error:'Not found'});
  r.premium = !r.premium;
  saveDB();
  logAudit('superadmin', r.premium?'MAKE_PREMIUM':'REMOVE_PREMIUM', r.id);
  res.json(publicRestaurant(r));
});

app.post('/api/admin/restaurants/:id/suspend', requireAdminKey, (req,res)=>{
  const r = db.restaurants.find(x=>x.id===req.params.id);
  if(!r) return res.status(404).json({error:'Not found'});
  r.status = r.status==='SUSPENDED' ? 'LIVE' : 'SUSPENDED';
  saveDB();
  logAudit('superadmin', r.status==='SUSPENDED'?'SUSPEND':'UNSUSPEND', r.id);
  res.json(publicRestaurant(r));
});

app.patch('/api/admin/restaurants/:id', requireAdminKey, (req,res)=>{
  const r = db.restaurants.find(x=>x.id===req.params.id);
  if(!r) return res.status(404).json({error:'Not found'});
  // The website admin dashboard (image + basic-info edits) uses this route.
  // Everything else (visibility, suspend, pin, approvals) stays Telegram-only.
  const allowed = ['name','description','deliveryFee','minOrder','commissionRate','openingHours','cuisine','city'];
  const prev = {};
  const next = {};
  for(const key of allowed){
    if(req.body[key] !== undefined){
      prev[key] = r[key];
      r[key] = req.body[key];
      next[key] = req.body[key];
    }
  }
  saveDB();
  logAudit('superadmin:webdashboard', 'UPDATE_RESTAURANT', r.id, prev, next);
  // Persisted to disk above, but Render's free tier has no persistent disk -
  // this push to your Telegram is what actually survives a restart. Every
  // website edit now backs up exactly like a Telegram edit does, so nothing
  // you save here is ever quietly lost.
  persistContentChange('webdashboard:update_restaurant:'+r.code).catch(e=>console.error('backup send failed', e.message));
  res.json(publicRestaurant(r));
});

// ---- ADMIN: single restaurant + its menu, regardless of visibility ----
// (the public GET /api/restaurants/:id above deliberately 404s anything not
// LIVE+visible - the admin dashboard needs to see and edit hidden/draft
// slots too, so it uses this admin-key-gated route instead.)
app.get('/api/admin/restaurants/:id', requireAdminKey, (req,res)=>{
  const r = db.restaurants.find(x=>x.id===req.params.id);
  if(!r) return res.status(404).json({error:'Not found'});
  const categories = db.categories.filter(c=>c.restaurantId===r.id).sort((a,b)=>a.sortOrder-b.sortOrder);
  const items = db.menuItems.filter(i=>i.restaurantId===r.id);
  res.json({...publicRestaurant(r), categories, items});
});

// ---- ADMIN: image uploads (logo / cover / menu item) ----
// This is the ENTIRE purpose of the website admin dashboard per the owner's
// instructions: upload/replace images (plus the basic name/price/description
// edits above). Everything else stays Telegram-only.
app.post('/api/admin/restaurants/:id/logo', requireAdminKey, upload.single('image'), (req,res)=>{
  const r = db.restaurants.find(x=>x.id===req.params.id);
  if(!r) return res.status(404).json({error:'Not found'});
  if(!req.file) return res.status(400).json({error:'No file'});
  r.logoUrl = `/uploads/${req.file.filename}`;
  saveDB();
  logAudit('superadmin:webdashboard', 'UPDATE_LOGO', r.id);
  persistContentChange('webdashboard:update_logo:'+r.code).catch(e=>console.error('backup send failed', e.message));
  res.json({ok:true, logoUrl:r.logoUrl});
});
app.post('/api/admin/restaurants/:id/cover', requireAdminKey, upload.single('image'), (req,res)=>{
  const r = db.restaurants.find(x=>x.id===req.params.id);
  if(!r) return res.status(404).json({error:'Not found'});
  if(!req.file) return res.status(400).json({error:'No file'});
  r.coverUrl = `/uploads/${req.file.filename}`;
  saveDB();
  logAudit('superadmin:webdashboard', 'UPDATE_COVER', r.id);
  persistContentChange('webdashboard:update_cover:'+r.code).catch(e=>console.error('backup send failed', e.message));
  res.json({ok:true, coverUrl:r.coverUrl});
});

// ---- ADMIN: menu item edits (name/price/description) + image ----
app.patch('/api/admin/menu-items/:id', requireAdminKey, (req,res)=>{
  const item = db.menuItems.find(i=>i.id===req.params.id);
  if(!item) return res.status(404).json({error:'Not found'});
  const allowed = ['name','price','description','isAvailable','isVeg'];
  const prev = {}; const next = {};
  for(const key of allowed){
    if(req.body[key] !== undefined){
      prev[key] = item[key];
      // Price stays a plain number straight into item.price - the exact
      // same field every order snapshot reads from at checkout. No separate
      // "display price" vs "charge price" to ever drift apart.
      item[key] = key==='price' ? Number(req.body[key]) : req.body[key];
      next[key] = item[key];
    }
  }
  saveDB();
  logAudit('superadmin:webdashboard', 'UPDATE_MENU_ITEM', item.id, prev, next);
  const owner = db.restaurants.find(r=>r.id===item.restaurantId);
  persistContentChange('webdashboard:update_item:'+(owner?owner.code:item.restaurantId)).catch(e=>console.error('backup send failed', e.message));
  res.json(item);
});
app.post('/api/admin/menu-items/:id/image', requireAdminKey, upload.single('image'), (req,res)=>{
  const item = db.menuItems.find(i=>i.id===req.params.id);
  if(!item) return res.status(404).json({error:'Not found'});
  if(!req.file) return res.status(400).json({error:'No file'});
  item.imageUrl = `/uploads/${req.file.filename}`;
  saveDB();
  logAudit('superadmin:webdashboard', 'UPDATE_ITEM_IMAGE', item.id);
  const owner = db.restaurants.find(r=>r.id===item.restaurantId);
  persistContentChange('webdashboard:update_item_image:'+(owner?owner.code:item.restaurantId)).catch(e=>console.error('backup send failed', e.message));
  res.json({ok:true, imageUrl:item.imageUrl});
});

// ---- ADMIN: pending changes (mirrors the Telegram /pending approve/reject) ----
// GET returns each change's restaurantId/code/type/payload/summary exactly
// as the restaurant submitted it - the admin dashboard uses this to prefill
// an editable form, so you can fix a typo or adjust a price before it goes
// live, without bouncing back to the restaurant on Telegram.
app.get('/api/admin/pending-changes', requireAdminKey, (req,res)=>{
  res.json(db.pendingChanges.filter(c=>c.status==='PENDING'));
});
app.post('/api/admin/pending-changes/:id/approve', requireAdminKey, (req,res)=>{
  const change = db.pendingChanges.find(c=>c.id===req.params.id);
  if(!change) return res.status(404).json({error:'Not found'});
  if(change.status!=='PENDING') return res.status(409).json({error:'Already '+change.status});
  // Any field the admin edited on the website overrides what the restaurant
  // submitted; anything left untouched keeps the restaurant's original
  // value. Prices still go through the same item.price field every order
  // snapshots at checkout, so this can't desync display vs. charge.
  if(req.body && typeof req.body === 'object'){
    const overrides = {};
    if(req.body.name !== undefined) overrides.name = req.body.name;
    if(req.body.price !== undefined) overrides.price = Number(req.body.price);
    if(req.body.newPrice !== undefined) overrides.newPrice = Number(req.body.newPrice);
    if(req.body.catName !== undefined) overrides.catName = req.body.catName;
    if(req.body.imageUrl !== undefined) overrides.imageUrl = req.body.imageUrl;
    change.payload = Object.assign({}, change.payload, overrides);
  }
  const result = applyPendingChange(change);
  change.status = result.ok ? 'APPROVED' : 'FAILED';
  saveDB();
  logAudit('superadmin:webdashboard', 'APPROVE_CHANGE', change.id, null, change.payload);
  if(result.ok) persistContentChange('webdashboard:approve_change:'+change.code).catch(e=>console.error('backup send failed', e.message));
  const restaurant = db.restaurants.find(r=>r.id===change.restaurantId);
  if(result.ok && restaurant && bot){
    const acc = db.telegramAccounts.find(a=>a.restaurantId===restaurant.id && a.role==='OWNER');
    if(acc) bot.telegram.sendMessage(acc.telegramUserId, `✅ Your change was approved (via website) and is now live:\n${change.summary}`).catch(()=>{});
  }
  res.json(result);
});
app.post('/api/admin/pending-changes/:id/reject', requireAdminKey, (req,res)=>{
  const change = db.pendingChanges.find(c=>c.id===req.params.id);
  if(!change) return res.status(404).json({error:'Not found'});
  if(change.status!=='PENDING') return res.status(409).json({error:'Already '+change.status});
  change.status = 'REJECTED';
  saveDB();
  logAudit('superadmin:webdashboard', 'REJECT_CHANGE', change.id);
  res.json({ok:true});
});

// ---- ADMIN: APPLICATION APPROVAL (mirrors Telegram approve_/reject_ flow) ----
app.post('/api/admin/applications/:id/approve', requireAdminKey, (req,res)=>{
  const application = db.applications.find(a=>a.id===req.params.id);
  if(!application) return res.status(404).json({error:'Not found'});
  if(application.status !== 'PENDING') return res.status(409).json({error:'Application already '+application.status});
  application.status = 'APPROVED';
  const restaurant = db.restaurants.find(r=>r.id===application.id);
  if(restaurant) restaurant.status = 'APPROVED';
  const token = uuidv4().replace(/-/g,'').slice(0,16);
  db.telegramLinks.push({token, restaurantId: application.id, used:false, createdAt:new Date().toISOString()});
  saveDB();
  logAudit('superadmin:webdashboard', 'APPROVE_RESTAURANT', application.id);
  const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'YourBot';
  res.json({ ok:true, application, linkUrl: `https://t.me/${botUsername}?start=link_${token}` });
});

app.post('/api/admin/applications/:id/reject', requireAdminKey, (req,res)=>{
  const application = db.applications.find(a=>a.id===req.params.id);
  if(!application) return res.status(404).json({error:'Not found'});
  if(application.status !== 'PENDING') return res.status(409).json({error:'Application already '+application.status});
  application.status = 'REJECTED';
  const restaurant = db.restaurants.find(r=>r.id===application.id);
  if(restaurant) restaurant.status = 'REJECTED';
  saveDB();
  logAudit('superadmin:webdashboard', 'REJECT_RESTAURANT', application.id);
  res.json({ ok:true, application });
});

// ---- ADMIN: ANALYTICS ----
app.get('/api/admin/analytics', requireAdminKey, (req,res)=>{
  const totalOrders = db.orders.length;
  const totalRevenue = db.orders.reduce((s,o)=> s + (o.status==='COMPLETED' ? (o.total||0) : 0), 0);
  const activeRestaurants = db.restaurants.filter(r=>r.status==='LIVE').length;
  const pendingApplications = db.applications.filter(a=>a.status==='PENDING').length;
  const uniqueCustomers = new Set(db.orders.map(o=>o.phone)).size;
  const todayStr = new Date().toISOString().slice(0,10);
  const ordersToday = db.orders.filter(o=> (o.createdAt||'').slice(0,10)===todayStr).length;
  res.json({
    totalOrders, totalRevenue, activeRestaurants, pendingApplications,
    totalCustomers: uniqueCustomers, ordersToday,
    restaurantsTotal: db.restaurants.length
  });
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

contentBootstrapPromise
  .catch(e=>console.error('bootstrapContent failed, starting anyway with whatever local data.json had:', e.message))
  .then(()=>{
    app.listen(PORT, ()=>{
      console.log(`Backend running on ${PORT}`);
      console.log(`Health: http://localhost:${PORT}/health/ready`);
    });
  });

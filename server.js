
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
// telegramAccounts/telegramLinks are included so a restaurant owner's link
// to their Telegram account survives a Render reset too - without this,
// menu content restores fine after a restart but every owner gets kicked
// back to "Not linked" / "Invalid or expired link" and needs a brand new
// link from the Super Admin, even though nothing about their restaurant
// actually changed.
const GITHUB_CONTENT_FIELDS = ['restaurants','categories','menuItems','pendingChanges','telegramAccounts','telegramLinks','siteSettings'];
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
// Strips any leading Telegram-command-looking text (e.g. "/additem",
// "/additem /additem") that leaked into a saved item's name/description
// from an old bug in the /additem handler. Old corrupted items were
// committed to the GitHub content backup, so the bad text keeps coming
// back on every restart even after the input-parsing bug itself is fixed -
// this cleans existing data at load time instead of just preventing new
// occurrences. Returns true if anything was changed.
function sanitizeMenuItemText(){
  let changed = false;
  const stripLeadingCommands = (s)=>{
    if(typeof s !== 'string') return s;
    let out = s;
    while(/^\s*\/\S+\b/.test(out)) out = out.replace(/^\s*\/\S+\b/, '');
    return out.trim();
  };
  for(const item of db.menuItems||[]){
    if(typeof item.name === 'string' && /^\s*\//.test(item.name)){
      const cleanName = stripLeadingCommands(item.name);
      if(cleanName && cleanName !== item.name){
        // Descriptions were auto-generated from the (corrupted) name, so if
        // it still matches the old "<name> - delicious, freshly made."
        // template, regenerate it from the cleaned name too.
        if(item.description === `${item.name} - delicious, freshly made.`){
          item.description = `${cleanName} - delicious, freshly made.`;
        }
        item.name = cleanName;
        changed = true;
      }
    }
    if(typeof item.description === 'string' && /^\s*\//.test(item.description)){
      const cleanDesc = stripLeadingCommands(item.description);
      if(cleanDesc !== item.description){ item.description = cleanDesc; changed = true; }
    }
  }
  return changed;
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
    if(sanitizeMenuItemText()){
      console.log('🧹 Cleaned up leftover "/command" text found in menu item names/descriptions');
      saveDB();
      syncContentToGitHub('auto-cleanup: stray /command text in menu items').catch(()=>{});
    }
    return true;
  }catch(e){
    console.error('loadContentFromGitHub failed:', e.message);
    return false;
  }
}

// ================= GITHUB ADMIN (org / webhooks / projects) =================
// Optional layer on top of the content-sync token above. Reuses GITHUB_TOKEN,
// but that token now also needs (depending on which panels below you want
// live): admin:org (or read:org/write:org), admin:repo_hook (or
// read:repo_hook/write:repo_hook), and project (or read:project) scopes -
// generate those on the SAME classic PAT used for GITHUB_TOKEN. Everything
// here is reachable only from the Telegram Super Admin menu (🐙 GitHub) and
// checks isSuperAdmin() same as every other sa_ action.
const GITHUB_ORG = process.env.GITHUB_ORG || (GITHUB_REPO.includes('/') ? GITHUB_REPO.split('/')[0] : '');
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || WEBHOOK_SECRET || '';
function githubOrgConfigured(){ return !!(GITHUB_TOKEN && GITHUB_ORG); }
async function ghRequest(path, opts={}){
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...opts,
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(opts.headers||{})
    }
  });
  const text = await res.text();
  let json = null;
  try{ json = text ? JSON.parse(text) : null; }catch(e){ /* non-JSON response */ }
  if(!res.ok){
    const msg = (json && (json.message || JSON.stringify(json))) || text || `HTTP ${res.status}`;
    throw new Error(`GitHub API ${res.status}: ${msg}`);
  }
  return json;
}
// Projects (v2) live on GitHub's GraphQL endpoint, not REST - the classic
// REST Projects API this used to use was retired by GitHub.
async function ghGraphQL(query, variables={}){
  const res = await fetch(`${GITHUB_API}/graphql`, {
    method: 'POST',
    headers: { Authorization: `bearer ${GITHUB_TOKEN}`, 'Content-Type':'application/json' },
    body: JSON.stringify({query, variables})
  });
  const json = await res.json();
  if(json.errors) throw new Error(json.errors.map(e=>e.message).join('; '));
  return json.data;
}

async function ghOrgInfo(){
  return ghRequest(`/orgs/${GITHUB_ORG}`);
}
async function ghOrgMembers(){
  return ghRequest(`/orgs/${GITHUB_ORG}/members?per_page=30`);
}
async function ghSetMemberRole(username, role){ // role: 'member' | 'admin'
  return ghRequest(`/orgs/${GITHUB_ORG}/memberships/${encodeURIComponent(username)}`, {
    method: 'PUT',
    body: JSON.stringify({role})
  });
}
async function ghOrgRunners(){
  return ghRequest(`/orgs/${GITHUB_ORG}/actions/runners?per_page=30`);
}
async function ghRemoveRunner(runnerId){
  return ghRequest(`/orgs/${GITHUB_ORG}/actions/runners/${runnerId}`, {method:'DELETE'});
}
async function ghListWebhooks(){
  return ghRequest(`/repos/${GITHUB_REPO}/hooks`);
}
// Creates a repo webhook pointing at this backend's /github/webhook route,
// so pushes/deploys can be relayed straight into the Super Admin's Telegram.
async function ghCreateDeployWebhook(){
  return ghRequest(`/repos/${GITHUB_REPO}/hooks`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'web',
      active: true,
      events: ['push','deployment_status'],
      config: {
        url: `${BACKEND_URL}/github/webhook`,
        content_type: 'json',
        secret: GITHUB_WEBHOOK_SECRET || undefined,
        insecure_ssl: '0'
      }
    })
  });
}
async function ghDeleteWebhook(hookId){
  return ghRequest(`/repos/${GITHUB_REPO}/hooks/${hookId}`, {method:'DELETE'});
}
async function ghOrgProjects(){
  const data = await ghGraphQL(`
    query($org:String!){
      organization(login:$org){
        projectsV2(first: 10, orderBy:{field:UPDATED_AT, direction:DESC}){
          nodes{ id title number url closed
            items(first:1){ totalCount }
          }
        }
      }
    }`, {org: GITHUB_ORG});
  return data && data.organization ? data.organization.projectsV2.nodes : [];
}
// Verifies X-Hub-Signature-256 so only genuine GitHub deliveries are trusted.
function verifyGithubSignature(req){
  if(!GITHUB_WEBHOOK_SECRET) return true; // no secret configured - accept (matches how WEBHOOK_SECRET is handled elsewhere when unset)
  const sig = req.headers['x-hub-signature-256'];
  if(!sig) return false;
  const crypto = require('crypto');
  const expected = 'sha256=' + crypto.createHmac('sha256', GITHUB_WEBHOOK_SECRET).update(req.rawBody || JSON.stringify(req.body)).digest('hex');
  try{
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  }catch(e){ return false; }
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
  systemPaused: false, // platform-wide emergency pause, toggled from the Super Admin bot
  siteSettings: { logoUrl: null, backgroundUrl: null } // site-wide logo/background, set via Super Admin Telegram menu
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
// Restaurant-submitted menu changes (add item / price / item image) now go
// live INSTANTLY - no Super Admin approval step. This reuses the exact same
// apply logic as the old pendingChanges flow, just without the queue/wait.
// Auto-syncs to GitHub (if configured) and sends the admin a live-update
// notice with a manual "Force Sync Now" button as a safety net, in case the
// automatic sync ever fails silently.
function applyContentChangeAndNotify(restaurant, type, payload, summary){
  const result = applyPendingChange({restaurantId:restaurant.id, type, payload});
  if(!result.ok) return result;
  logAudit('restaurant:'+restaurant.id, 'DIRECT_CHANGE_'+type, restaurant.id, null, payload);
  persistContentChange('direct:'+type.toLowerCase()+':'+restaurant.code).catch(e=>console.error('backup send failed', e.message));
  if(bot && SUPER_ADMIN_IDS.length){
    const text = `✅ LIVE UPDATE\n[${restaurant.code}] ${restaurant.name}\n\n${summary}\n\nAlready live on the website - synced to GitHub automatically.`;
    for(const adminId of SUPER_ADMIN_IDS){
      bot.telegram.sendMessage(adminId, text, {reply_markup:{inline_keyboard:[[{text:'🔄 Force Sync Now', callback_data:'force_sync'}]]}}).catch(e=>console.error('notify failed', e.message));
    }
  }
  return result;
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

// ---- OWNER WEB SESSION ----
// Lets a restaurant owner manage their own restaurant from a browser
// (owner.html) instead of only via Telegram. Logs in with the same
// email+password set at registration; every action below is the exact
// same logic the matching Telegram command runs, just reachable over
// HTTP and scoped to req.ownerRestaurantId via the JWT below.
const OWNER_TOKEN_TTL_SEC = 12*60*60;
function issueOwnerToken(restaurantId){
  return jwt.sign({restaurantId, role:'owner'}, JWT_SECRET, {expiresIn: OWNER_TOKEN_TTL_SEC});
}
function requireOwnerAuth(req,res,next){
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if(!token) return res.status(401).json({error:'Missing owner session'});
  try{
    const payload = jwt.verify(token, JWT_SECRET);
    if(payload.role!=='owner') throw new Error('wrong role');
    const restaurant = db.restaurants.find(r=>r.id===payload.restaurantId);
    if(!restaurant) throw new Error('restaurant gone');
    req.ownerRestaurant = restaurant;
    next();
  }catch(e){
    return res.status(401).json({error:'Owner session invalid or expired - log in again'});
  }
}

// ================= EXPRESS APP =================
const app = express();
app.use(helmet({crossOriginResourcePolicy:false}));
app.use(cors({origin:true, credentials:true}));
app.use(morgan('tiny'));
// verify: captures the raw request body so the GitHub webhook handler can
// recompute the HMAC signature - express.json() would otherwise discard it
// after parsing, and signatures must be checked against the exact raw bytes.
app.use(express.json({limit:'10mb', verify:(req,res,buf)=>{ req.rawBody = buf; }}));
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

// Site-wide logo/background, settable by the Super Admin from the Telegram
// menu (see 'sa_site_logo' / 'sa_site_background' below). Falls back to the
// index.html SITE_IMAGES asset-file config on the frontend when either is
// unset, so setting only one of the two here doesn't break the other.
app.get('/api/site-settings', (req,res)=>{
  res.json(db.siteSettings || { logoUrl: null, backgroundUrl: null });
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

  // Generic "tap a button, then type the value" state for restaurant owners -
  // lets buttons like Add Item / Edit Price / Edit UPI / Edit Hours / Edit
  // Delivery Fee / Rename Category prompt for a single text reply instead of
  // requiring the owner to remember and type a slash command from scratch.
  // telegramUserId -> {type, restaurantId, ...extra fields for that type}
  const pendingTextInput = new Map();

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
      syncContentToGitHub('link_telegram:'+restaurant.code).catch(e=>console.error('backup send failed', e.message));
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
    return ctx.reply(`👑 SUPER ADMIN\nWelcome to Control Center\nOrdering: ${db.systemPaused ? '⏸ PAUSED' : '🟢 ACTIVE'}\nSlots used: ${db.restaurants.filter(r=>r.status!=='DRAFT').length}/${TOTAL_RESTAURANT_SLOTS}\n\n👁 VISIBILITY: restaurants now become visible automatically the moment they /golive - no manual step needed. You can still /hide 001 to pull one down, or /show 001 to bring it back.\n\n✏️ LIVE UPDATES: menu/price/image changes restaurants submit now go live instantly - you just get a notified with a 🔄 Force Sync Now button as a backup trigger. /pending still exists for any old queued changes.\n\n⭐ DASHBOARD POWERS (now here too, apply instantly, no approval needed since you ARE the admin):\n/pin <code> - toggle pinned\n/highlight <code> - toggle highlighted\n/premium <code> - toggle premium\n/editinfo <code> | field=value | ... - edit name/description/deliveryFee/minOrder/commissionRate/openingHours/cuisine/city\n/logo <code> then send photo - set restaurant logo\n/cover <code> then send photo - set restaurant cover\n/items <code> - list a restaurant's items with numbers\n/edititem <code> <number> | field=value | ... - edit name/price/description/isAvailable/isVeg\n/adminitemimage <code> <number> then send photo - set item image\n/relink <code> - generate a fresh Telegram link for an already-approved restaurant (fixes a broken/lost link without re-registering)\n\n💾 data.json is sent here automatically whenever a restaurant goes live or updates its info. Send /backup anytime for an on-demand copy. If data ever resets, reply /restore to the latest file.`, Markup.inlineKeyboard([
      [Markup.button.callback('🏪 Restaurants','sa_restaurants')],
      [Markup.button.callback('📦 Orders','sa_orders'), Markup.button.callback('💳 Payments','sa_payments')],
      [Markup.button.callback('📊 Analytics','sa_analytics'), Markup.button.callback('🩺 System Health','sa_health')],
      [Markup.button.callback('📢 Announcements','sa_announce'), Markup.button.callback('🚨 Emergency','sa_emergency')],
      [Markup.button.callback('🖼 Site Logo','sa_site_logo'), Markup.button.callback('🌄 Site Background','sa_site_background')],
      [Markup.button.callback('🐙 GitHub','sa_github')]
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
      if(data==='force_sync'){
        if(!isSuperAdmin(tgUserId)) return ctx.answerCbQuery('Unauthorized');
        await ctx.answerCbQuery('Syncing...');
        await persistContentChange('manual_force_sync:'+tgUserId);
        return ctx.reply('💾 Synced current restaurants/menu/links to GitHub + sent you a fresh backup file.');
      }
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
        if(data==='sa_site_logo'){
          pendingAdminImage.set(tgUserId, {type:'site_logo'});
          return ctx.reply(`🖼 Now send the photo to use as the site-wide logo (shown in the header and startup screen). Current: ${db.siteSettings && db.siteSettings.logoUrl ? 'set' : 'default 🌊 icon'}`);
        }
        if(data==='sa_site_background'){
          pendingAdminImage.set(tgUserId, {type:'site_background'});
          return ctx.reply(`🌄 Now send the photo to use as the site-wide background. Current: ${db.siteSettings && db.siteSettings.backgroundUrl ? 'set' : 'default waterfall image'}`);
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

        // ---- GitHub admin (org / webhooks / projects) ----
        if(data==='sa_github'){
          if(!githubOrgConfigured()){
            return ctx.reply('🐙 GitHub admin isn\'t configured yet. Set GITHUB_TOKEN (with admin:org, admin:repo_hook, project scopes) and GITHUB_ORG (or a GITHUB_REPO like "org/repo" to infer it from) in Render\'s env vars.');
          }
          return ctx.reply(`🐙 GITHUB ADMIN\nOrg: ${GITHUB_ORG}\nRepo: ${GITHUB_REPO || '(not set)'}`, Markup.inlineKeyboard([
            [Markup.button.callback('🏢 Org Info','sa_gh_org'), Markup.button.callback('👥 Members','sa_gh_members')],
            [Markup.button.callback('🖥️ Runners','sa_gh_runners'), Markup.button.callback('🔗 Webhooks','sa_gh_hooks')],
            [Markup.button.callback('📋 Projects','sa_gh_projects')],
            [Markup.button.callback('◀️ Back','sa_back')]
          ]));
        }
        if(data==='sa_gh_org'){
          try{
            const org = await ghOrgInfo();
            return ctx.reply(`🏢 ${org.login}\n${org.name || ''}\nPlan: ${org.plan ? org.plan.name : 'n/a'}\nPublic repos: ${org.public_repos}\nMembers (public count): ${org.public_members ?? 'n/a'}\n${org.html_url}`);
          }catch(e){ return ctx.reply('❌ '+e.message); }
        }
        if(data==='sa_gh_members'){
          try{
            const members = await ghOrgMembers();
            if(!members.length) return ctx.reply('No org members found (or token lacks read:org).');
            return ctx.reply(`👥 ORG MEMBERS (${members.length})\n${members.slice(0,25).map(m=>'• '+m.login).join('\n')}\n\nChange a role: /orgmember <username> <member|admin>`);
          }catch(e){ return ctx.reply('❌ '+e.message); }
        }
        if(data==='sa_gh_runners'){
          try{
            const data2 = await ghOrgRunners();
            const runners = data2.runners || [];
            if(!runners.length) return ctx.reply('🖥️ No self-hosted Actions runners registered for this org.');
            return ctx.reply(`🖥️ RUNNERS (${runners.length})\n${runners.map(r=>`• ${r.name} — ${r.status}${r.busy ? ' (busy)' : ''}`).join('\n')}`, Markup.inlineKeyboard(
              runners.filter(r=>r.status==='offline').slice(0,10).map(r=>[Markup.button.callback(`🗑️ Remove offline: ${r.name}`, 'sa_gh_rm_runner_'+r.id)])
            ));
          }catch(e){ return ctx.reply('❌ '+e.message); }
        }
        if(data.startsWith('sa_gh_rm_runner_')){
          const runnerId = data.replace('sa_gh_rm_runner_','');
          try{
            await ghRemoveRunner(runnerId);
            logAudit('superadmin:'+tgUserId, 'GITHUB_REMOVE_RUNNER', runnerId);
            return ctx.reply('✅ Runner removed.');
          }catch(e){ return ctx.reply('❌ '+e.message); }
        }
        if(data==='sa_gh_hooks'){
          if(!GITHUB_REPO) return ctx.reply('Set GITHUB_REPO ("owner/repo") to manage webhooks.');
          try{
            const hooks = await ghListWebhooks();
            const lines = hooks.length ? hooks.map(h=>`• #${h.id} ${h.config && h.config.url} (${(h.events||[]).join(',')}) ${h.active?'🟢':'🔴'}`).join('\n') : 'No webhooks yet.';
            const buttons = hooks.filter(h=>h.config && h.config.url === `${BACKEND_URL}/github/webhook`).map(h=>[Markup.button.callback(`🗑️ Delete #${h.id}`, 'sa_gh_hook_del_'+h.id)]);
            if(!hooks.some(h=>h.config && h.config.url === `${BACKEND_URL}/github/webhook`)){
              buttons.push([Markup.button.callback('➕ Create deploy-notify webhook','sa_gh_hook_create')]);
            }
            buttons.push([Markup.button.callback('◀️ Back','sa_github')]);
            return ctx.reply(`🔗 WEBHOOKS — ${GITHUB_REPO}\n${lines}`, Markup.inlineKeyboard(buttons));
          }catch(e){ return ctx.reply('❌ '+e.message); }
        }
        if(data==='sa_gh_hook_create'){
          try{
            const hook = await ghCreateDeployWebhook();
            logAudit('superadmin:'+tgUserId, 'GITHUB_CREATE_WEBHOOK', String(hook.id));
            return ctx.reply(`✅ Webhook created (#${hook.id}) -> ${BACKEND_URL}/github/webhook\nPush + deployment_status events will now be relayed here.${GITHUB_WEBHOOK_SECRET ? '' : '\n⚠️ No GITHUB_WEBHOOK_SECRET set - anyone who finds the URL could send fake events. Set one in Render env vars and recreate the hook.'}`);
          }catch(e){ return ctx.reply('❌ '+e.message); }
        }
        if(data.startsWith('sa_gh_hook_del_')){
          const hookId = data.replace('sa_gh_hook_del_','');
          try{
            await ghDeleteWebhook(hookId);
            logAudit('superadmin:'+tgUserId, 'GITHUB_DELETE_WEBHOOK', hookId);
            return ctx.reply(`✅ Webhook #${hookId} deleted.`);
          }catch(e){ return ctx.reply('❌ '+e.message); }
        }
        if(data==='sa_gh_projects'){
          try{
            const projects = await ghOrgProjects();
            if(!projects.length) return ctx.reply('📋 No GitHub Projects found for this org (or token lacks the project scope).');
            return ctx.reply(`📋 PROJECT BOARDS\n${projects.map(p=>`• #${p.number} ${p.title}${p.closed?' (closed)':''} — ${p.items.totalCount} items\n  ${p.url}`).join('\n')}`);
          }catch(e){ return ctx.reply('❌ '+e.message); }
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
        syncContentToGitHub('approve_restaurant:'+appId).catch(e=>console.error('backup send failed', e.message));
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
        return ctx.reply(`🍔 MENU - ${items.length} items in ${cats.length} categories\n\nGoes live on the website instantly - no approval wait.`, Markup.inlineKeyboard([
          [Markup.button.callback('➕ ADD ITEM','r_add_item')],
          [Markup.button.callback('👀 VIEW MENU','r_view_menu'), Markup.button.callback('📂 CATEGORIES','r_categories')]
        ]));
      }
      if(data==='r_add_item'){
        pendingTextInput.set(tgUserId, {type:'additem', restaurantId:restaurant.id});
        return ctx.reply('➕ ADD ITEM\nSend it as one message like this:\nName | Price | Category (category is optional)\n\nExample:\nChicken Burger | 250 | Burgers');
      }
      if(data==='r_view_menu'){
        const items = db.menuItems.filter(i=>i.restaurantId===restaurant.id).slice(0,10);
        return ctx.reply(items.map(i=>`${i.name} - ₹${i.price} ${i.isAvailable?'✅':'❌'}`).join('\n') || 'No items');
      }
      if(data==='r_categories'){
        const cats = db.categories.filter(c=>c.restaurantId===restaurant.id).sort((a,b)=>a.sortOrder-b.sortOrder);
        if(cats.length===0) return ctx.reply('No categories yet - one is created automatically the first time you add an item.');
        const rows = cats.map((c,idx)=>[
          Markup.button.callback(idx===0?'·':'⬆️','r_cat_up_'+c.id),
          Markup.button.callback(`${c.emoji||'🍔'} ${c.name}`,'r_cat_noop'),
          Markup.button.callback(idx===cats.length-1?'·':'⬇️','r_cat_down_'+c.id),
          Markup.button.callback('✏️','r_cat_rename_'+c.id)
        ]);
        return ctx.reply('📂 CATEGORIES\n⬆️⬇️ reorder · ✏️ rename - both go live instantly.', Markup.inlineKeyboard(rows));
      }
      if(data==='r_cat_noop'){
        return ctx.answerCbQuery();
      }
      if(data.startsWith('r_cat_up_') || data.startsWith('r_cat_down_')){
        const goingUp = data.startsWith('r_cat_up_');
        const catId = data.replace(goingUp?'r_cat_up_':'r_cat_down_','');
        const cats = db.categories.filter(c=>c.restaurantId===restaurant.id).sort((a,b)=>a.sortOrder-b.sortOrder);
        const idx = cats.findIndex(c=>c.id===catId);
        const swapIdx = goingUp ? idx-1 : idx+1;
        if(idx<0 || swapIdx<0 || swapIdx>=cats.length) return ctx.answerCbQuery();
        const a = cats[idx], b = cats[swapIdx];
        const tmp = a.sortOrder; a.sortOrder = b.sortOrder; b.sortOrder = tmp;
        saveDB();
        persistContentChange('update:reordercat:'+restaurant.name).catch(e=>console.error('backup send failed', e.message));
        await ctx.answerCbQuery('Moved');
        const newCats = db.categories.filter(c=>c.restaurantId===restaurant.id).sort((x,y)=>x.sortOrder-y.sortOrder);
        const rows = newCats.map((c,i)=>[
          Markup.button.callback(i===0?'·':'⬆️','r_cat_up_'+c.id),
          Markup.button.callback(`${c.emoji||'🍔'} ${c.name}`,'r_cat_noop'),
          Markup.button.callback(i===newCats.length-1?'·':'⬇️','r_cat_down_'+c.id),
          Markup.button.callback('✏️','r_cat_rename_'+c.id)
        ]);
        return ctx.editMessageReplyMarkup({inline_keyboard: rows}).catch(()=>{});
      }
      if(data.startsWith('r_cat_rename_')){
        const catId = data.replace('r_cat_rename_','');
        const cat = db.categories.find(c=>c.id===catId && c.restaurantId===restaurant.id);
        if(!cat) return ctx.answerCbQuery('Category not found');
        pendingTextInput.set(tgUserId, {type:'renamecat', restaurantId:restaurant.id, catId:cat.id});
        await ctx.answerCbQuery();
        return ctx.reply(`✏️ Send the new name for "${cat.name}"`);
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
        return ctx.reply(`💳 PAYMENT\nUPI ID: ${restaurant.upiId||'Not set'}\nQR: ${restaurant.upiQrUrl?'Set':'Not set'}\nDelivery fee: ₹${restaurant.deliveryFee||0}`, Markup.inlineKeyboard([
          [Markup.button.callback('✏️ EDIT UPI','r_edit_upi'), Markup.button.callback('📷 UPLOAD QR','r_edit_qr')],
          [Markup.button.callback('🚚 EDIT DELIVERY FEE','r_edit_delivery')]
        ]));
      }
      if(data==='r_edit_upi'){
        pendingTextInput.set(tgUserId, {type:'setupi', restaurantId:restaurant.id});
        return ctx.reply('✏️ Send your UPI ID\nExample: yourname@upi');
      }
      if(data==='r_edit_qr'){
        return ctx.reply('📷 Just send the QR code photo now as your next message - it goes live immediately.');
      }
      if(data==='r_edit_delivery'){
        pendingTextInput.set(tgUserId, {type:'setdelivery', restaurantId:restaurant.id});
        return ctx.reply(`✏️ Send the delivery fee amount (in ₹, numbers only)\nCurrent: ₹${restaurant.deliveryFee||0}`);
      }
      if(data==='setup_start'){
        return ctx.reply('🏪 SETUP WIZARD\n1️⃣ Profile done\n2️⃣ Hours: tap 🕐 Hours\n3️⃣ Menu: tap 🍔 Menu → ➕ Add Item\n4️⃣ Payment: tap 💳 Payments\n5️⃣ Delivery fee: tap 💳 Payments → 🚚 Edit Delivery Fee\n6️⃣ Then tap 🟢 GO LIVE');
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
      if(data==='r_prices'){
        const items = db.menuItems.filter(i=>i.restaurantId===restaurant.id);
        if(items.length===0) return ctx.reply('No items yet. Tap 🍔 Menu → ➕ Add Item first.');
        const shown = items.slice(0,15);
        const rows = shown.map(i=>[Markup.button.callback(`✏️ ${i.name} - ₹${i.price}`,'r_editprice_'+i.id)]);
        return ctx.reply(`💰 PRICES - ${items.length} items\nTap an item to change its price.${items.length>15?'\n(Showing first 15)':''}`, Markup.inlineKeyboard(rows));
      }
      if(data.startsWith('r_editprice_')){
        const itemId = data.replace('r_editprice_','');
        const item = db.menuItems.find(i=>i.id===itemId && i.restaurantId===restaurant.id);
        if(!item) return ctx.answerCbQuery('Item not found');
        pendingTextInput.set(tgUserId, {type:'setprice', restaurantId:restaurant.id, itemId:item.id});
        await ctx.answerCbQuery();
        return ctx.reply(`✏️ Send the new price for "${item.name}" (current: ₹${item.price})`);
      }
      if(data==='r_profile'){
        return ctx.reply(`🏪 PROFILE\nName: ${restaurant.name}\nCategory: ${restaurant.cuisine||restaurant.category||'Not set'}\nCity: ${restaurant.city||'Not set'}\nDescription: ${restaurant.description||'Not set'}\nDelivery fee: ₹${restaurant.deliveryFee||0}\nMin order: ${restaurant.minOrder ? '₹'+restaurant.minOrder : 'Not set'}\nHours: ${restaurant.openingHours||'Not set'}\n\nYou can update yourself:\nHours and Delivery Fee from their own buttons.\n\nName, category, city, description, or logo/cover photo need an admin update - message the admin to change those.`);
      }
      if(data==='r_hours'){
        return ctx.reply(`🕐 HOURS\nCurrent: ${restaurant.openingHours||'Not set'}`, Markup.inlineKeyboard([
          [Markup.button.callback('✏️ EDIT HOURS','r_edit_hours')]
        ]));
      }
      if(data==='r_edit_hours'){
        pendingTextInput.set(tgUserId, {type:'sethours', restaurantId:restaurant.id});
        return ctx.reply('✏️ Send your hours\nExample: 10:00-22:00');
      }
      if(data==='r_sales'){
        const orders = db.orders.filter(o=>o.restaurantId===restaurant.id);
        const completed = orders.filter(o=>o.status==='COMPLETED');
        const today = todayStr();
        const todaysOrders = orders.filter(o=>o.createdAt.startsWith(today));
        const totalRevenue = completed.reduce((sum,o)=>sum+(o.total||0),0);
        const todayRevenue = todaysOrders.filter(o=>o.status==='COMPLETED').reduce((sum,o)=>sum+(o.total||0),0);
        return ctx.reply(`📊 SALES\nToday: ${todaysOrders.length} orders - ₹${todayRevenue}\nAll time: ${orders.length} orders (${completed.length} completed) - ₹${totalRevenue}`);
      }
      if(data==='r_settings'){
        return ctx.reply(`⚙️ SETTINGS\n${restaurant.name}\nStatus: ${restaurant.status} | ${restaurant.isOpen?'🟢 Open':'🔴 Closed'} | ${restaurant.isBusy?'🟡 Busy':'🟢 Not busy'}\n\nUse these buttons from the main menu to change things:\nProfile, Hours, Prices, Payments, Staff\n\nOr /staffpin to regenerate today's staff PIN immediately.`, Markup.inlineKeyboard([
          [Markup.button.callback(restaurant.isOpen?'🔴 Close Shop':'🟢 Open Shop','r_toggle_open'), Markup.button.callback(restaurant.isBusy?'🟢 Not Busy':'🟡 Busy Mode','r_toggle_busy')]
        ]));
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
    // Strip EVERY leading "/additem" (not just the first) - if the phone's
    // autocomplete or a mistaken retype doubles it up (e.g. "/additem
    // /additem Jadoh | 210 | ..."), a plain single .replace() only removes
    // one copy and the leftover "/additem" ends up saved as part of the
    // item's actual name/description, visible to customers on the website.
    let text = ctx.message.text;
    while(/^\s*\/additem\b/i.test(text)) text = text.replace(/^\s*\/additem\b/i, '');
    text = text.trim();
    const parts = text.split('|').map(s=>s.trim());
    if(parts.length<2) return ctx.reply('Usage: /additem Name | Price | CategoryName (optional)\nExample: /additem Chicken Burger | 250 | Burgers');
    const restaurant = findRestaurantByTelegramUser(ctx.from.id);
    if(!restaurant) return ctx.reply('Not linked');
    const [name, priceStr, catName] = parts;
    const price = Number(priceStr);
    if(!name || !Number.isFinite(price) || price<=0) return ctx.reply('❌ Invalid name or price. Example: /additem Chicken Burger | 250 | Burgers');
    if(name.startsWith('/')) return ctx.reply('❌ Item name can\'t start with "/". Looks like the command got typed twice - try again as:\n/additem '+name.replace(/^\/+\S*\s*/,'')+' | '+priceStr+(catName?' | '+catName:''));
    applyContentChangeAndNotify(restaurant, 'ADD_ITEM', {name, price, catName: catName||'General'}, `➕ NEW ITEM\n${name} - ₹${price}\nCategory: ${catName||'General'}`);
    ctx.reply(`✅ Added and live now:\n${name} - ₹${price}`);
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
    const oldPrice = item.price;
    applyContentChangeAndNotify(restaurant, 'EDIT_PRICE', {itemId:item.id, newPrice}, `💰 PRICE CHANGE\n${item.name}\n₹${oldPrice} → ₹${newPrice}`);
    ctx.reply(`✅ ${item.name}: ₹${oldPrice} → ₹${newPrice} - live now. Existing orders are never affected.`);
  });

  bot.command('myitems', async (ctx)=>{
    const restaurant = findRestaurantByTelegramUser(ctx.from.id);
    if(!restaurant) return ctx.reply('Not linked');
    const items = db.menuItems.filter(i=>i.restaurantId===restaurant.id);
    if(items.length===0) return ctx.reply('No items yet. Add one with /additem Name | Price | Category');
    ctx.reply(items.map((i,idx)=>`${idx+1}. ${i.name} - ₹${i.price} ${i.isAvailable?'✅':'❌'}`).join('\n')+'\n\nUse /setprice <number> <new price> or /itemimage <number> (then send a photo) to change one.');
  });

  // /itemimage <item number>, then send a photo in the next message - the
  // photo handler below picks this up. Goes live instantly, admin is just notified.
  const pendingItemImage = new Map(); // telegramUserId -> {restaurantId, itemId}
  bot.command('itemimage', async (ctx)=>{
    const restaurant = findRestaurantByTelegramUser(ctx.from.id);
    if(!restaurant) return ctx.reply('Not linked');
    const idx = Number(ctx.message.text.replace('/itemimage','').trim()) - 1;
    const items = db.menuItems.filter(i=>i.restaurantId===restaurant.id);
    const item = items[idx];
    if(!item) return ctx.reply('❌ No item with that number. Send /myitems to see the list.');
    pendingItemImage.set(ctx.from.id, {restaurantId:restaurant.id, itemId:item.id, itemName:item.name});
    ctx.reply(`📷 Now send a photo for "${item.name}". Goes live immediately.`);
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
    restaurant.isVisible=true;
    saveDB();
    logAudit('restaurant:'+restaurant.id, 'GO_LIVE', restaurant.id);
    ctx.reply('🟢 GO LIVE SUCCESS! Your restaurant is now visible to customers on the website.');

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
    if(pendingAdminImage.has(ctx.from.id)){
      pendingAdminImage.delete(ctx.from.id);
      return ctx.reply('❌ Image upload cancelled.');
    }
    return ctx.reply('Nothing to cancel.');
  });

  // ==== SUPER ADMIN: mirror every website-admin-dashboard power in Telegram ====
  // These apply INSTANTLY (no pendingChanges approval queue) - the person
  // running these commands already is the Super Admin, exactly like the
  // website dashboard buttons/uploads. Same audit trail + GitHub sync as
  // every other content edit.
  function findRestaurantByCode(code){
    const padded = String(code||'').trim().padStart(3,'0');
    return db.restaurants.find(r=>r.code===padded);
  }
  bot.command('pin', (ctx)=>{
    if(!isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized');
    const r = findRestaurantByCode(ctx.message.text.replace('/pin','').trim());
    if(!r) return ctx.reply('❌ No restaurant with that code.');
    r.isPinned = !r.isPinned;
    saveDB();
    logAudit('superadmin:telegram', r.isPinned?'PIN':'UNPIN', r.id);
    persistContentChange('telegram:'+(r.isPinned?'pin':'unpin')+':'+r.code).catch(e=>console.error('backup send failed', e.message));
    ctx.reply(`${r.isPinned?'📌 Pinned':'📍 Unpinned'}: ${r.name}`);
  });
  bot.command('highlight', (ctx)=>{
    if(!isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized');
    const r = findRestaurantByCode(ctx.message.text.replace('/highlight','').trim());
    if(!r) return ctx.reply('❌ No restaurant with that code.');
    r.isHighlighted = !r.isHighlighted;
    saveDB();
    logAudit('superadmin:telegram', r.isHighlighted?'HIGHLIGHT':'REMOVE_HIGHLIGHT', r.id);
    persistContentChange('telegram:'+(r.isHighlighted?'highlight':'unhighlight')+':'+r.code).catch(e=>console.error('backup send failed', e.message));
    ctx.reply(`${r.isHighlighted?'✨ Highlighted':'Highlight removed from'}: ${r.name}`);
  });
  bot.command('premium', (ctx)=>{
    if(!isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized');
    const r = findRestaurantByCode(ctx.message.text.replace('/premium','').trim());
    if(!r) return ctx.reply('❌ No restaurant with that code.');
    r.premium = !r.premium;
    saveDB();
    logAudit('superadmin:telegram', r.premium?'MAKE_PREMIUM':'REMOVE_PREMIUM', r.id);
    persistContentChange('telegram:'+(r.premium?'premium':'unpremium')+':'+r.code).catch(e=>console.error('backup send failed', e.message));
    ctx.reply(`${r.premium?'👑 Marked premium':'Premium removed from'}: ${r.name}`);
  });

  // /editinfo <code> | field=value | field2=value2  (same allowed fields as
  // the website dashboard's PATCH /api/admin/restaurants/:id)
  bot.command('editinfo', (ctx)=>{
    if(!isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized');
    const parts = ctx.message.text.replace('/editinfo','').trim().split('|').map(s=>s.trim());
    const usage = 'Usage: /editinfo <code> | field=value | field2=value2\nFields: name, description, deliveryFee, minOrder, commissionRate, openingHours, cuisine, city\nExample: /editinfo 001 | deliveryFee=30 | minOrder=150';
    if(parts.length<2) return ctx.reply(usage);
    const r = findRestaurantByCode(parts[0]);
    if(!r) return ctx.reply('❌ No restaurant with that code.');
    const allowed = ['name','description','deliveryFee','minOrder','commissionRate','openingHours','cuisine','city'];
    const numeric = ['deliveryFee','minOrder','commissionRate'];
    const prev = {}; const next = {};
    for(const pair of parts.slice(1)){
      const eq = pair.indexOf('=');
      if(eq<0) continue;
      const key = pair.slice(0,eq).trim();
      const val = pair.slice(eq+1).trim();
      if(!allowed.includes(key) || val==='') continue;
      prev[key] = r[key];
      r[key] = numeric.includes(key) ? Number(val) : val;
      next[key] = r[key];
    }
    if(Object.keys(next).length===0) return ctx.reply('❌ No valid fields recognized.\n'+usage);
    saveDB();
    logAudit('superadmin:telegram', 'UPDATE_RESTAURANT', r.id, prev, next);
    persistContentChange('telegram:update_restaurant:'+r.code).catch(e=>console.error('backup send failed', e.message));
    ctx.reply(`✅ Updated ${r.name}:\n`+Object.entries(next).map(([k,v])=>`${k}: ${v}`).join('\n'));
  });

  // /logo <code> or /cover <code>, then send a photo in the next message -
  // the photo handler below picks this up via pendingAdminImage. Applies
  // instantly, unlike a restaurant owner's own photo uploads.
  const pendingAdminImage = new Map(); // telegramUserId -> {type:'logo'|'cover'|'item', restaurantId, restaurantCode, itemId?, itemName?}
  bot.command('logo', (ctx)=>{
    if(!isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized');
    const r = findRestaurantByCode(ctx.message.text.replace('/logo','').trim());
    if(!r) return ctx.reply('❌ No restaurant with that code. Usage: /logo <code>, then send a photo.');
    pendingAdminImage.set(ctx.from.id, {type:'logo', restaurantId:r.id, restaurantCode:r.code});
    ctx.reply(`📷 Now send the logo photo for ${r.name}. Goes live immediately.`);
  });
  bot.command('cover', (ctx)=>{
    if(!isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized');
    const r = findRestaurantByCode(ctx.message.text.replace('/cover','').trim());
    if(!r) return ctx.reply('❌ No restaurant with that code. Usage: /cover <code>, then send a photo.');
    pendingAdminImage.set(ctx.from.id, {type:'cover', restaurantId:r.id, restaurantCode:r.code});
    ctx.reply(`📷 Now send the cover photo for ${r.name}. Goes live immediately.`);
  });
  bot.command('sitelogo', (ctx)=>{
    if(!isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized');
    pendingAdminImage.set(ctx.from.id, {type:'site_logo'});
    ctx.reply('🖼 Now send the photo to use as the site-wide logo. Goes live immediately.');
  });
  bot.command('sitebackground', (ctx)=>{
    if(!isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized');
    pendingAdminImage.set(ctx.from.id, {type:'site_background'});
    ctx.reply('🌄 Now send the photo to use as the site-wide background. Goes live immediately.');
  });

  // Super-admin-wide item list (any restaurant, unlike /myitems which is
  // scoped to the owner sending it) - gives the item numbers /edititem and
  // /adminitemimage need.
  bot.command('items', (ctx)=>{
    if(!isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized');
    const r = findRestaurantByCode(ctx.message.text.replace('/items','').trim());
    if(!r) return ctx.reply('Usage: /items <code>');
    const items = db.menuItems.filter(i=>i.restaurantId===r.id);
    if(items.length===0) return ctx.reply('No items yet for '+r.name);
    ctx.reply(`${r.name} items:\n`+items.map((i,idx)=>`${idx+1}. ${i.name} - ₹${i.price} ${i.isAvailable?'✅':'❌'}`).join('\n')+`\n\nUse /edititem ${r.code} <number> | field=value or /adminitemimage ${r.code} <number> (then photo) - applies instantly, no approval needed.`);
  });

  // /edititem <code> <number> | field=value | field2=value2 (same allowed
  // fields as the website dashboard's PATCH /api/admin/menu-items/:id)
  bot.command('edititem', (ctx)=>{
    if(!isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized');
    const raw = ctx.message.text.replace('/edititem','').trim();
    const parts = raw.split('|').map(s=>s.trim());
    const head = (parts[0]||'').split(/\s+/);
    const usage = 'Usage: /edititem <code> <item number> | field=value | field2=value2\nFields: name, price, description, isAvailable, isVeg\nSend /items <code> to see numbers.';
    const r = findRestaurantByCode(head[0]);
    const idx = Number(head[1]) - 1;
    if(!r) return ctx.reply(usage);
    const items = db.menuItems.filter(i=>i.restaurantId===r.id);
    const item = items[idx];
    if(!item) return ctx.reply('❌ No item with that number. Send /items '+r.code+' to see the list.');
    const allowed = ['name','price','description','isAvailable','isVeg'];
    const prev = {}; const next = {};
    for(const pair of parts.slice(1)){
      const eq = pair.indexOf('=');
      if(eq<0) continue;
      const key = pair.slice(0,eq).trim();
      const val = pair.slice(eq+1).trim();
      if(!allowed.includes(key) || val==='') continue;
      prev[key] = item[key];
      if(key==='price') item[key] = Number(val);
      else if(key==='isAvailable' || key==='isVeg') item[key] = ['true','1','yes'].includes(val.toLowerCase());
      else item[key] = val;
      next[key] = item[key];
    }
    if(Object.keys(next).length===0) return ctx.reply('❌ No valid fields recognized.\n'+usage);
    saveDB();
    logAudit('superadmin:telegram', 'UPDATE_MENU_ITEM', item.id, prev, next);
    persistContentChange('telegram:update_item:'+r.code).catch(e=>console.error('backup send failed', e.message));
    ctx.reply(`✅ Updated ${item.name}:\n`+Object.entries(next).map(([k,v])=>`${k}: ${v}`).join('\n'));
  });

  // /adminitemimage <code> <number>, then send a photo - applies instantly
  // (unlike /itemimage, which is the restaurant owner's version and goes
  // through admin approval).
  bot.command('adminitemimage', (ctx)=>{
    if(!isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized');
    const [code, numStr] = ctx.message.text.replace('/adminitemimage','').trim().split(/\s+/);
    const r = findRestaurantByCode(code);
    const idx = Number(numStr) - 1;
    const usage = 'Usage: /adminitemimage <code> <item number>\nSend /items <code> to see numbers.';
    if(!r) return ctx.reply(usage);
    const items = db.menuItems.filter(i=>i.restaurantId===r.id);
    const item = items[idx];
    if(!item) return ctx.reply('❌ No item with that number. Send /items '+r.code+' to see the list.');
    pendingAdminImage.set(ctx.from.id, {type:'item', restaurantId:r.id, restaurantCode:r.code, itemId:item.id, itemName:item.name});
    ctx.reply(`📷 Now send a photo for "${item.name}". Goes live immediately.`);
  });

  // /relink <code> - mint a fresh Telegram link for an ALREADY-APPROVED
  // restaurant (e.g. after a Render reset wiped telegramAccounts/telegramLinks
  // before the GitHub-sync fix, or if an owner just needs to re-link on a new
  // phone/account). Re-registering through the website form always fails for
  // these restaurants with "Application already exists" - this is the actual
  // fix, since the restaurant/application already exists and doesn't need to
  // be recreated, just re-linked.
  bot.command('relink', (ctx)=>{
    if(!isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized');
    const r = findRestaurantByCode(ctx.message.text.replace('/relink','').trim());
    if(!r) return ctx.reply('Usage: /relink <code>');
    if(!['APPROVED','LIVE'].includes(r.status)) return ctx.reply(`❌ ${r.name} is status ${r.status} - only APPROVED or LIVE restaurants can be relinked. Use /pending to approve it first if it's a fresh application.`);
    const token = uuidv4().replace(/-/g,'').slice(0,16);
    db.telegramLinks.push({token, restaurantId:r.id, used:false, createdAt:new Date().toISOString()});
    saveDB();
    logAudit('superadmin:telegram', 'RELINK_RESTAURANT', r.id);
    syncContentToGitHub('relink:'+r.code).catch(e=>console.error('backup send failed', e.message));
    ctx.reply(`🔗 New link for ${r.name}:\nhttps://t.me/${ctx.botInfo.username}?start=link_${token}\n\nSend this to the restaurant owner. Their old link (if any) still won't work, but this one links them straight back to their existing restaurant - no data lost.`);
  });

  // Super-admin-only: change an org member's role. Exercises write:org (the
  // one GitHub admin action here that isn't read-only) — deliberately kept
  // to a single, explicit, confirmable command rather than a tap-through
  // button, since it changes another person's org access.
  bot.command('orgmember', async (ctx)=>{
    if(!isSuperAdmin(ctx.from.id)) return; // silently ignore, same as other sa-only commands
    if(!githubOrgConfigured()) return ctx.reply('GitHub org admin isn\'t configured (need GITHUB_TOKEN + GITHUB_ORG).');
    const parts = ctx.message.text.replace('/orgmember','').trim().split(/\s+/).filter(Boolean);
    const [username, role] = parts;
    if(!username || !['member','admin'].includes(role)){
      return ctx.reply('Usage: /orgmember <github-username> <member|admin>');
    }
    try{
      const result = await ghSetMemberRole(username, role);
      logAudit('superadmin:'+ctx.from.id, 'GITHUB_SET_ORG_ROLE', username, null, {role});
      ctx.reply(`✅ ${username} is now org role "${result.role}" (state: ${result.state}).`);
    }catch(e){
      ctx.reply('❌ '+e.message);
    }
  });

  // Any plain text from a super admin who just tapped "📢 Announcements" is
  // treated as the announcement body and broadcast to every live
  // restaurant's linked Telegram account(s). Registered after every
  // bot.command(...) above, so commands (which start with '/') are always
  // handled by their own handler first and never reach here.
  bot.on('text', async (ctx)=>{
    const tgUserId = ctx.from.id;

    // Tap-a-button-then-type replies (Add Item / Edit Price / Edit UPI /
    // Edit Hours / Edit Delivery Fee / Rename Category). Checked before the
    // announcement-broadcast state below since they're mutually exclusive.
    if(pendingTextInput.has(tgUserId)){
      const req = pendingTextInput.get(tgUserId);
      const restaurant = db.restaurants.find(r=>r.id===req.restaurantId);
      if(!restaurant){ pendingTextInput.delete(tgUserId); return ctx.reply('❌ Restaurant no longer exists.'); }
      const text = ctx.message.text.trim();
      if(req.type==='additem'){
        pendingTextInput.delete(tgUserId);
        // Same defensive stripping as the /additem command, in case the
        // reply itself starts with a stray "/additem" (phone autocomplete,
        // or the owner typing the old command out of habit).
        let cleaned = text;
        while(/^\s*\/additem\b/i.test(cleaned)) cleaned = cleaned.replace(/^\s*\/additem\b/i, '');
        cleaned = cleaned.trim();
        const parts = cleaned.split('|').map(s=>s.trim());
        if(parts.length<2) return ctx.reply('❌ Usage: Name | Price | Category (optional)\nExample: Chicken Burger | 250 | Burgers');
        const [name, priceStr, catName] = parts;
        const price = Number(priceStr);
        if(!name || !Number.isFinite(price) || price<=0) return ctx.reply('❌ Invalid name or price. Example: Chicken Burger | 250 | Burgers');
        applyContentChangeAndNotify(restaurant, 'ADD_ITEM', {name, price, catName: catName||'General'}, `➕ NEW ITEM\n${name} - ₹${price}\nCategory: ${catName||'General'}`);
        return ctx.reply(`✅ Added and live now:\n${name} - ₹${price}`);
      }
      if(req.type==='setprice'){
        pendingTextInput.delete(tgUserId);
        const item = db.menuItems.find(i=>i.id===req.itemId && i.restaurantId===restaurant.id);
        if(!item) return ctx.reply('❌ Item no longer exists.');
        const price = Number(text.replace(/[^\d.]/g,''));
        if(!Number.isFinite(price) || price<=0) return ctx.reply('❌ Send just the number, e.g. 199');
        applyContentChangeAndNotify(restaurant, 'EDIT_PRICE', {itemId:item.id, newPrice:price}, `💰 PRICE CHANGE\n${item.name}: ₹${item.price} → ₹${price}`);
        return ctx.reply(`✅ Price updated and live now: ${item.name} - ₹${price}`);
      }
      if(req.type==='setupi'){
        pendingTextInput.delete(tgUserId);
        restaurant.upiId = text;
        saveDB();
        persistContentChange('update:setupi:'+restaurant.name).catch(e=>console.error('backup send failed', e.message));
        return ctx.reply(`✅ UPI Updated: ${text}`);
      }
      if(req.type==='sethours'){
        pendingTextInput.delete(tgUserId);
        restaurant.openingHours = text;
        saveDB();
        persistContentChange('update:sethours:'+restaurant.name).catch(e=>console.error('backup send failed', e.message));
        return ctx.reply(`✅ Hours updated: ${text}`);
      }
      if(req.type==='setdelivery'){
        pendingTextInput.delete(tgUserId);
        const fee = Number(text.replace(/[^\d.]/g,''));
        if(!Number.isFinite(fee) || fee<0) return ctx.reply('❌ Send just the number, e.g. 30');
        restaurant.deliveryFee = fee;
        saveDB();
        persistContentChange('update:setdelivery:'+restaurant.name).catch(e=>console.error('backup send failed', e.message));
        return ctx.reply(`✅ Delivery fee set to ₹${fee}`);
      }
      if(req.type==='renamecat'){
        pendingTextInput.delete(tgUserId);
        const cat = db.categories.find(c=>c.id===req.catId && c.restaurantId===restaurant.id);
        if(!cat) return ctx.reply('❌ Category no longer exists.');
        const oldName = cat.name;
        cat.name = text;
        saveDB();
        notifyAdminsCategoryChange(restaurant, `✏️ CATEGORY RENAMED\n[${restaurant.code}] ${restaurant.name}\n"${oldName}" → "${text}"\nAlready live.`);
        persistContentChange('update:renamecat:'+restaurant.name).catch(e=>console.error('backup send failed', e.message));
        return ctx.reply(`✅ Category renamed and live now: "${text}"`);
      }
      return;
    }

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
    // Super Admin direct uploads (logo/cover/item image via /logo, /cover,
    // /adminitemimage) - checked first since the admin isn't necessarily a
    // linked restaurant Telegram account. Applies instantly, no approval.
    if(isSuperAdmin(ctx.from.id) && pendingAdminImage.has(ctx.from.id)){
      const req = pendingAdminImage.get(ctx.from.id);
      pendingAdminImage.delete(ctx.from.id);
      try{
        const fileId = ctx.message.photo[ctx.message.photo.length-1].file_id;
        const fileLink = await ctx.telegram.getFileLink(fileId);
        if(req.type==='logo' || req.type==='cover'){
          const r = db.restaurants.find(x=>x.id===req.restaurantId);
          if(!r) return ctx.reply('❌ Restaurant no longer exists.');
          if(req.type==='logo') r.logoUrl = fileLink.href; else r.coverUrl = fileLink.href;
          saveDB();
          logAudit('superadmin:telegram', req.type==='logo'?'UPDATE_LOGO':'UPDATE_COVER', r.id);
          persistContentChange('telegram:update_'+req.type+':'+r.code).catch(e=>console.error('backup send failed', e.message));
          return ctx.reply(`✅ ${req.type==='logo'?'Logo':'Cover'} updated for ${r.name}`, {reply_markup:{inline_keyboard:[[{text:'👀 PREVIEW', url:fileLink.href}]]}});
        }
        if(req.type==='item'){
          const item = db.menuItems.find(i=>i.id===req.itemId);
          if(!item) return ctx.reply('❌ Item no longer exists.');
          item.imageUrl = fileLink.href;
          saveDB();
          logAudit('superadmin:telegram', 'UPDATE_ITEM_IMAGE', item.id);
          persistContentChange('telegram:update_item_image:'+req.restaurantCode).catch(e=>console.error('backup send failed', e.message));
          return ctx.reply(`✅ Image updated for ${item.name}`, {reply_markup:{inline_keyboard:[[{text:'👀 PREVIEW', url:fileLink.href}]]}});
        }
        if(req.type==='site_logo' || req.type==='site_background'){
          if(!db.siteSettings) db.siteSettings = { logoUrl:null, backgroundUrl:null };
          if(req.type==='site_logo') db.siteSettings.logoUrl = fileLink.href; else db.siteSettings.backgroundUrl = fileLink.href;
          saveDB();
          logAudit('superadmin:telegram', req.type==='site_logo'?'UPDATE_SITE_LOGO':'UPDATE_SITE_BACKGROUND', 'site');
          persistContentChange('telegram:update_'+req.type).catch(e=>console.error('backup send failed', e.message));
          return ctx.reply(`✅ Site ${req.type==='site_logo'?'logo':'background'} updated - live on the website now.`, {reply_markup:{inline_keyboard:[[{text:'👀 PREVIEW', url:fileLink.href}]]}});
        }
      }catch(e){
        return ctx.reply('Failed to process photo: '+e.message);
      }
      return;
    }

    const restaurant = findRestaurantByTelegramUser(ctx.from.id);
    if(!restaurant) return;
    try{
      const fileId = ctx.message.photo[ctx.message.photo.length-1].file_id;
      const fileLink = await ctx.telegram.getFileLink(fileId);

      const itemImageReq = pendingItemImage.get(ctx.from.id);
      if(itemImageReq && itemImageReq.restaurantId===restaurant.id){
        pendingItemImage.delete(ctx.from.id);
        applyContentChangeAndNotify(restaurant, 'ITEM_IMAGE', {itemId:itemImageReq.itemId, imageUrl:fileLink.href}, `🖼 IMAGE CHANGE\n${itemImageReq.itemName}`);
        return ctx.reply(`✅ Image updated and live now for "${itemImageReq.itemName}".`);
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

  // Receiving end for the repo webhook created from 🐙 GitHub -> Webhooks ->
  // Create deploy webhook. Relays push/deploy events straight to every
  // Super Admin's Telegram. Requires GITHUB_WEBHOOK_SECRET to match what the
  // hook was created with (see ghCreateDeployWebhook above).
  app.post('/github/webhook', (req,res)=>{
    if(!verifyGithubSignature(req)) return res.sendStatus(401);
    const event = req.headers['x-github-event'] || 'unknown';
    const payload = req.body || {};
    res.sendStatus(200); // ack immediately, GitHub retries on slow/failed responses
    if(SUPER_ADMIN_IDS.length===0) return;
    let text = null;
    if(event === 'push'){
      const branch = (payload.ref||'').replace('refs/heads/','');
      const commits = Array.isArray(payload.commits) ? payload.commits : [];
      text = `🐙 PUSH to ${GITHUB_REPO} (${branch})\n${payload.pusher ? 'by '+payload.pusher.name : ''}\n${commits.slice(0,5).map(c=>'• '+(c.message||'').split('\n')[0]).join('\n') || 'No commits listed'}`;
    } else if(event === 'deployment_status'){
      const s = payload.deployment_status || {};
      text = `🚀 DEPLOYMENT ${s.state || 'update'} for ${GITHUB_REPO}\n${s.description || ''}`;
    } else if(event === 'ping'){
      text = `🐙 Webhook connected for ${GITHUB_REPO} ✅`;
    }
    if(text){
      for(const adminId of SUPER_ADMIN_IDS){
        bot.telegram.sendMessage(adminId, text).catch(e=>console.error('github webhook notify failed', e.message));
      }
    }
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
    const buttons = {reply_markup:{inline_keyboard:[
      [{text:'✅ VERIFY', callback_data:`verify_pay_${order.code}`}, {text:'❌ REJECT', callback_data:`reject_pay_${order.code}`}],
      [{text:'🔄 REQUEST NEW', callback_data:`request_receipt_${order.code}`}]
    ]}};
    try{
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

// ---- ADMIN: site-wide logo/background (mirrors /sitelogo, /sitebackground) ----
app.post('/api/admin/site-logo', requireAdminKey, upload.single('image'), (req,res)=>{
  if(!req.file) return res.status(400).json({error:'No file'});
  if(!db.siteSettings) db.siteSettings = { logoUrl:null, backgroundUrl:null };
  db.siteSettings.logoUrl = `/uploads/${req.file.filename}`;
  saveDB();
  logAudit('superadmin:webdashboard', 'UPDATE_SITE_LOGO', 'site');
  persistContentChange('webdashboard:update_site_logo').catch(e=>console.error('backup send failed', e.message));
  res.json({ok:true, logoUrl:db.siteSettings.logoUrl});
});
app.post('/api/admin/site-background', requireAdminKey, upload.single('image'), (req,res)=>{
  if(!req.file) return res.status(400).json({error:'No file'});
  if(!db.siteSettings) db.siteSettings = { logoUrl:null, backgroundUrl:null };
  db.siteSettings.backgroundUrl = `/uploads/${req.file.filename}`;
  saveDB();
  logAudit('superadmin:webdashboard', 'UPDATE_SITE_BACKGROUND', 'site');
  persistContentChange('webdashboard:update_site_background').catch(e=>console.error('backup send failed', e.message));
  res.json({ok:true, backgroundUrl:db.siteSettings.backgroundUrl});
});

// ---- ADMIN: show/hide (mirrors /show, /hide) ----
app.post('/api/admin/restaurants/:id/visibility', requireAdminKey, (req,res)=>{
  const r = db.restaurants.find(x=>x.id===req.params.id);
  if(!r) return res.status(404).json({error:'Not found'});
  const makeVisible = !!req.body.visible;
  if(r.status!=='LIVE') return res.status(409).json({error:`${r.name} is not LIVE yet (status: ${r.status}) - it must finish setup and go live first.`});
  r.isVisible = makeVisible;
  saveDB();
  logAudit('superadmin:webdashboard', makeVisible?'SHOW_RESTAURANT':'HIDE_RESTAURANT', r.id);
  persistContentChange('webdashboard:'+(makeVisible?'show:':'hide:')+r.code).catch(e=>console.error('backup send failed', e.message));
  res.json(publicRestaurant(r));
});

// ---- ADMIN: relink (mirrors /relink <code>) ----
app.post('/api/admin/restaurants/:id/relink', requireAdminKey, (req,res)=>{
  const r = db.restaurants.find(x=>x.id===req.params.id);
  if(!r) return res.status(404).json({error:'Not found'});
  if(!['APPROVED','LIVE'].includes(r.status)) return res.status(409).json({error:`${r.name} is status ${r.status} - only APPROVED or LIVE restaurants can be relinked.`});
  const token = uuidv4().replace(/-/g,'').slice(0,16);
  db.telegramLinks.push({token, restaurantId:r.id, used:false, createdAt:new Date().toISOString()});
  saveDB();
  logAudit('superadmin:webdashboard', 'RELINK_RESTAURANT', r.id);
  syncContentToGitHub('relink:'+r.code).catch(e=>console.error('backup send failed', e.message));
  res.json({ok:true, linkUrl: `https://t.me/${(process.env.TELEGRAM_BOT_USERNAME||'your_bot')}?start=link_${token}`});
});

// ================= OWNER API (restaurant owner web dashboard) =================
// Every route below is the HTTP-reachable twin of a Telegram bot command a
// restaurant owner already has (/additem, /setprice, /itemimage, /mycats,
// /renamecat, /reordercat, /setupi, /sethours, /golive, /setdelivery,
// /staffpin) - same logic, same audit trail, same instant-live behavior.
app.post('/api/owner/login', staffLoginLimiter, (req,res)=>{
  const { email, password } = req.body||{};
  const r = db.restaurants.find(x=>x.email===email);
  if(!r || !r.passwordHash || !bcrypt.compareSync(password||'', r.passwordHash)){
    logAudit('owner:'+req.ip, 'OWNER_LOGIN_FAILED', email||'');
    return res.status(401).json({error:'Invalid email or password'});
  }
  logAudit('owner:'+r.id, 'OWNER_LOGIN', r.id);
  res.json({ok:true, token: issueOwnerToken(r.id), restaurant: publicRestaurant(r)});
});

app.get('/api/owner/me', requireOwnerAuth, (req,res)=>{
  const r = req.ownerRestaurant;
  const categories = db.categories.filter(c=>c.restaurantId===r.id).sort((a,b)=>a.sortOrder-b.sortOrder);
  const items = db.menuItems.filter(i=>i.restaurantId===r.id);
  res.json({...publicRestaurant(r), categories, items});
});

// /additem Name | Price | Category
app.post('/api/owner/items', requireOwnerAuth, (req,res)=>{
  const r = req.ownerRestaurant;
  const { name, price, catName } = req.body||{};
  const numPrice = Number(price);
  if(!name || !Number.isFinite(numPrice) || numPrice<=0) return res.status(400).json({error:'Invalid name or price'});
  const result = applyContentChangeAndNotify(r, 'ADD_ITEM', {name, price:numPrice, catName: catName||'General'}, `➕ NEW ITEM\n${name} - ₹${numPrice}\nCategory: ${catName||'General'}`);
  if(!result.ok) return res.status(400).json({error:result.error});
  res.json({ok:true});
});

// /setprice <item> <newPrice>
app.patch('/api/owner/items/:id/price', requireOwnerAuth, (req,res)=>{
  const r = req.ownerRestaurant;
  const item = db.menuItems.find(i=>i.id===req.params.id && i.restaurantId===r.id);
  if(!item) return res.status(404).json({error:'Item not found'});
  const newPrice = Number(req.body.price);
  if(!Number.isFinite(newPrice) || newPrice<=0) return res.status(400).json({error:'Invalid price'});
  const oldPrice = item.price;
  const result = applyContentChangeAndNotify(r, 'EDIT_PRICE', {itemId:item.id, newPrice}, `💰 PRICE CHANGE\n${item.name}\n₹${oldPrice} → ₹${newPrice}`);
  if(!result.ok) return res.status(400).json({error:result.error});
  res.json({ok:true, price:newPrice});
});

// Name/description/availability - direct edit, same fields the Super Admin
// dashboard can set, just scoped to the owner's own items.
app.patch('/api/owner/items/:id', requireOwnerAuth, (req,res)=>{
  const r = req.ownerRestaurant;
  const item = db.menuItems.find(i=>i.id===req.params.id && i.restaurantId===r.id);
  if(!item) return res.status(404).json({error:'Item not found'});
  const allowed = ['name','description','isAvailable','isVeg'];
  const prev = {}; const next = {};
  for(const key of allowed){
    if(req.body[key] !== undefined){
      prev[key] = item[key];
      item[key] = req.body[key];
      next[key] = item[key];
    }
  }
  saveDB();
  logAudit('restaurant:'+r.id, 'UPDATE_MENU_ITEM', item.id, prev, next);
  persistContentChange('owner:update_item:'+r.code).catch(e=>console.error('backup send failed', e.message));
  res.json(item);
});

// /itemimage <item>, then a photo - here it's just a file upload
app.post('/api/owner/items/:id/image', requireOwnerAuth, upload.single('image'), (req,res)=>{
  const r = req.ownerRestaurant;
  const item = db.menuItems.find(i=>i.id===req.params.id && i.restaurantId===r.id);
  if(!item) return res.status(404).json({error:'Item not found'});
  if(!req.file) return res.status(400).json({error:'No file'});
  const imageUrl = `/uploads/${req.file.filename}`;
  const result = applyContentChangeAndNotify(r, 'ITEM_IMAGE', {itemId:item.id, imageUrl}, `🖼 IMAGE CHANGE\n${item.name}`);
  if(!result.ok) return res.status(400).json({error:result.error});
  res.json({ok:true, imageUrl});
});

// /mycats
app.get('/api/owner/categories', requireOwnerAuth, (req,res)=>{
  const cats = db.categories.filter(c=>c.restaurantId===req.ownerRestaurant.id).sort((a,b)=>a.sortOrder-b.sortOrder);
  res.json(cats);
});

// /renamecat <number> <new name>
app.patch('/api/owner/categories/:id', requireOwnerAuth, (req,res)=>{
  const r = req.ownerRestaurant;
  const cat = db.categories.find(c=>c.id===req.params.id && c.restaurantId===r.id);
  if(!cat) return res.status(404).json({error:'Category not found'});
  const newName = (req.body.name||'').trim();
  if(!newName) return res.status(400).json({error:'Name cannot be empty'});
  const oldName = cat.name;
  cat.name = newName;
  saveDB();
  logAudit('restaurant:'+r.id, 'RENAME_CATEGORY', cat.id, {name:oldName}, {name:newName});
  notifyAdminsCategoryChange(r, `✏️ CATEGORY RENAMED\n[${r.code}] ${r.name}\n"${oldName}" → "${newName}"\nAlready live.`);
  persistContentChange('owner:renamecat:'+r.code).catch(e=>console.error('backup send failed', e.message));
  res.json(cat);
});

// /reordercat 3,1,2
app.post('/api/owner/categories/reorder', requireOwnerAuth, (req,res)=>{
  const r = req.ownerRestaurant;
  const cats = db.categories.filter(c=>c.restaurantId===r.id).sort((a,b)=>a.sortOrder-b.sortOrder);
  const order = (req.body.order||[]).map(n=>Number(n));
  if(order.length!==cats.length || order.some(i=>!Number.isInteger(i) || i<0 || i>=cats.length) || new Set(order).size!==order.length){
    return res.status(400).json({error:`Send all ${cats.length} category indices, each exactly once.`});
  }
  order.forEach((origIdx, newPos)=>{ cats[origIdx].sortOrder = newPos; });
  saveDB();
  logAudit('restaurant:'+r.id, 'REORDER_CATEGORIES', r.id, null, order);
  persistContentChange('owner:reordercat:'+r.code).catch(e=>console.error('backup send failed', e.message));
  res.json({ok:true, categories: cats.sort((a,b)=>a.sortOrder-b.sortOrder)});
});

// /setupi, /sethours, /setdelivery
app.post('/api/owner/upi', requireOwnerAuth, (req,res)=>{
  const r = req.ownerRestaurant;
  r.upiId = (req.body.upiId||'').trim();
  saveDB();
  persistContentChange('owner:setupi:'+r.code).catch(e=>console.error('backup send failed', e.message));
  res.json({ok:true, upiId:r.upiId});
});
app.post('/api/owner/hours', requireOwnerAuth, (req,res)=>{
  const r = req.ownerRestaurant;
  r.openingHours = (req.body.openingHours||'').trim();
  saveDB();
  persistContentChange('owner:sethours:'+r.code).catch(e=>console.error('backup send failed', e.message));
  res.json({ok:true, openingHours:r.openingHours});
});
app.post('/api/owner/delivery-fee', requireOwnerAuth, (req,res)=>{
  const r = req.ownerRestaurant;
  const fee = Number(req.body.deliveryFee);
  if(!Number.isFinite(fee) || fee<0) return res.status(400).json({error:'Invalid delivery fee'});
  r.deliveryFee = fee;
  saveDB();
  persistContentChange('owner:setdelivery:'+r.code).catch(e=>console.error('backup send failed', e.message));
  res.json({ok:true, deliveryFee:fee});
});

// Restaurant's own logo/cover - same fields the Super Admin dashboard sets,
// just self-service for the owner.
app.post('/api/owner/logo', requireOwnerAuth, upload.single('image'), (req,res)=>{
  const r = req.ownerRestaurant;
  if(!req.file) return res.status(400).json({error:'No file'});
  r.logoUrl = `/uploads/${req.file.filename}`;
  saveDB();
  logAudit('restaurant:'+r.id, 'UPDATE_LOGO', r.id);
  persistContentChange('owner:update_logo:'+r.code).catch(e=>console.error('backup send failed', e.message));
  res.json({ok:true, logoUrl:r.logoUrl});
});
app.post('/api/owner/cover', requireOwnerAuth, upload.single('image'), (req,res)=>{
  const r = req.ownerRestaurant;
  if(!req.file) return res.status(400).json({error:'No file'});
  r.coverUrl = `/uploads/${req.file.filename}`;
  saveDB();
  logAudit('restaurant:'+r.id, 'UPDATE_COVER', r.id);
  persistContentChange('owner:update_cover:'+r.code).catch(e=>console.error('backup send failed', e.message));
  res.json({ok:true, coverUrl:r.coverUrl});
});

// /golive
app.post('/api/owner/golive', requireOwnerAuth, (req,res)=>{
  const r = req.ownerRestaurant;
  const hasMenu = db.menuItems.some(i=>i.restaurantId===r.id);
  const hasPayment = !!r.upiId;
  const hasHours = !!r.openingHours;
  if(!hasMenu) return res.status(400).json({error:'Need at least 1 menu item first.'});
  if(!hasPayment) return res.status(400).json({error:'Set a UPI ID first.'});
  if(!hasHours) return res.status(400).json({error:'Set opening hours first.'});
  r.status='LIVE'; r.isOpen=true; r.isVisible=true;
  saveDB();
  logAudit('restaurant:'+r.id, 'GO_LIVE', r.id);
  persistContentChange('owner:go_live:'+r.code).catch(e=>console.error('go-live backup send failed', e.message));
  res.json({ok:true, status:r.status});
});

// Open/Close shop, Busy toggle (mirrors the r_toggle_open / r_toggle_busy buttons)
app.post('/api/owner/toggle-open', requireOwnerAuth, (req,res)=>{
  const r = req.ownerRestaurant;
  r.isOpen = !r.isOpen;
  saveDB();
  logAudit('restaurant:'+r.id, r.isOpen?'OPEN_SHOP':'CLOSE_SHOP', r.id);
  persistContentChange('owner:toggle_open:'+r.code).catch(e=>console.error('backup send failed', e.message));
  res.json({ok:true, isOpen:r.isOpen});
});
app.post('/api/owner/toggle-busy', requireOwnerAuth, (req,res)=>{
  const r = req.ownerRestaurant;
  r.isBusy = !r.isBusy;
  saveDB();
  logAudit('restaurant:'+r.id, r.isBusy?'BUSY_MODE':'NOT_BUSY', r.id);
  persistContentChange('owner:toggle_busy:'+r.code).catch(e=>console.error('backup send failed', e.message));
  res.json({ok:true, isBusy:r.isBusy});
});

// /staffpin
app.post('/api/owner/staffpin', requireOwnerAuth, (req,res)=>{
  const r = req.ownerRestaurant;
  const pin = regenerateStaffPin(r);
  saveDB();
  logAudit('restaurant:'+r.id, 'REGENERATE_STAFF_PIN', r.id);
  res.json({ok:true, pin, restaurantId:r.id});
});

// /sales
app.get('/api/owner/sales', requireOwnerAuth, (req,res)=>{
  const r = req.ownerRestaurant;
  const orders = db.orders.filter(o=>o.restaurantId===r.id);
  const completed = orders.filter(o=>o.status==='COMPLETED');
  const today = todayStr();
  const todaysOrders = orders.filter(o=>o.createdAt.startsWith(today));
  const totalRevenue = completed.reduce((sum,o)=>sum+(o.total||0),0);
  const todayRevenue = todaysOrders.filter(o=>o.status==='COMPLETED').reduce((sum,o)=>sum+(o.total||0),0);
  res.json({todayOrders:todaysOrders.length, todayRevenue, allTimeOrders:orders.length, allTimeCompleted:completed.length, totalRevenue});
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
  syncContentToGitHub('webdashboard:approve_restaurant:'+application.id).catch(e=>console.error('backup send failed', e.message));
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

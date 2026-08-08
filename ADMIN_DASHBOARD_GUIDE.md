# 🔐 FALLS Super Admin Dashboard — Complete Guide

## Access & Security

### How to Access:
1. Open Falls website
2. Click hamburger menu (☰)
3. Select "👨‍💼 Admin Dashboard"
4. Enter PIN: **000000** (Change this immediately!)
5. You're logged in to the admin dashboard

### Change Admin PIN:
Edit `app.js` line:
```javascript
const SUPER_ADMIN_PIN = '000000'; // Change to your PIN
```

---

## 📊 Dashboard Tabs

### TAB 1: Settings 🏢

**Website Configuration:**

#### 1.1 Website Name
- **Current:** FALLS
- **What it does:** Changes the brand name displayed in header
- **Usage:** Update when rebranding the platform
- **Example:** "FALLS", "QuickBites", "DineNow"

#### 1.2 Website Logo URL
- **Type:** Image URL (JPG, PNG, SVG)
- **Size:** 36x36 pixels recommended
- **What it does:** Logo appears in header & startup screen
- **Example:** 
  ```
  https://yourserver.com/logo.png
  data:image/svg+xml,<svg>...</svg>
  ```

#### 1.3 Background Image URL
- **Type:** High-quality image URL
- **Size:** 1920x1080 minimum
- **What it does:** Waterfall background for entire platform
- **Recommended:** Scenic waterfall image
- **Example:**
  ```
  https://yourserver.com/waterfall.webp
  ```

#### 1.4 Delivery Area Configuration
- **Format:** `latitude,longitude,radius-in-km`
- **Default:** `22.1896,-75.8044,5`
- **What it does:** Defines delivery zone (Krem-Chympe Falls, 5km radius)
- **Examples:**
  ```
  22.1896,-75.8044,5       # Krem-Chympe Falls
  23.1815,79.9864,3         # Jabalpur area
  28.7041,77.1025,8         # Delhi area
  ```

**Data Backup:**

#### 1.5 Backup All Data
- **What it saves:**
  - All restaurants (info, menu, prices, UPI ID)
  - All customers (names, phone, addresses)
  - All orders (history, status, amounts)
  - All images (logo, cover, food items)
  - Admin settings
  - Analytics data

- **Output:** JSON file (`falls-backup-[timestamp].json`)
- **When to use:** Weekly backup, before major updates
- **Download:** Automatic download to computer

#### 1.6 Restore from Backup
- **What it restores:** Complete platform state
- **Upload:** Select previously saved backup file
- **Caution:** Overwrites current data!
- **Best Practice:** Backup before restore, keep multiple copies

**BUTTON FEATURES:**
```html
<button onclick="saveAdminSettings()">Save Settings</button>
<button onclick="backupAllData()">📥 Backup All Data</button>
<button onclick="restoreFromBackup()">📤 Restore from Backup</button>
```

---

### TAB 2: Restaurants 🏪

**Restaurant Management:**

#### 2.1 Restaurant List View
Shows all registered restaurants with:
- Restaurant name & logo
- Owner name
- Location/city
- Phone number
- Registration date
- Active/Inactive status
- Rating
- Total orders
- Monthly revenue

#### 2.2 Quick Actions per Restaurant

**A) PIN/UNPIN**
- **Pinned restaurants:** Show at top of customer list
- **Use case:** Promote featured restaurants
- **Benefit:** Increased visibility & orders

**B) PREMIUM BADGE**
- **Effect:** Shows ⭐ Premium badge on card
- **Use case:** Featured/partner restaurants
- **Benefit:** Better positioning in search results

**C) HIGHLIGHT RESTAURANT**
- **Effect:** Shows gradient highlight badge
- **Visual:** Orange-red gradient
- **Use case:** New or promoted restaurants

**D) SUSPEND/DEACTIVATE**
- **Effect:** Hidden from customers
- **Use case:** Health violations, non-compliance
- **Status:** Can be reactivated anytime
- **Notification:** Restaurant owner gets Telegram alert

**E) ASSIGN PIN CODES**
- **Staff PIN:** 6-digit code for daily staff access
- **UPIN:** Unique payment ID (for accounting)
- **Regenerate:** Anytime, old PIN expires immediately
- **Distribution:** Send via Telegram to restaurant owner

#### 2.3 Restaurant Details Modal

**View Complete Information:**
- Logo & cover image
- UPI ID for payments
- Opening hours
- Cuisine types
- Address
- Contact person
- Menu count
- Items count
- Commission rate
- Payment method

**Edit Capabilities:**
- Update UPI ID
- Change opening hours
- Update address
- Add/remove cuisines
- Change commission percentage
- Upload new logo/cover

**Actions:**
- View menu items
- View recent orders
- Check payment history
- View customer reviews
- Download restaurant backup

---

### TAB 3: Analytics 📊

**Real-Time Metrics:**

#### 3.1 Total Orders
- **Shows:** Cumulative order count
- **Updates:** Real-time as orders placed
- **Useful for:** Track platform activity
- **Target:** Monitor growth trends

#### 3.2 Total Revenue
- **Shows:** Total amount collected
- **Currency:** Indian Rupees (₹)
- **Breakdown:** 
  - Restaurant commission
  - Platform fee
  - Transaction fees
- **Period:** All-time (set date range for custom view)

#### 3.3 Active Restaurants
- **Shows:** Number of operational restaurants
- **Status:** Online & accepting orders
- **Excluded:** Suspended or closed
- **Growth:** Track new restaurant additions

#### 3.4 Total Customers
- **Shows:** Registered customer count
- **Active:** Made at least 1 order
- **Inactive:** Registered but never ordered
- **Value:** Measure customer base growth

**Advanced Analytics (Suggested Future Feature):**
```
- Daily revenue trend (graph)
- Top 10 restaurants by orders
- Top 10 restaurants by revenue
- Peak order hours
- Average order value
- Customer retention rate
- Payment success rate
- Refund rate
- Top cuisines by orders
```

---

### TAB 4: Customers 👥

**Customer Management:**

#### 4.1 Customer List
**Information Shown:**
- Full name
- Phone number
- Email (if provided)
- Total orders
- Total spent
- Last order date
- Account status
- Loyalty points (if enabled)

#### 4.2 Customer Actions

**A) VIEW PROFILE**
- Complete customer details
- Full order history
- Favorite restaurants
- Saved addresses
- Ratings given

**B) VIEW ORDERS**
- All past orders
- Order codes & status
- Amounts paid
- Delivery addresses
- Order date & time

**C) SEND MESSAGE**
- WhatsApp message
- Promotional offers
- Order updates
- Support messages

**D) ISSUE REFUND**
- Refund order amount
- Add refund reason
- Generate refund request
- Track refund status

**E) BLOCK/UNBLOCK**
- Prevent account from ordering
- Cancel active orders
- Reason: Fraud, abuse, etc.
- Can be unblocked anytime

#### 4.3 Analytics by Customer Segment
**Suggested Features:**
- High-value customers (top spenders)
- Frequent customers (weekly orders)
- At-risk customers (haven't ordered in 30 days)
- New customers (registered < 7 days)
- Loyal customers (10+ orders)

---

### TAB 5: Complaints ⚠️

**Complaint Management System:**

#### 5.1 Complaint Types

**A) QUALITY ISSUES**
- Poor food quality
- Cold/expired food
- Wrong items delivered
- Missing items

**B) DELIVERY ISSUES**
- Late delivery
- Wrong location
- Damaged packaging
- Rude delivery person

**C) PAYMENT ISSUES**
- Double charged
- Payment failed
- Wrong amount debited
- UPI not working

**D) RESTAURANT ISSUES**
- Unfriendly staff
- Hygiene concerns
- Health violations
- License expired

#### 5.2 Complaint Status Flow

```
NEW 🔴
  ↓
ACKNOWLEDGED 🟡 (Admin confirms receipt)
  ↓
INVESTIGATING 🟠 (Admin reviews details)
  ↓
RESOLVED ✅ (Issue fixed + compensation offered)
  ↓
CLOSED 🔵 (Customer satisfied, ticket archived)
```

#### 5.3 Actions per Complaint

**ESCALATE:**
- Mark as high priority
- Assign to senior admin
- Set urgency flag
- Send SMS alert

**INVESTIGATE:**
- View order details
- Check restaurant info
- Review customer history
- Look for patterns

**RESOLVE:**
- Offer refund
- Issue coupon/discount
- Ban restaurant (if needed)
- Compensate customer

**COMMUNICATE:**
- Send WhatsApp update
- Share resolution
- Get customer feedback
- Close ticket

#### 5.4 Complaint Analytics

**Suggested Metrics:**
- Complaints per restaurant
- Common complaint types
- Average resolution time
- Customer satisfaction rate
- Repeat complaint customers

---

## 🎛️ Advanced Admin Features (Suggested)

### Feature 1: Commission Management
```
Configuration:
- Default commission rate: 20%
- Restaurant-wise override
- Tiered commission (by revenue)
- Special rates for premium restaurants

Display:
- Commission earnings
- Payout calculations
- Tax deductions
- Bank transfer tracking
```

### Feature 2: Promotional Campaigns
```
Create Promotions:
- Discount coupons (10%, 15%, 20%)
- BOGO offers (Buy One Get One)
- Free delivery over ₹300
- Flash sales (2-hour deals)
- Seasonal offers

Target:
- All users
- Specific restaurant
- Specific cuisine
- User segment (new/repeat/vip)

Analytics:
- Coupon redemption rate
- Revenue impact
- Customer acquisition cost
```

### Feature 3: SMS/Email Notifications
```
Automated Messages:
- Order confirmation
- Delivery status updates
- Restaurant alerts
- Payment reminders
- Support responses

Bulk Messaging:
- Send to all users
- Send to segment
- Scheduled delivery
- A/B testing
```

### Feature 4: Fraud Detection
```
Monitor:
- Multiple orders from same IP
- Same card for different accounts
- Unusual order patterns
- High refund rate customers
- Suspicious UPI accounts

Action:
- Flag suspicious orders
- Manual review
- Block account
- Refund fraudulent orders
```

### Feature 5: Staff Management
```
Admin Roles:
- Super Admin (all access)
- Manager (restaurants + analytics)
- Support (complaints only)
- Finance (payments + payouts)

Permissions:
- View restaurants
- Edit settings
- Process refunds
- View analytics
- Manage complaints
```

---

## 📋 Daily Admin Checklist

### Morning (9 AM)
- [ ] Check overnight orders & complaints
- [ ] Review payment processing
- [ ] Check restaurant uptime
- [ ] Read customer complaints
- [ ] Review new registrations

### Midday (1 PM)
- [ ] Monitor peak orders
- [ ] Address urgent complaints
- [ ] Update restaurant statuses
- [ ] Review analytics trends
- [ ] Process refunds

### Evening (5 PM)
- [ ] Check for delivery issues
- [ ] Review restaurant ratings
- [ ] Prepare backup
- [ ] Plan next day actions
- [ ] Send summary report

### Weekly (Every Friday)
- [ ] Full data backup
- [ ] Revenue report
- [ ] Top performers analysis
- [ ] Customer feedback summary
- [ ] Planned maintenance check

### Monthly (Last day)
- [ ] Generate financial report
- [ ] Calculate payouts
- [ ] Review year-to-date metrics
- [ ] Plan promotions
- [ ] Forecast next month

---

## 🔒 Security Best Practices

### 1. PIN Management
- Change default PIN immediately
- Use 6-digit alphanumeric
- Don't share publicly
- Regenerate quarterly
- Log all access attempts

### 2. Backup Strategy
```
Daily Backup:
- Automatic @ 2 AM
- Store locally
- Store on cloud

Weekly Backup:
- Manual comprehensive backup
- Keep for 3 months
- Test restore monthly
```

### 3. Data Protection
- HTTPS only access
- SSL certificate valid
- Encrypt sensitive data
- Use VPN for admin access
- Log all admin actions

### 4. Access Control
- One admin account
- Strong password (20+ chars)
- Two-factor authentication
- IP whitelist
- Session timeout (30 min)

---

## 🚨 Troubleshooting

### Problem: Can't access admin dashboard
**Solutions:**
- Verify PIN is correct
- Check browser console for errors
- Clear cache & cookies
- Try different browser
- Check if admin feature enabled

### Problem: Backup failed
**Solutions:**
- Check internet connection
- Verify backend is running
- Check server storage space
- Try smaller backup first
- Check browser console logs

### Problem: Settings not saving
**Solutions:**
- Verify all fields filled
- Check for invalid URLs
- Wait for save confirmation
- Refresh page
- Check backend logs

### Problem: Analytics showing wrong numbers
**Solutions:**
- Wait 5 minutes for update
- Check date range
- Verify all orders synced
- Clear cache
- Contact backend support

---

## 📱 Mobile Admin Access

**Recommended:** Use tablet or desktop for admin dashboard

**On Mobile:**
- Use browser zoom (80%)
- Portrait mode recommended
- Slow network? Disable images
- Use data connection (not WiFi)
- Clear cache before accessing

---

## 🎯 KPIs to Monitor

### Business Metrics
- **GMV** (Gross Merchandise Value): Total orders revenue
- **TAO** (Total Active Orders): Orders in last 30 days
- **AVO** (Average Value Order): Total revenue ÷ Total orders
- **CS** (Customer Satisfaction): % positive ratings
- **DSR** (Delivery Service Rating): On-time delivery %

### Restaurant Metrics
- **OPH** (Orders Per Hour): Monitor peak times
- **ART** (Average Response Time): Order acceptance speed
- **CCRF** (Customer Complaint Resolution Rate): Quick fixes
- **DCC** (Delivery Consistency): Reliability rating

### Financial Metrics
- **Commission Earned**: 20% × restaurant revenue
- **Platform Fee**: Additional percentage
- **Net Revenue**: Total minus refunds
- **Churn Rate**: Restaurants leaving platform

---

## 📞 Quick Reference

### Common Tasks

**Task:** Feature a restaurant
```
1. Go to Restaurants tab
2. Find restaurant
3. Click "Premium" badge
4. Click "Pin" option
5. Save
```

**Task:** Refund a customer
```
1. Go to Complaints tab
2. Find complaint
3. Click "Resolve"
4. Select "Issue Refund"
5. Enter amount
6. Send confirmation message
```

**Task:** Update website branding
```
1. Go to Settings tab
2. Enter new website name
3. Upload new logo
4. Upload new background
5. Click "Save Settings"
```

**Task:** Create backup
```
1. Go to Settings tab
2. Click "Backup All Data"
3. Wait for download
4. Store safely
5. Verify file saved
```

---

## 📚 Related Documentation

- `FEATURES_GUIDE.md` - All platform features
- `DEPLOYMENT.md` - How to deploy
- `API.md` - Backend API endpoints
- `BACKUP.md` - Backup procedures

---

**Last Updated:** January 2025
**Version:** 2.0
**Status:** Production Ready

For support: admin@falls.local

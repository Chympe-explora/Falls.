# 🔧 FALLS Backend Implementation Guide

## Database Schema Updates

### 1. Restaurants Table Enhancement

```sql
ALTER TABLE restaurants ADD COLUMN (
  -- Status & Features
  active BOOLEAN DEFAULT true,
  pinned BOOLEAN DEFAULT false,
  premium BOOLEAN DEFAULT false,
  verified BOOLEAN DEFAULT false,
  
  -- Payment & UPI
  upiId VARCHAR(100),
  upiQrUrl LONGTEXT,
  bankAccountHolderName VARCHAR(100),
  bankAccountNumber VARCHAR(20),
  ifscCode VARCHAR(11),
  
  -- Images
  coverImage LONGTEXT,
  logo LONGTEXT,
  
  -- Stats & Rating
  rating DECIMAL(3,2) DEFAULT 4.0,
  ratingCount INT DEFAULT 0,
  totalOrders INT DEFAULT 0,
  totalRevenue INT DEFAULT 0,
  
  -- Commission
  commissionRate DECIMAL(5,2) DEFAULT 20.00,
  
  -- Delivery
  deliveryFee INT DEFAULT 0,
  minOrderValue INT DEFAULT 100,
  
  -- Admin Codes
  staffPin VARCHAR(6),
  upin VARCHAR(10),
  staffPinGeneratedAt TIMESTAMP,
  
  -- Backup
  backupData LONGTEXT,
  
  -- Metadata
  lastActiveAt TIMESTAMP,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX idx_active ON restaurants(active);
CREATE INDEX idx_pinned ON restaurants(pinned);
CREATE INDEX idx_premium ON restaurants(premium);
CREATE INDEX idx_rating ON restaurants(rating DESC);
```

### 2. New Delivery Zones Table

```sql
CREATE TABLE delivery_zones (
  id VARCHAR(36) PRIMARY KEY DEFAULT UUID(),
  restaurantId VARCHAR(36) NOT NULL,
  zoneName VARCHAR(100),
  
  -- Location
  latitude DECIMAL(10,8),
  longitude DECIMAL(11,8),
  radiusKm INT,
  
  -- Delivery
  deliveryFee INT,
  minOrderValue INT,
  estimatedDeliveryMinutes INT,
  enabled BOOLEAN DEFAULT true,
  
  -- Metadata
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  FOREIGN KEY (restaurantId) REFERENCES restaurants(id),
  INDEX idx_restaurant (restaurantId),
  INDEX idx_location (latitude, longitude)
);
```

### 3. Enhanced Orders Table

```sql
ALTER TABLE orders ADD COLUMN (
  -- Idempotency & Duplicates
  idempotencyKey VARCHAR(256) UNIQUE,
  
  -- Delivery
  deliveryMethod ENUM('delivery', 'pickup') DEFAULT 'delivery',
  deliveryAddress LONGTEXT,
  deliveryLatitude DECIMAL(10,8),
  deliveryLongitude DECIMAL(11,8),
  deliveryFee INT DEFAULT 0,
  estimatedDeliveryTime INT,
  
  -- Payment
  upiId VARCHAR(100),
  paymentStatus ENUM('pending', 'verified', 'failed', 'refunded') DEFAULT 'pending',
  receiptUrl LONGTEXT,
  receiptVerifiedAt TIMESTAMP NULL,
  
  -- Refund
  refundAmount INT DEFAULT 0,
  refundReason VARCHAR(255),
  refundProcessedAt TIMESTAMP NULL,
  
  -- Timestamps
  acceptedAt TIMESTAMP NULL,
  completedAt TIMESTAMP NULL,
  
  INDEX idx_idempotency (idempotencyKey),
  INDEX idx_payment_status (paymentStatus),
  INDEX idx_delivery_method (deliveryMethod)
);
```

### 4. Complaints Table

```sql
CREATE TABLE complaints (
  id VARCHAR(36) PRIMARY KEY DEFAULT UUID(),
  orderId VARCHAR(36),
  customerId VARCHAR(36),
  restaurantId VARCHAR(36),
  
  -- Issue
  complaintType ENUM(
    'quality', 'delivery', 'payment', 'restaurant', 
    'staff', 'hygiene', 'other'
  ),
  title VARCHAR(255),
  description LONGTEXT,
  
  -- Status
  status ENUM('new', 'acknowledged', 'investigating', 'resolved', 'closed') DEFAULT 'new',
  priority ENUM('low', 'medium', 'high', 'critical') DEFAULT 'medium',
  
  -- Resolution
  resolutionNotes LONGTEXT,
  compensationOffered INT,
  compensationType ENUM('refund', 'coupon', 'both') DEFAULT 'refund',
  
  -- Metadata
  attachmentUrls JSON,
  assignedToAdmin VARCHAR(36),
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  closedAt TIMESTAMP NULL,
  
  FOREIGN KEY (orderId) REFERENCES orders(id),
  FOREIGN KEY (customerId) REFERENCES customers(id),
  FOREIGN KEY (restaurantId) REFERENCES restaurants(id),
  INDEX idx_status (status),
  INDEX idx_priority (priority),
  INDEX idx_type (complaintType)
);
```

### 5. Admin Settings Table

```sql
CREATE TABLE admin_settings (
  id INT PRIMARY KEY DEFAULT 1,
  
  -- Branding
  websiteName VARCHAR(100) DEFAULT 'FALLS',
  logoUrl LONGTEXT,
  backgroundImageUrl LONGTEXT,
  primaryColor VARCHAR(7) DEFAULT '#0f172a',
  secondaryColor VARCHAR(7) DEFAULT '#ff7a45',
  
  -- Delivery
  defaultDeliveryAreaLat DECIMAL(10,8),
  defaultDeliveryAreaLng DECIMAL(11,8),
  defaultDeliveryRadiusKm INT DEFAULT 5,
  
  -- Commission
  defaultCommissionRate DECIMAL(5,2) DEFAULT 20.00,
  platformFeePercentage DECIMAL(5,2) DEFAULT 5.00,
  
  -- Features
  allowCashOnDelivery BOOLEAN DEFAULT true,
  allowUpiPayment BOOLEAN DEFAULT true,
  requireRestaurantVerification BOOLEAN DEFAULT true,
  
  -- Contact
  supportWhatsAppNumber VARCHAR(20),
  supportEmailAddress VARCHAR(100),
  supportTelegramHandle VARCHAR(100),
  
  -- Metadata
  updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updatedByAdminId VARCHAR(36)
);

-- Insert default row
INSERT INTO admin_settings (id) VALUES (1);
```

### 6. Backup History Table

```sql
CREATE TABLE backup_history (
  id VARCHAR(36) PRIMARY KEY DEFAULT UUID(),
  backupType ENUM('full', 'restaurant', 'orders', 'customers') DEFAULT 'full',
  restaurantId VARCHAR(36) NULL,
  
  -- Backup Info
  backupUrl LONGTEXT,
  fileSize INT,
  dataCount INT,
  
  -- Metadata
  createdByAdminId VARCHAR(36),
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  restoreAttempts INT DEFAULT 0,
  lastRestoredAt TIMESTAMP NULL,
  
  FOREIGN KEY (restaurantId) REFERENCES restaurants(id),
  INDEX idx_type (backupType),
  INDEX idx_restaurant (restaurantId)
);
```

---

## Required API Endpoints

### Admin Settings APIs

#### 1. Get Settings
```
GET /api/admin/settings

Response:
{
  "websiteName": "FALLS",
  "logoUrl": "https://...",
  "backgroundImageUrl": "https://...",
  "deliveryArea": {
    "latitude": 22.1896,
    "longitude": -75.8044,
    "radiusKm": 5
  },
  "commissionRate": 20.00,
  "supportContact": {...}
}
```

#### 2. Update Settings
```
POST /api/admin/settings

Headers:
- Authorization: Bearer {ADMIN_TOKEN}
- Content-Type: application/json

Body:
{
  "websiteName": "FALLS Premium",
  "logoUrl": "https://new-logo.png",
  "backgroundImageUrl": "https://new-bg.jpg",
  "deliveryArea": {
    "latitude": 22.1896,
    "longitude": -75.8044,
    "radiusKm": 8
  }
}

Response:
{
  "success": true,
  "message": "Settings updated successfully",
  "settings": {...}
}
```

---

### Restaurant Management APIs

#### 1. List All Restaurants
```
GET /api/admin/restaurants?page=1&limit=20&status=active

Response:
{
  "restaurants": [
    {
      "id": "rest-123",
      "name": "Pizza Paradise",
      "owner": "John Doe",
      "active": true,
      "pinned": true,
      "premium": false,
      "rating": 4.8,
      "totalOrders": 150,
      "totalRevenue": 45000,
      "upiId": "pizza@upi"
    }
  ],
  "total": 150,
  "page": 1,
  "pages": 8
}
```

#### 2. Get Restaurant Details
```
GET /api/admin/restaurants/:id

Response:
{
  "id": "rest-123",
  "name": "Pizza Paradise",
  "owner": "John Doe",
  "phone": "9876543210",
  "email": "john@pizza.com",
  "address": "123 Main St",
  "cuisine": "Italian",
  "hours": "10:00-22:00",
  "upiId": "pizza@upi",
  "upiQrUrl": "https://...",
  "logo": "https://...",
  "coverImage": "https://...",
  "rating": 4.8,
  "ratingCount": 250,
  "totalOrders": 150,
  "commissionRate": 20.0,
  "staffPin": "123456",
  "upin": "PIZZA001",
  "active": true,
  "pinned": true,
  "premium": false
}
```

#### 3. Update Restaurant
```
POST /api/admin/restaurants/:id

Headers:
- Authorization: Bearer {ADMIN_TOKEN}

Body:
{
  "upiId": "newepi@bank",
  "commissionRate": 25.0,
  "hours": "11:00-23:00"
}

Response:
{
  "success": true,
  "restaurant": {...}
}
```

#### 4. Pin/Unpin Restaurant
```
POST /api/admin/restaurants/:id/pin

Headers:
- Authorization: Bearer {ADMIN_TOKEN}

Body:
{
  "pinned": true
}

Response:
{
  "success": true,
  "message": "Restaurant pinned successfully"
}
```

#### 5. Mark as Premium
```
POST /api/admin/restaurants/:id/premium

Headers:
- Authorization: Bearer {ADMIN_TOKEN}

Body:
{
  "premium": true
}

Response:
{
  "success": true,
  "message": "Restaurant marked as premium"
}
```

#### 6. Suspend/Activate Restaurant
```
POST /api/admin/restaurants/:id/status

Headers:
- Authorization: Bearer {ADMIN_TOKEN}

Body:
{
  "active": false,
  "reason": "Health violations"
}

Response:
{
  "success": true,
  "message": "Restaurant suspended",
  "telegramNotificationSent": true
}
```

#### 7. Generate Staff PIN
```
POST /api/admin/restaurants/:id/generate-staff-pin

Headers:
- Authorization: Bearer {ADMIN_TOKEN}

Response:
{
  "success": true,
  "staffPin": "A7K9M2",
  "message": "New PIN generated (old PIN expired)"
}
```

#### 8. Assign UPIN
```
POST /api/admin/restaurants/:id/assign-upin

Headers:
- Authorization: Bearer {ADMIN_TOKEN}

Body:
{
  "upin": "PIZZA001"
}

Response:
{
  "success": true,
  "upin": "PIZZA001"
}
```

---

### Order Management APIs

#### 1. Create Order (with Idempotency)
```
POST /api/orders

Headers:
- Content-Type: application/json
- Idempotency-Key: {idempotencyKey}

Body:
{
  "restaurantId": "rest-123",
  "customerId": "cust-456",
  "items": [
    {"itemId": "item-1", "qty": 2, "price": 250}
  ],
  "customer": {
    "name": "Aarav Sharma",
    "phone": "9876543210",
    "address": "123 Main St"
  },
  "deliveryMethod": "delivery",
  "total": 500
}

Response:
{
  "success": true,
  "orderCode": "FOOD-20250108-0001",
  "idempotencyKey": "base64key",
  "status": "SUBMITTED"
}

Error (Duplicate):
{
  "status": 409,
  "error": "Order already placed",
  "orderCode": "FOOD-20250108-0001"
}
```

#### 2. Get Order Details
```
GET /api/orders/:code

Response:
{
  "code": "FOOD-20250108-0001",
  "restaurantId": "rest-123",
  "restaurantName": "Pizza Paradise",
  "customerId": "cust-456",
  "customerName": "Aarav Sharma",
  "items": [...],
  "total": 500,
  "deliveryFee": 40,
  "status": "ACCEPTED",
  "upiId": "pizza@upi",
  "paymentStatus": "verified",
  "estimatedDeliveryTime": 25,
  "createdAt": "2025-01-08T10:30:00Z"
}
```

#### 3. Update Order Status
```
POST /api/orders/:code/status

Headers:
- Authorization: Bearer {ADMIN_TOKEN}

Body:
{
  "status": "PREPARING"
}

Response:
{
  "success": true,
  "status": "PREPARING"
}
```

#### 4. Cancel Order & Issue Refund
```
POST /api/orders/:code/refund

Headers:
- Authorization: Bearer {ADMIN_TOKEN}

Body:
{
  "reason": "Restaurant unable to prepare",
  "amount": 500
}

Response:
{
  "success": true,
  "refundId": "ref-789",
  "amount": 500,
  "status": "processing"
}
```

---

### Analytics APIs

#### 1. Platform Analytics
```
GET /api/admin/analytics?period=today|week|month|year

Response:
{
  "period": "today",
  "totalOrders": 145,
  "totalRevenue": 58000,
  "averageOrderValue": 400,
  "activeRestaurants": 12,
  "activeCustomers": 340,
  "paymentSuccess": 98.5,
  "deliveryOnTime": 92.3,
  "customerSatisfaction": 4.6
}
```

#### 2. Restaurant Analytics
```
GET /api/admin/restaurants/:id/analytics?period=week

Response:
{
  "restaurantId": "rest-123",
  "period": "week",
  "ordersThisWeek": 45,
  "revenueThisWeek": 18000,
  "averageOrderValue": 400,
  "topItems": [
    {"name": "Margherita", "orders": 20}
  ],
  "peakHours": "12:00-14:00, 18:00-21:00",
  "customerSatisfaction": 4.7,
  "refundRate": 2.1
}
```

#### 3. Live Orders Dashboard
```
GET /api/admin/orders/live

Response:
{
  "totalLive": 8,
  "orders": [
    {
      "code": "FOOD-20250108-0001",
      "restaurant": "Pizza Paradise",
      "customer": "Aarav Sharma",
      "status": "PREPARING",
      "minutesAgo": 5,
      "estimatedCompletion": "18:45"
    }
  ]
}
```

---

### Backup APIs

#### 1. Create Full Backup
```
POST /api/admin/backup/all

Headers:
- Authorization: Bearer {ADMIN_TOKEN}

Response:
{
  "success": true,
  "backupId": "backup-123",
  "fileUrl": "https://backup-storage.com/...",
  "fileSize": 2500000,
  "dataCount": 1500,
  "createdAt": "2025-01-08T11:00:00Z"
}
```

#### 2. Download Backup
```
GET /api/admin/backup/:backupId/download

Response: (Binary file - JSON)
{
  "backup_date": "2025-01-08",
  "restaurants": [...],
  "orders": [...],
  "customers": [...],
  "images": {...}
}
```

#### 3. Restore from Backup
```
POST /api/admin/backup/restore

Headers:
- Authorization: Bearer {ADMIN_TOKEN}
- Content-Type: multipart/form-data

Form Data:
- file: backup.json

Response:
{
  "success": true,
  "restaurantsRestored": 25,
  "ordersRestored": 1500,
  "customersRestored": 340,
  "message": "Backup restored successfully"
}
```

---

### Restaurant Backup APIs

#### 1. Download Restaurant Backup
```
POST /api/restaurants/:id/backup/download

Headers:
- Content-Type: application/json

Body:
{
  "password": "restaurant_password"
}

Response: (Binary file - JSON)
{
  "restaurantId": "rest-123",
  "name": "Pizza Paradise",
  "menu": [...],
  "images": {...},
  "upiId": "pizza@upi",
  "backupDate": "2025-01-08"
}
```

#### 2. Upload Restaurant Backup
```
POST /api/restaurants/:id/backup/upload

Headers:
- Content-Type: multipart/form-data

Form Data:
- file: restaurant-backup.json
- password: restaurant_password

Response:
{
  "success": true,
  "restaurantId": "rest-123",
  "itemsRestored": 45,
  "imagesRestored": 20,
  "message": "Restaurant backup restored"
}
```

---

### Complaint Management APIs

#### 1. Create Complaint
```
POST /api/complaints

Headers:
- Content-Type: application/json

Body:
{
  "orderId": "order-123",
  "customerId": "cust-456",
  "complaintType": "quality",
  "title": "Cold pizza received",
  "description": "Pizza was cold when delivered"
}

Response:
{
  "success": true,
  "complaintId": "complaint-789",
  "status": "new",
  "createdAt": "2025-01-08T12:00:00Z"
}
```

#### 2. List Complaints
```
GET /api/admin/complaints?status=new&priority=high&limit=20

Response:
{
  "complaints": [
    {
      "id": "complaint-789",
      "orderId": "order-123",
      "customerId": "cust-456",
      "restaurantName": "Pizza Paradise",
      "type": "quality",
      "status": "new",
      "priority": "high",
      "createdAt": "2025-01-08T12:00:00Z"
    }
  ],
  "total": 15,
  "newCount": 8
}
```

#### 3. Update Complaint Status
```
POST /api/admin/complaints/:id/status

Headers:
- Authorization: Bearer {ADMIN_TOKEN}

Body:
{
  "status": "investigating",
  "priority": "high",
  "notes": "Checking with restaurant"
}

Response:
{
  "success": true,
  "complaint": {...}
}
```

#### 4. Resolve Complaint
```
POST /api/admin/complaints/:id/resolve

Headers:
- Authorization: Bearer {ADMIN_TOKEN}

Body:
{
  "compensationType": "refund",
  "compensationAmount": 300,
  "resolutionNotes": "Full refund issued for cold pizza"
}

Response:
{
  "success": true,
  "refundId": "ref-xyz",
  "status": "resolved"
}
```

---

### Search APIs

#### 1. Search Restaurants
```
GET /api/restaurants/search?q=pizza&cuisine=italian&minRating=4.0&limit=10

Response:
{
  "results": [
    {
      "id": "rest-123",
      "name": "Pizza Paradise",
      "cuisine": "Italian",
      "rating": 4.8,
      "distance": 2.3,
      "logo": "https://..."
    }
  ],
  "total": 5
}
```

#### 2. Search Food Items
```
GET /api/food/search?q=margherita&restaurantId=rest-123

Response:
{
  "results": [
    {
      "itemId": "item-1",
      "name": "Margherita Pizza",
      "restaurantName": "Pizza Paradise",
      "price": 250,
      "image": "https://...",
      "rating": 4.7
    }
  ]
}
```

---

## Implementation Checklist

### Phase 1: Database (Week 1)
- [ ] Create new tables
- [ ] Add columns to existing tables
- [ ] Create indexes
- [ ] Write migration scripts
- [ ] Test backup/restore

### Phase 2: API Endpoints (Week 2-3)
- [ ] Admin settings APIs
- [ ] Restaurant management APIs
- [ ] Order APIs with idempotency
- [ ] Analytics APIs
- [ ] Backup APIs
- [ ] Complaint APIs
- [ ] Search APIs
- [ ] Test all endpoints

### Phase 3: Integration (Week 4)
- [ ] Connect frontend to new APIs
- [ ] Test full flow
- [ ] Performance testing
- [ ] Security testing
- [ ] Load testing

### Phase 4: Deployment (Week 5)
- [ ] Deploy to Render
- [ ] Update GitHub Pages
- [ ] Database migration
- [ ] Monitor logs
- [ ] Customer training

---

## Error Handling

### Standard Error Response
```json
{
  "success": false,
  "error": "Error message",
  "code": "ERROR_CODE",
  "details": {}
}
```

### HTTP Status Codes
- 200: Success
- 400: Bad request
- 401: Unauthorized
- 403: Forbidden
- 404: Not found
- 409: Conflict (duplicate order)
- 500: Server error
- 503: Service unavailable

---

## Rate Limiting

```javascript
// Admin endpoints: 100 requests/minute
// User endpoints: 30 requests/minute
// Search: 10 requests/minute
// Upload: 5 requests/minute
```

---

## Security Headers

```javascript
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb' }));
```

---

**Last Updated:** January 2025
**Version:** 2.0
**Status:** Ready for Implementation

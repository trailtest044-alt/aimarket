# AI Digital Product Marketplace - Secure Backend Starter

This is a secure backend starter for a manual-payment digital product marketplace.

It supports:

- Public product listing
- Bangladesh / Pakistan / Binance manual payment methods
- Transaction ID based order submission
- Admin login
- Product management
- Payment method management
- Encrypted account/instruction stock
- Admin order approval/rejection
- Delivery only after approval using order ID + private access token

## Recommended flow

1. Build the frontend/admin UI in Lovable using mock data first.
2. Export/sync Lovable project to GitHub.
3. Connect frontend API calls to this backend.
4. Deploy this backend on Render.
5. Use MongoDB Atlas for database.

## Security choices in this starter

- Admin passwords are hashed with bcryptjs cost 12.
- Product delivery secrets are encrypted with AES-256-GCM.
- MongoDB URI, JWT secret, and encryption key stay in environment variables.
- Public delivery requires both `orderId` and a private random access token.
- Stock assignment is atomic, so one account should not be sold twice.
- Products are deactivated instead of hard-deleted to protect old order history.
- Basic rate limits are enabled for public API, order submit, and admin login.
- Helmet is enabled for safer HTTP headers.

## Setup locally

```bash
npm install
cp .env.example .env
```

Generate encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Paste the value into `ENCRYPTION_KEY_BASE64` in `.env`.

Start dev server:

```bash
npm run dev
```

Create admin:

```bash
npm run create-admin -- admin@example.com StrongPassword123 "Owner"
```

## Main API routes

### Public

- `GET /api/health`
- `GET /api/products`
- `GET /api/products/:slug`
- `GET /api/payment-methods`
- `POST /api/orders`
- `GET /api/orders/:orderId/status?token=ACCESS_TOKEN`
- `GET /api/orders/:orderId/delivery?token=ACCESS_TOKEN`

### Admin

- `POST /api/admin/auth/login`
- `GET /api/admin/dashboard`
- `GET /api/admin/products`
- `POST /api/admin/products`
- `PATCH /api/admin/products/:id`
- `DELETE /api/admin/products/:id`
- `GET /api/admin/payment-methods`
- `PUT /api/admin/payment-methods/:key`
- `GET /api/admin/stock`
- `POST /api/admin/stock`
- `GET /api/admin/stock/:id/reveal`
- `PATCH /api/admin/stock/:id/disable`
- `GET /api/admin/orders?status=pending`
- `POST /api/admin/orders/:orderId/approve`
- `POST /api/admin/orders/:orderId/reject`

Admin routes require:

```http
Authorization: Bearer ADMIN_JWT_TOKEN
```

## Render deploy notes

Use these environment variables in Render:

- `NODE_ENV=production`
- `PORT=10000` or let Render provide it
- `FRONTEND_URL=https://your-frontend-url`
- `MONGODB_URI=your MongoDB Atlas connection string`
- `JWT_SECRET=long random secret`
- `ENCRYPTION_KEY_BASE64=32-byte base64 key`
- `ADMIN_SEED_SECRET=one-time random secret`

Build command:

```bash
npm install
```

Start command:

```bash
npm start
```

## Important business/legal note

Only sell digital products/accounts that you are allowed to resell. Many third-party services do not allow account/password resale. A safer model is to sell authorized license keys, redeem instructions, or officially permitted access.

# Lovable Frontend Prompt

Use this prompt in Lovable first. It tells Lovable to build the frontend/admin UI without Supabase and prepare it for Render API + MongoDB backend.

```text
Create a premium, secure AI digital product marketplace frontend using React/Vite. Do not use Supabase. Do not create a real database. Use mock data first, but structure the code so it can connect to an external REST API later.

Business model:
- The site sells digital AI products such as Gemini, Ideogram, Recraft and similar tools.
- Customer selects a product and clicks Buy Now.
- Checkout has 3 manual payment choices: Bangladesh, Pakistan, Binance.
- Bangladesh payment page/popup shows bKash and Nagad numbers with text: “Send Money to this number”, amount, transaction ID input, customer name, email, WhatsApp, and submit button.
- Pakistan payment page/popup shows manual payment details, amount, transaction/reference ID input, customer name, email, WhatsApp, and submit button.
- Binance payment page/popup shows Binance Pay ID or wallet address, amount in USDT, transaction ID input, customer name, email, WhatsApp, and submit button.
- After submit, show order pending page with order ID and instruction to wait for admin approval.
- Customer can check order status using order ID and private access token saved in browser localStorage.
- When approved, customer can view delivery instruction/account details.

Pages:
1. Home page with animated premium dark hero, product categories, trust cards, and CTA.
2. Product listing page with search/filter.
3. Product details page with price BDT/PKR/USDT, features, stock badge, and Buy Now.
4. Checkout page with payment method cards.
5. Order submitted page.
6. Order status/delivery page.
7. Admin login page.
8. Admin dashboard with stats cards: pending orders, products, available stock, delivered orders.
9. Admin product management: add/edit/deactivate products.
10. Admin payment method management: Bangladesh/Pakistan/Binance instructions and numbers.
11. Admin stock management: add product account/instruction stock. Fields: product, type credentials/instruction, email, password, instruction, admin note. Do not reveal passwords in table by default.
12. Admin orders page: tabs for pending/approved/rejected/delivered. Pending orders have Approve and Reject buttons.
13. Admin stock reveal modal with warning.

Design:
- Premium dark theme.
- Glassmorphism cards.
- Smooth micro animations.
- Responsive mobile-first layout.
- Clean dashboard sidebar.
- Use clear success/error/loading states.
- Never show delivery data before order approval.

API preparation:
Create a clean API client file with base URL from VITE_API_URL.
Use these endpoints:
Public:
GET /api/products
GET /api/products/:slug
GET /api/payment-methods
POST /api/orders
GET /api/orders/:orderId/status?token=ACCESS_TOKEN
GET /api/orders/:orderId/delivery?token=ACCESS_TOKEN
Admin:
POST /api/admin/auth/login
GET /api/admin/dashboard
GET /api/admin/products
POST /api/admin/products
PATCH /api/admin/products/:id
DELETE /api/admin/products/:id
GET /api/admin/payment-methods
PUT /api/admin/payment-methods/:key
GET /api/admin/stock
POST /api/admin/stock
GET /api/admin/stock/:id/reveal
PATCH /api/admin/stock/:id/disable
GET /api/admin/orders?status=pending
POST /api/admin/orders/:orderId/approve
POST /api/admin/orders/:orderId/reject

Use mock API mode first, but make it easy to switch to real API by changing VITE_USE_MOCK_API=false.
```

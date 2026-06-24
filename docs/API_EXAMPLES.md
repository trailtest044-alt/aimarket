# API Request Examples

## Create order

```bash
curl -X POST http://localhost:5000/api/orders \
  -H "Content-Type: application/json" \
  -d '{
    "productId": "PRODUCT_MONGO_ID",
    "customer": {
      "name": "Test Buyer",
      "email": "buyer@example.com",
      "whatsapp": "+8801XXXXXXXXX"
    },
    "paymentMethod": "bangladesh",
    "transactionId": "TX12345678",
    "paymentNote": "Sent from bKash"
  }'
```

## Admin login

```bash
curl -X POST http://localhost:5000/api/admin/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"StrongPassword123"}'
```

## Add product

```bash
curl -X POST http://localhost:5000/api/admin/products \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Gemini Pro Access",
    "slug": "gemini-pro-access",
    "description": "Digital access delivery after payment approval.",
    "shortDescription": "Gemini premium access",
    "priceBDT": 500,
    "pricePKR": 1200,
    "priceUSDT": 5,
    "features": ["Fast delivery", "Manual approval", "Private support"],
    "isActive": true
  }'
```

## Add Bangladesh payment method

```bash
curl -X PUT http://localhost:5000/api/admin/payment-methods/bangladesh \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Bangladesh Payment",
    "instructions": "Send Money to this number. Then submit transaction ID.",
    "accounts": [
      {"label":"bKash", "value":"01XXXXXXXXX", "note":"Send Money only"},
      {"label":"Nagad", "value":"01XXXXXXXXX", "note":"Send Money only"}
    ],
    "isActive": true
  }'
```

## Add stock

```bash
curl -X POST http://localhost:5000/api/admin/stock \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "productId": "PRODUCT_MONGO_ID",
    "type": "credentials",
    "payload": {
      "email": "account@example.com",
      "password": "secret-password",
      "instruction": "Login and change recovery details after first use."
    },
    "adminNote": "Gemini stock 1"
  }'
```

## Approve order

```bash
curl -X POST http://localhost:5000/api/admin/orders/ORDER_ID/approve \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

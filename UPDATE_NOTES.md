# AIMarket Update Pack

## Added
- Region-based pricing: Bangladesh BDT, Pakistan PKR, Worldwide USDT/USD.
- Backend locks final order price from product pricing and region/payment method.
- No automatic demo products are seeded.
- Owner-only admin management API.
- Admin nickname tracking: added by / approved by / delivered by / rejected by.
- Smart dashboard analytics: sold count, product-wise sales, low stock, recent activity.
- Delivery stock payload supports instruction, video URL, and image URL.

## Existing owner
The setup route uses `ADMIN_SETUP_NAME=shimul` by default. Existing owner can also be updated on login if email is `shahriarshimul044@gmail.com`.

## After deploy
Keep `ALLOW_ADMIN_SEED=false` and remove setup password variables after owner setup.

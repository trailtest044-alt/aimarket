# Build Order

## Phase 1 - Backend first

1. Create MongoDB Atlas database.
2. Deploy this backend to Render.
3. Add environment variables.
4. Create admin user.
5. Add payment methods.
6. Add 1-2 sample products.
7. Add stock for each product.
8. Test order create -> approve -> delivery.

## Phase 2 - Lovable frontend

1. Use `docs/LOVABLE_FRONTEND_PROMPT.md` in Lovable.
2. Keep mock API on until UI looks perfect.
3. Export/sync Lovable project to GitHub.
4. Add `.env` to frontend:

```env
VITE_API_URL=https://your-render-api.onrender.com
VITE_USE_MOCK_API=false
```

5. Connect real API.
6. Deploy frontend.

## Phase 3 - Production hardening

1. Add domain.
2. Add email notification for approved/rejected orders.
3. Add admin 2FA if possible.
4. Add backup/export orders feature.
5. Add audit logs for admin actions.
6. Add payment screenshot upload if needed.
7. Add Binance Pay API later if you get merchant/API access.

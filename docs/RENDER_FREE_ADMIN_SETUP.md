# Render Free Admin Setup

Render Free does not include Shell access, so use this temporary setup route.

## 1. Add temporary environment variables in Render

```env
ALLOW_ADMIN_SEED=true
ADMIN_SETUP_EMAIL=your-admin-email@example.com
ADMIN_SETUP_PASSWORD=your-strong-password-min-10-chars
ADMIN_SETUP_NAME=Owner
```

Deploy the latest commit.

## 2. Open the setup URL once

Open:

```text
https://YOUR-BACKEND.onrender.com/api/setup/create-admin
```

You should see `Admin created successfully`.

## 3. Disable immediately

After admin is created, set:

```env
ALLOW_ADMIN_SEED=false
```

Or delete these variables:

```env
ADMIN_SETUP_EMAIL
ADMIN_SETUP_PASSWORD
ADMIN_SETUP_NAME
```

Then redeploy.

Never leave `ALLOW_ADMIN_SEED=true` after setup.

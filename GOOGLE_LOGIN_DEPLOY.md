# Google login backend deploy notes

Deploy this folder as the backend service.

Required Render environment variables:

```env
NODE_ENV=production
FRONTEND_URL=https://aimarket-go.vercel.app
PUBLIC_API_URL=https://aimarket-u138.onrender.com
GOOGLE_CLIENT_ID=423365889884-ghk6hd3ictq6jqpdbvknd0ddgroe3dqs.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<paste from Google Cloud>
MONGODB_URI=<existing MongoDB URI>
JWT_SECRET=<existing JWT secret>
ENCRYPTION_KEY_BASE64=<existing 32-byte base64 encryption key>
```

Google Console authorized redirect URI:

```text
https://aimarket-u138.onrender.com/api/auth/google/callback
```

Frontend Vercel environment variable:

```env
VITE_API_BASE_URL=https://aimarket-u138.onrender.com/api
```

After deploy, test these URLs:

```text
https://aimarket-u138.onrender.com/api/health
https://aimarket-u138.onrender.com/api/auth/google/start?returnTo=/account
```

The second URL should redirect to Google login, not show `Route not found`.

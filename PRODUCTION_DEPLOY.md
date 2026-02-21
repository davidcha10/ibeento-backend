# Backend + DB Production Setup

## 1) Create MongoDB production (Atlas)
1. Create project and cluster in MongoDB Atlas.
2. Create DB user with read/write on your production DB.
3. In Network Access, allow your backend provider egress IPs (or temporarily `0.0.0.0/0` while testing).
4. Copy the SRV URI and set it as `MONGODB_URI`.

## 2) Deploy backend service
Recommended simple options: Render / Railway / Fly.

Service settings:
- Root directory: `backend`
- Build command: `npm install`
- Start command: `npm start`
- Node version: 20+

Set environment variables from `backend/.env.production.example`.

## 3) Health check
After deploy, verify:
- `GET /health`
- `GET /api/health`

Expected:
```json
{ "ok": true, "service": "backend", "env": "production" }
```

## 4) Ensure indexes (important for dedupe)
Run once against production DB:

```bash
cd backend
MONGODB_URI="mongodb+srv://..." npm run db:sync-indexes
```

This creates/updates critical unique indexes, including:
- Zones: `source + externalId`
- Activities: `externalRef.provider + externalRef.id`

## 5) Connect frontend (Vercel)
In frontend production env, set API URL to your backend domain:
- `environment.prod.ts` -> `apiUrl`
- or equivalent Vercel env var, depending on your build setup.

## 6) First production checks
1. Auth login/register works.
2. Stripe webhook endpoint reachable (`/api/billing/stripe/webhook`).
3. Explore/discover can read/write zones and activities.
4. CORS allows `https://www.ibeento.com`.

## 7) Security checklist before go-live
- Rotate all test/staging secrets.
- Use Stripe live keys in production.
- Do not keep local `.env` committed.
- Restrict Atlas IP access once stable.

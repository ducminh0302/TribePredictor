# TRIBE Web App

Next.js app for upload, job dispatch, and 3D brain activity visualization.

## 1) Local Setup

1. Install dependencies:

```bash
npm install
```

2. Create env file from template:

```bash
cp .env.example .env.local
```

3. Fill `.env.local` with real values:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `MODAL_ENDPOINT_URL`
- `MODAL_SHARED_SECRET`
- `GEMINI_API_KEY`

4. Run local dev:

```bash
npm run dev
```

## 2) Pre-Push Checklist

Run full verification before pushing:

```bash
npm run check:release
```

This runs lint + production build.

Also verify:

- `.env.local` is not committed.
- No real secrets in JSON payload samples.
- Modal endpoint deployed and reachable.

## 3) Push to GitHub

If this folder is not yet a git repository:

```bash
git init
git add .
git commit -m "chore: release-ready webapp"
git branch -M main
git remote add origin <your-github-repo-url>
git push -u origin main
```

If git already exists:

```bash
git add .
git commit -m "chore: release-ready webapp"
git push
```

## 4) Deploy to Vercel

### Option A: Vercel Dashboard

1. Import your GitHub repository.
2. Set Root Directory to `webapp` if this is a monorepo.
3. Add all environment variables from `.env.local` to Vercel Project Settings.
4. Deploy.

### Option B: Vercel CLI

```bash
npm i -g vercel
vercel login
vercel
vercel --prod
```

Then set env vars with dashboard or CLI:

```bash
vercel env add NEXT_PUBLIC_SUPABASE_URL production
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
vercel env add SUPABASE_SERVICE_ROLE_KEY production
vercel env add MODAL_ENDPOINT_URL production
vercel env add MODAL_SHARED_SECRET production
vercel env add GEMINI_API_KEY production
```

## 5) Post-Deploy Smoke Test

1. Open app URL.
2. Sign in.
3. Upload a test input.
4. Confirm job progresses `queued -> processing -> completed`.
5. Confirm 3D viewer renders mesh and visible activity colors.
6. Trigger interpretation and verify assistant response.

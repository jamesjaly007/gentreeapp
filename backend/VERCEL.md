# Deploy the API on Vercel

This folder is an Express app that Vercel runs as one serverless function (`api/index.js` re-exports `src/server.js`).

## 1. New Vercel project

- Import the same Git repo as the frontend.
- **Root Directory:** `backend` (important).
- **Framework Preset:** Other (no Vite/React).
- **Build Command:** leave empty, or `echo "no build"`.
- **Output Directory:** leave empty (not used for serverless-only projects).
- **Install Command:** default `npm install`.

## 2. Environment variables

In the **backend** project on Vercel → Settings → Environment Variables:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_STORAGE_BUCKET` (e.g. `people-photos`)
- `ADMIN_PIN` (optional; first-time pin seeding uses `app_settings`)

Do **not** put the service role key in the frontend project.

## 3. Frontend URL

In the **frontend** Vercel project, set:

- `VITE_API_ORIGIN` = `https://<your-backend-project>.vercel.app`  
  (no trailing slash)

Redeploy the frontend after changing this.

## 4. Smoke test

Open:

`https://<your-backend>.vercel.app/api/health`

You should see `{"healthy":true}`.

## Notes

- Cold starts: first request after idle can take a few seconds.
- Hobby tier has a short function time limit; heavy uploads or slow Supabase calls must stay within it.
- `express.static` for uploads is not used; photos go to Supabase Storage.

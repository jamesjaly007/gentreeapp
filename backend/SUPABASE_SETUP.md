## Supabase Setup (Backend)

1. Create a Supabase project.
2. Open SQL Editor and run `backend/schema.sql`.
3. Open Storage and create bucket `people-photos`.
4. Set bucket to **Public** (or keep private and switch backend to signed URLs later).
5. In backend env (`backend/.env`), set:
   - `SUPABASE_URL=https://<your-project-ref>.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>`
   - `SUPABASE_STORAGE_BUCKET=people-photos`
   - `PORT=4000`
   - `ADMIN_PIN=<optional-initial-pin>`

## Notes

- The backend uses only `SUPABASE_SERVICE_ROLE_KEY` for DB and uploads.
- Do **not** expose service role key in frontend.
- `SUPABASE_ANON_KEY` is optional here (not needed by current backend).

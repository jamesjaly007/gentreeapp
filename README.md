# Genealogy Tree App (React + Node + SQLite)

This app lets contributors submit requests to add, edit, and delete family members and relationships.  
All changes require **admin approval** before they are applied to the genealogy tree.

## Features
- Add, edit, and delete people (as approval requests)
- Add partner links
- Add parent-child links to create recursive branches
- Admin queue to approve or reject pending changes
- SQLite persistence

## Project Structure
- `frontend/` - React + Vite UI
- `backend/` - Express API + SQLite logic

## 1) SQLite Setup
1. Copy env file:
   - Copy `backend/.env.example` to `backend/.env`.
2. Optional:
   - Change `DB_FILE` in `backend/.env` if you want a different DB path.
3. Start backend:
   - Tables and default users are created automatically on startup.

## 2) Run Backend
```bash
cd backend
npm install
npm run dev
```

Backend runs on `http://localhost:4000`.

## 3) Run Frontend
```bash
cd frontend
npm install
npm run dev
```

Frontend runs on `http://localhost:5173`.

## Quick Start for Your Scenario
1. Select a contributor user in UI.
2. Submit "Add Person" requests for the 2 grandparents.
3. Switch to admin user and approve requests.
4. Submit partner and child-link requests to create branches.
5. Keep adding new generations; each person can become a parent and have child branches.

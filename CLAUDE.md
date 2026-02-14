# Lovify

**your music, with love**

Spotify companion app — self-hosted (Spotify dev-mode apps cap at ~5 active users, so each person spins up their own).

## Stack

- React 19 + TypeScript 5.7 + Vite 6
- Spotify Web API (PKCE OAuth)
- Spotify Web Playback SDK
- Supabase (backend/storage)
- Vercel (hosting)

## Setup

```bash
# 1. Clone and install
npm install

# 2. Copy env file and fill in your credentials
cp .env.example .env

# 3. Run dev server
npm run dev
```

## Environment Variables

All credentials live in `.env` (never committed). See `.env.example` for the required variables:

| Variable | Description |
|----------|-------------|
| `VITE_SPOTIFY_CLIENT_ID` | Spotify app client ID |
| `VITE_SPOTIFY_REDIRECT_URI` | OAuth callback URL |
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase public anon key |

## Commands

```bash
npm run dev              # Web dev server on :5173
npm run build            # Production web build
npm run preview          # Preview production build
```

## Vercel

- SPA rewrite: all routes → `index.html` (see `vercel.json`)
- Set the production URL in `VITE_SPOTIFY_REDIRECT_URI` and add the same callback in your Spotify app dashboard

## Spotify App

Dashboard: https://developer.spotify.com/dashboard
- Redirect URI: `<your-deployed-url>/callback` (must match `VITE_SPOTIFY_REDIRECT_URI` exactly)
- Scopes: streaming, user-read-email, user-read-private, user-read-playback-state, user-modify-playback-state, user-top-read, user-library-read, playlist-read-private, playlist-read-collaborative, playlist-modify-public, playlist-modify-private

## Supabase

Tables: `mixtapes`, `mixtape_notes`, `mixtape_tracks`, `library_snapshots`, `snapshot_playlists`, `snapshot_tracks`, `track_versions`, `track_segments`

Edge functions: `save-mixtape`, `snapshot-library`, `restore-snapshot`, `export-snapshot-csv`, `import-snapshot-csv`

## Architecture

```
src/                          # Web app (React/Vite)
  App.tsx                     # Root — auth flow, tab routing
  main.tsx                    # React entry
  index.css                   # Global styles + design system
  spotify/
    auth.ts                   # PKCE OAuth (login, token exchange, refresh)
    api.ts                    # Spotify Web API client
  supabase/
    client.ts                 # Supabase client init
    api.ts                    # Database operations
  player/
    PlayerContext.tsx          # Web Playback SDK wrapper
  pages/
    Statify.tsx               # Top tracks (4wk/6mo/all time columns)
    Lovify.tsx                # Mixtape creation with notes + trim
    Backupify.tsx             # Library snapshots + CSV export/import
  components/
    TrackRow.tsx              # Reusable track list item
    ColorPicker.tsx           # Theme color selector
    NoteEditor.tsx            # Timed annotation editor
    TrimEditor.tsx            # Track section skip editor
  ErrorBoundary.tsx           # Error handling
```

## Features

1. **Stats** — Top tracks across 3 time ranges displayed side-by-side
2. **Mixtapes** — Create playlists with per-track timed love notes, themed colors
3. **Backups** — Snapshot entire library, export/import CSV, restore to any account
4. **Trim Editor** — Mark sections of songs to skip, multiple versions per track
5. **Player** — Web Playback SDK with note overlays during playback

## Design System

- Primary: `#e8457c` (rose)
- Colors: rose, violet (`#9c5bd2`), amber (`#e8a034`), emerald (`#3dba8a`), sky (`#4ca4e8`)
- Fonts: Playfair Display (headings), DM Sans (body)
- Dark theme with glass/blur effects

---

## Current Status (as of 2026-03-25)

### BLOCKER: Spotify Developer App needs to be recreated

The previous Spotify app was deleted and Spotify imposed a **24-hour cooldown** before a new app can be created. When creating the new app:

1. Go to https://developer.spotify.com/dashboard and create a new app
2. **APIs used**: check **Web API** AND **Web Playback SDK** (both required)
3. **Redirect URI**: `<your-deployed-url>/callback`
4. **User Management**: add ALL Spotify accounts that need to use the app (main account + any demo/receiver accounts). The email must match the account's **Spotify email** (check at spotify.com/account)
5. Update `VITE_SPOTIFY_CLIENT_ID` in both `.env` and Vercel env vars, then redeploy

To update Vercel env vars:
```bash
npx vercel env rm VITE_SPOTIFY_CLIENT_ID production --yes
npx vercel env add VITE_SPOTIFY_CLIENT_ID production <<< "NEW_CLIENT_ID_HERE"
npx vercel --prod --yes
```

### Known Issues to Fix

#### 1. Backup Snapshot — WORKING (edge function v10)
- The `snapshot-library` edge function is deployed and functional (same as v2 baseline + retry logic)
- Uses `limit=50` per page, retries on 429 with `Retry-After` header
- ~60+ API calls per snapshot — can hit Spotify rate limits if run repeatedly
- **Rate limit recovery**: Spotify's `Retry-After` header says how many seconds to wait (typically 4s). The function retries up to 3 times.
- **Do NOT** add artificial delays between API calls — they push the function past Supabase's 60-second edge function timeout

#### 2. CSV Import — Playlists created but 0 tracks added
- Playlist creation via Spotify API works (confirmed 3 times)
- Track addition consistently fails — either 403 (permissions) or URIs are empty in CSV
- **Debugging added**: import now logs to browser console showing:
  - Exact column matching results
  - URI count per playlist (valid, empty, invalid)
  - Which step fails (create vs add tracks)
  - Account email/ID being used
- **Next step**: open browser DevTools Console during import to see the breakdown. If URIs are all empty, the snapshot didn't save track URIs. If URIs exist but addTracksToPlaylist returns 403, it's a permissions issue.
- The 403 on the demo account may have been caused by the old app's stale token in localStorage. After creating the new app, the demo user must **sign out, clear browser data for the site, then sign back in** to get a fresh token with all scopes.

#### 3. Mixtape Search — FIXED
- Spotify API changed search `limit` max from 50 to **10** (default 5)
- Code was using `limit=20` which caused "Invalid limit" 400 errors
- Fixed: default limit set to 10, clamped to 1-10

#### 4. Empty Descriptions in snapshot_playlists
- Spotify's `/me/playlists` list endpoint often returns empty `description` fields even for playlists that have descriptions set
- The full description is only reliably available from individual `/v1/playlists/{id}` calls
- The edge function only uses the list response — would need individual playlist fetches to get descriptions
- **Trade-off**: adding individual playlist fetches doubles API calls (~20 more requests), increasing rate limit risk
- **Priority**: low — cosmetic issue only

### Lessons Learned

- **Spotify rate limits**: ~30 requests per 30 seconds. The `Retry-After` header tells you exactly how long to wait. Don't spam retries — each failed attempt extends the penalty window.
- **Edge function timeout**: Supabase free tier = 60 seconds wall clock. Adding delays between API calls can push past this. The v2 baseline (no delays, just retry on 429) completed in 21-31 seconds.
- **Development mode**: Apps in dev mode limit to 25 users. Users must be added via User Management with their exact Spotify account email. Deleted users may still count against the limit temporarily.
- **Token caching**: When switching Spotify apps (new client ID), users MUST sign out and sign back in. Old tokens from the previous app persist in localStorage and will cause 403 errors even though the user appears logged in.
- **Don't stack fixes**: When debugging, avoid deploying multiple changes at once. Each change can mask or introduce new issues. Roll back to the last known working version first.

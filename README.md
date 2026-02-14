# Lovify

**your music, with love**

A Spotify companion for **mixtapes**, **stats**, and **backups**. Self-hosted — Spotify caps dev-mode apps at ~5 active users, so spin up your own instance.

## Features

### Mixtapes
Build playlists that live in Lovify (not Spotify). For each track you can:
- Skip any section (intro, outro, or middle) with draggable regions
- Pin timed notes with inline images, emojis, and a theme color
- Save per-track "versions" and reuse them across mixtapes
- Share a public link, play back in the visualizer with tempo-driven animations

### Stats
Your top tracks across three time ranges (last 4 weeks / 6 months / all time), side-by-side.

### Backups
Snapshot your entire Spotify library — every playlist and every track — into Supabase. Useful for:
- Keeping a personal history of what was in your library
- **Transferring to a new Spotify account**: export a snapshot as CSV from the old account, sign in with the new account, import the CSV, and Lovify will re-create every playlist and add back all the tracks. This is the intended use case if you're migrating from a family-plan member → individual, old account → new email, or anything similar.

## Stack

React 19 · Vite · TypeScript · Spotify Web API & Web Playback SDK · Supabase · Vercel

## Setup

```bash
cp .env.example .env     # fill in Spotify + Supabase credentials
npm install
npm run dev              # localhost:5173
```

Spotify Premium is required for playback; signed-in users must be added under *User Management* in the Spotify developer dashboard while the app is in development mode.

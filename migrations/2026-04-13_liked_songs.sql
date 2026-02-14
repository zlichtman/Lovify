-- Liked Songs backup — add table + count column.
-- Run in Supabase SQL editor. Non-destructive.

begin;

alter table library_snapshots
  add column if not exists liked_count int not null default 0;

create table if not exists snapshot_liked_tracks (
  id                 uuid primary key default gen_random_uuid(),
  snapshot_id        uuid not null references library_snapshots(id) on delete cascade,
  spotify_track_uri  text not null,
  track_name         text,
  artist_name        text,
  album_name         text,
  album_art_url      text,
  duration_ms        int,
  added_at           timestamptz,
  position           int  not null,
  created_at         timestamptz not null default now()
);

create index if not exists idx_snapshot_liked_tracks_snapshot
  on snapshot_liked_tracks(snapshot_id);

commit;

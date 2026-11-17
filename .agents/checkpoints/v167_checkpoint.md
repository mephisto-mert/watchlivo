# Checkpoint: Watchlivo v167 Deployment & State Sync
Date: 2026-11-10T11:07:30+03:00

## Status:
- Version: `20261110_v167` deployed and live on `https://watchlivo.online` (verified with HTTP 200).
- Git remote: `origin/main` commit `0fb55c5`.

## Completed Fixes:
1. **Solo Leveling vs One Piece Backdrop Fix:**
   - Corrected `_CURATED_ACTIVE_SERIES_SEEDS` in `server.py` line 7466 from `4Mt7WHox67uJ1yErwTBFcV8KWgG.jpg` (One Piece) to `xMNH87maNLt9n2bMDYeI6db5VFm.jpg` (Solo Leveling).
2. **Self-Healing Watch History Posters (`store.js`):**
   - Sanitizes `localStorage` on read: replaces One Piece backdrop on Solo Leveling entries with authentic TMDB URLs.
   - Clears `watchlivo-poster.svg` dark navy fallback strings and auto-resolves via `/api/rave/poster`.
3. **Instant Continue Watching & Room Playback (`selection.js`):**
   - Eliminated UI stall: fast 3.5s bounded race for `resolveCatalogItem`.
   - Guaranteed room creation with `/api/rave/resolve-catalog` fallback if not resolved immediately.
4. **Subtitle Offset Sanitization (`subtitles.js`):**
   - Clamped manual subtitle offsets in `_loadMediaSyncPrefs` to `[-5s, 5s]`.
   - Purged legacy poisoned offset values from localStorage.

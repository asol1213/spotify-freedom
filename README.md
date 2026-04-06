# Spotify Freedom

Ditch Spotify. Own your music. Stream it yourself.

This tool migrates your Spotify playlists to a self-hosted music server (Navidrome) that you can access from your phone with apps like Substreamer or Subtracks.

**No Spotify Premium required. No API keys needed. No credentials stored.**

## How it works

1. Takes Spotify playlist/album URLs
2. Extracts track metadata via Spotify's public embed API
3. Downloads songs as 320kbps MP3 via yt-dlp (higher quality than Spotify Free's 160kbps)
4. Creates M3U playlists
5. Serves everything through Navidrome (your own music server)

## Requirements

- Node.js 18+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (`brew install yt-dlp`)
- [ffmpeg](https://ffmpeg.org/) (`brew install ffmpeg`)
- [Docker](https://www.docker.com/) (for Navidrome)

## Setup

```bash
# Install dependencies
npm install

# Start Navidrome
docker compose up -d

# Open http://localhost:4533 and create an account
```

## Usage

### Download playlists

```bash
node export-spotify.js "https://open.spotify.com/playlist/YOUR_PLAYLIST_ID"
```

Multiple playlists at once:

```bash
node export-spotify.js \
  "https://open.spotify.com/playlist/LINK1" \
  "https://open.spotify.com/playlist/LINK2" \
  "https://open.spotify.com/album/ALBUM_LINK"
```

Albums work too.

### Listen on your phone

1. Install **Substreamer** (iOS) or **Subtracks** (Android)
2. Server address: `http://<your-local-ip>:4533`
3. Login with the account you created in Navidrome

Your phone and computer must be on the same WiFi network.

## File structure

```
music/              # All downloaded MP3s + M3U playlists
playlist_*.json     # Playlist metadata (auto-generated, gitignored)
```

import fs from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

const MUSIC_DIR = path.join(process.cwd(), "music");

// --- CLI Args ---
const args = process.argv.slice(2);
const flags = {
  shuffle: args.includes("--shuffle"),
  format: (args.find((a) => a.startsWith("--format=")) || "").split("=")[1] || "mp3",
  quality: (args.find((a) => a.startsWith("--quality=")) || "").split("=")[1] || "0",
  parallel: parseInt((args.find((a) => a.startsWith("--parallel=")) || "").split("=")[1]) || 1,
  dryRun: args.includes("--dry-run"),
  playlistOnly: args.includes("--playlist-only"),
  search: args.includes("--search"),
};
const urls = args.filter((a) => !a.startsWith("--"));

function showHelp() {
  console.log(`
Spotify Freedom - Ditch Spotify. Own your music.

Usage:
  node export-spotify.js [options] <url1> [url2] ...

URLs:
  Spotify playlist URL    https://open.spotify.com/playlist/...
  Spotify album URL       https://open.spotify.com/album/...
  Search query            --search "Artist - Song Title"

Options:
  --shuffle               Shuffle playlist order before downloading
  --format=FORMAT         Audio format: mp3 (default), opus, flac, m4a, wav
  --quality=QUALITY       Audio quality: 0 = best (default), 5 = medium, 9 = worst
  --parallel=N            Download N songs at once (default: 1, max: 5)
  --dry-run               Show tracks without downloading
  --playlist-only         Only create M3U playlist, skip download
  --help                  Show this help

Examples:
  node export-spotify.js "https://open.spotify.com/playlist/abc123"
  node export-spotify.js --shuffle --format=opus --parallel=3 "https://open.spotify.com/playlist/abc123"
  node export-spotify.js --search "NF - The Search" "Woodkid - Run Boy Run"
  node export-spotify.js --dry-run "https://open.spotify.com/album/xyz789"
`);
}

// --- Spotify API ---
async function getEmbedToken(type, id) {
  const resp = await fetch(
    `https://open.spotify.com/embed/${type}/${id}`,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
    }
  );
  const html = await resp.text();
  const match = html.match(/"accessToken":"([^"]+)"/);
  if (!match) throw new Error("Could not extract embed token");
  return match[1];
}

async function getPlaylistTracks(playlistId, token) {
  const allTracks = [];
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`;

  while (url) {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error(`API error: ${resp.status}`);
    const data = await resp.json();
    allTracks.push(
      ...data.items
        .filter((item) => item.track)
        .map((item) => ({
          name: item.track.name,
          artist: item.track.artists.map((a) => a.name).join(", "),
          album: item.track.album.name,
        }))
    );
    url = data.next;
    process.stdout.write(`\r  ${allTracks.length} tracks geladen...`);
  }
  console.log();
  return allTracks;
}

async function getPlaylistName(playlistId, token) {
  const resp = await fetch(
    `https://api.spotify.com/v1/playlists/${playlistId}?fields=name`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await resp.json();
  return data.name || playlistId;
}

async function getAlbumTracks(albumId, token) {
  const resp = await fetch(`https://api.spotify.com/v1/albums/${albumId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`Album API error: ${resp.status}`);
  const data = await resp.json();
  return {
    name: data.name,
    tracks: data.tracks.items.map((t) => ({
      name: t.name,
      artist: t.artists.map((a) => a.name).join(", "),
      album: data.name,
    })),
  };
}

// --- Utilities ---
function sanitizeFilename(name) {
  return name.replace(/[/\\?%*:|"<>]/g, "-").trim();
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// --- Download ---
function downloadSong(artist, title) {
  const query = `${artist} - ${title}`;
  const filename = sanitizeFilename(`${artist} - ${title}`);
  const ext = flags.format;
  const outputPath = path.join(MUSIC_DIR, `${filename}.%(ext)s`);

  try {
    execSync(
      `yt-dlp -x --audio-format ${ext} --audio-quality ${flags.quality} ` +
        `--embed-thumbnail --add-metadata ` +
        `--no-playlist ` +
        `--output "${outputPath}" ` +
        `"ytsearch1:${query.replace(/"/g, '\\"')}" 2>&1`,
      { stdio: "pipe", timeout: 120000 }
    );
    return true;
  } catch {
    return false;
  }
}

async function downloadParallel(tracks, existing) {
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  const failures = [];
  let index = 0;

  async function worker() {
    while (index < tracks.length) {
      const i = index++;
      const track = tracks[i];
      const filename = sanitizeFilename(`${track.artist} - ${track.name}`);

      if (existing.has(filename)) {
        skipped++;
        console.log(`[${i + 1}/${tracks.length}] ${track.artist} - ${track.name} ... SKIP`);
        continue;
      }

      console.log(`[${i + 1}/${tracks.length}] ${track.artist} - ${track.name} ... `);

      const success = downloadSong(track.artist, track.name);
      if (success) {
        downloaded++;
        existing.add(filename);
        console.log(`  -> OK`);
      } else {
        failed++;
        failures.push(`${track.artist} - ${track.name}`);
        console.log(`  -> FEHLER`);
      }
    }
  }

  const workers = [];
  const numWorkers = Math.min(flags.parallel, 5);
  for (let w = 0; w < numWorkers; w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return { downloaded, skipped, failed, failures };
}

function createM3UPlaylist(playlistName, tracks, existing) {
  const ext = flags.format;
  let m3u = `#EXTM3U\n#PLAYLIST:${playlistName}\n`;
  let found = 0;

  for (const track of tracks) {
    const filename = sanitizeFilename(`${track.artist} - ${track.name}`) + `.${ext}`;
    if (existing.has(sanitizeFilename(`${track.artist} - ${track.name}`))) {
      m3u += `#EXTINF:-1,${track.artist} - ${track.name}\n`;
      m3u += `${filename}\n`;
      found++;
    }
  }

  const m3uPath = path.join(MUSIC_DIR, `${playlistName}.m3u`);
  fs.writeFileSync(m3uPath, m3u);
  console.log(`Playlist erstellt: ${playlistName}.m3u (${found} tracks)`);

  // Shuffle version
  if (flags.shuffle || tracks.length > 0) {
    const shuffled = shuffle(tracks);
    let m3uShuffled = `#EXTM3U\n#PLAYLIST:${playlistName} (Shuffle)\n`;
    for (const track of shuffled) {
      const filename = sanitizeFilename(`${track.artist} - ${track.name}`) + `.${ext}`;
      if (existing.has(sanitizeFilename(`${track.artist} - ${track.name}`))) {
        m3uShuffled += `#EXTINF:-1,${track.artist} - ${track.name}\n`;
        m3uShuffled += `${filename}\n`;
      }
    }
    const shufflePath = path.join(MUSIC_DIR, `${playlistName} (Shuffle).m3u`);
    fs.writeFileSync(shufflePath, m3uShuffled);
    console.log(`Shuffle-Playlist erstellt: ${playlistName} (Shuffle).m3u`);
  }
}

// --- Main ---
async function main() {
  if (urls.length === 0 || args.includes("--help")) {
    showHelp();
    process.exit(0);
  }

  fs.mkdirSync(MUSIC_DIR, { recursive: true });

  const existing = new Set(
    fs.readdirSync(MUSIC_DIR)
      .filter((f) => !f.endsWith(".m3u"))
      .map((f) => f.replace(/\.[^.]+$/, ""))
  );

  let totalDownloaded = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  const allFailures = [];

  // Search mode
  if (flags.search) {
    console.log(`\n--- Direkt-Download ---\n`);
    const tracks = urls.map((q) => {
      const parts = q.split(" - ");
      return { artist: parts[0] || q, name: parts.slice(1).join(" - ") || q };
    });

    if (flags.dryRun) {
      tracks.forEach((t) => console.log(`  ${t.artist} - ${t.name}`));
      return;
    }

    const result = await downloadParallel(tracks, existing);
    totalDownloaded = result.downloaded;
    totalSkipped = result.skipped;
    totalFailed = result.failed;
    allFailures.push(...result.failures);
  } else {
    // Playlist/Album mode
    for (const url of urls) {
      const playlistId = url.match(/playlist\/([a-zA-Z0-9]+)/)?.[1];
      const albumId = url.match(/album\/([a-zA-Z0-9]+)/)?.[1];

      if (!playlistId && !albumId) {
        console.error(`Ungueltige URL: ${url}`);
        continue;
      }

      const isAlbum = !!albumId;
      const id = playlistId || albumId;

      console.log(`\nToken holen...`);
      let token;
      try {
        token = await getEmbedToken(isAlbum ? "album" : "playlist", id);
      } catch (err) {
        console.error(`Token Fehler: ${err.message}`);
        continue;
      }

      let playlistName, tracks;

      if (isAlbum) {
        console.log(`Album laden...`);
        try {
          const album = await getAlbumTracks(id, token);
          playlistName = album.name;
          tracks = album.tracks;
        } catch (err) {
          console.error(`Fehler: ${err.message}`);
          continue;
        }
      } else {
        playlistName = await getPlaylistName(id, token);
        console.log(`Tracks laden...`);
        try {
          tracks = await getPlaylistTracks(id, token);
        } catch (err) {
          console.error(`Fehler: ${err.message}`);
          continue;
        }
      }

      console.log(
        `${isAlbum ? "Album" : "Playlist"}: ${playlistName} (${tracks.length} tracks)`
      );

      // Save metadata
      const metaFile = `${isAlbum ? "album" : "playlist"}_${sanitizeFilename(playlistName)}.json`;
      fs.writeFileSync(metaFile, JSON.stringify({ name: playlistName, tracks }, null, 2));

      // Dry run
      if (flags.dryRun) {
        tracks.forEach((t, i) =>
          console.log(`  [${i + 1}] ${t.artist} - ${t.name}`)
        );
        continue;
      }

      // Shuffle download order
      const downloadOrder = flags.shuffle ? shuffle(tracks) : tracks;

      if (!flags.playlistOnly) {
        const result = await downloadParallel(downloadOrder, existing);
        totalDownloaded += result.downloaded;
        totalSkipped += result.skipped;
        totalFailed += result.failed;
        allFailures.push(...result.failures);
      }

      // Create M3U playlists (always in original order)
      createM3UPlaylist(playlistName, tracks, existing);
    }
  }

  console.log(`\n--- Zusammenfassung ---`);
  console.log(`Heruntergeladen: ${totalDownloaded}`);
  console.log(`Uebersprungen: ${totalSkipped}`);
  console.log(`Fehlgeschlagen: ${totalFailed}`);
  console.log(`Format: ${flags.format} | Qualitaet: ${flags.quality}`);

  if (allFailures.length > 0) {
    fs.writeFileSync("failed_downloads.json", JSON.stringify(allFailures, null, 2));
    console.log(`Fehlgeschlagene Songs: failed_downloads.json`);
  }

  console.log(`\nMusik-Ordner: ${MUSIC_DIR}`);
}

main();

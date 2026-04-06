import fs from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

const MUSIC_DIR = path.join(process.cwd(), "music");

async function getEmbedToken(playlistId) {
  const resp = await fetch(
    `https://open.spotify.com/embed/playlist/${playlistId}`,
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

async function getEmbedTokenForAlbum(albumId) {
  const resp = await fetch(
    `https://open.spotify.com/embed/album/${albumId}`,
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

function sanitizeFilename(name) {
  return name.replace(/[/\\?%*:|"<>]/g, "-").trim();
}

function downloadSong(artist, title) {
  const query = `${artist} - ${title}`;
  const filename = sanitizeFilename(`${artist} - ${title}`);
  const outputPath = path.join(MUSIC_DIR, `${filename}.%(ext)s`);

  try {
    execSync(
      `yt-dlp -x --audio-format mp3 --audio-quality 0 ` +
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

async function main() {
  const playlistUrls = process.argv.slice(2);

  if (playlistUrls.length === 0) {
    console.error(
      "Usage: node export-spotify.js <playlist-url> [playlist-url2] ..."
    );
    process.exit(1);
  }

  fs.mkdirSync(MUSIC_DIR, { recursive: true });

  const existing = new Set(
    fs.readdirSync(MUSIC_DIR).map((f) => f.replace(/\.[^.]+$/, ""))
  );

  let totalDownloaded = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  const failures = [];

  for (const url of playlistUrls) {
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
      token = isAlbum
        ? await getEmbedTokenForAlbum(id)
        : await getEmbedToken(id);
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
      console.log(`Playlist: ${playlistName}`);
      console.log(`Tracks laden...`);
      try {
        tracks = await getPlaylistTracks(id, token);
      } catch (err) {
        console.error(`Fehler: ${err.message}`);
        continue;
      }
    }

    console.log(`${isAlbum ? "Album" : "Playlist"}: ${playlistName} (${tracks.length} tracks)`);

    // Save metadata
    const metaFile = `${isAlbum ? "album" : "playlist"}_${sanitizeFilename(playlistName)}.json`;
    fs.writeFileSync(metaFile, JSON.stringify({ name: playlistName, tracks }, null, 2));
    console.log(`Metadata gespeichert: ${metaFile}`);

    // Create playlist subfolder
    const playlistDir = path.join(MUSIC_DIR, sanitizeFilename(playlistName));
    fs.mkdirSync(playlistDir, { recursive: true });

    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const filename = sanitizeFilename(`${track.artist} - ${track.name}`);

      if (existing.has(filename)) {
        totalSkipped++;
        console.log(
          `[${i + 1}/${tracks.length}] ${track.artist} - ${track.name} ... SKIP`
        );
        continue;
      }

      process.stdout.write(
        `[${i + 1}/${tracks.length}] ${track.artist} - ${track.name} ... `
      );

      const success = downloadSong(track.artist, track.name);
      if (success) {
        totalDownloaded++;
        existing.add(filename);
        console.log("OK");

        // Symlink into playlist folder
        const mp3File = `${filename}.mp3`;
        const src = path.join(MUSIC_DIR, mp3File);
        const dest = path.join(playlistDir, mp3File);
        if (fs.existsSync(src) && !fs.existsSync(dest)) {
          fs.symlinkSync(src, dest);
        }
      } else {
        totalFailed++;
        failures.push(`${track.artist} - ${track.name}`);
        console.log("FEHLER");
      }
    }
  }

  console.log(`\n--- Zusammenfassung ---`);
  console.log(`Heruntergeladen: ${totalDownloaded}`);
  console.log(`Uebersprungen: ${totalSkipped}`);
  console.log(`Fehlgeschlagen: ${totalFailed}`);

  if (failures.length > 0) {
    fs.writeFileSync(
      "failed_downloads.json",
      JSON.stringify(failures, null, 2)
    );
    console.log(`Fehlgeschlagene Songs: failed_downloads.json`);
  }

  console.log(`\nMusik-Ordner: ${MUSIC_DIR}`);
}

main();

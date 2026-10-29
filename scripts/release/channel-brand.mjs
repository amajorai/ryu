#!/usr/bin/env node
// scripts/release/channel-brand.mjs
//
// STAMP THE RELEASE CHANNEL ONTO THE DESKTOP BUNDLE'S IDENTITY.
//
// A channel build should say what it is everywhere the OS shows an app name —
// the macOS Dock and ⌘-Tab, the Windows taskbar hover, a Linux `.desktop` entry
// — not only inside the app. All three read the BUNDLE's name, which Tauri takes
// from `productName` at bundle time. There is no runtime call that changes it
// (`set_title` moves the window title only, and this app runs `decorations:
// false`, so it has no titlebar to move), which is why this is a build step and
// not a feature.
//
//   node scripts/release/channel-brand.mjs                 # channel from the config's version
//   node scripts/release/channel-brand.mjs --channel nightly
//   node scripts/release/channel-brand.mjs --icons-only    # only regenerate the icon sources
//
// What it writes into apps/desktop/src-tauri/tauri.conf.json:
//   - `productName`          → "Ryu (Nightly)"      (the OS-registered name)
//   - `app.windows[0].title` → the same string      (window/taskbar title)
//   - `bundle.icon`          → icons/<channel>/…    (the channel-tinted set)
//
// What it deliberately does NOT touch, each for a specific reason:
//   - `version`        — release.yml gates `tag == tauri.conf.json.version`, and
//                        this script runs AFTER next-version.mjs stamps it.
//   - `mainBinaryName` — renaming the executable renames the updater artifacts
//                        that `install_update_from_channel` (src-tauri/src/lib.rs)
//                        and assemble-channel-feed.sh both address by name.
// Profile builds also stamp a distinct identifier and deep-link scheme. Stable
// retains the original identity and ryu://; other builds cannot claim it.
//
// ONE-TIME RENAME: the first build of a channel that runs this renames that
// channel's bundle (`Ryu.app` → `Ryu (Nightly).app`, and the installer file name
// with it). The release pipeline discovers assets by extension, not by exact name
// (release.yml's `-name '*.dmg'` sweep, assemble-channel-feed.sh's `_amd64\.AppImage$`),
// so nothing there breaks; but an already-installed app updates into a renamed
// bundle exactly once. Every build after that is stable, because a channel's
// label never changes.

import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const TAURI_DIR = join(REPO, "apps/desktop/src-tauri");
const CONFIG = join(TAURI_DIR, "tauri.conf.json");
const CHANNELS = join(REPO, "apps/desktop/src/lib/release-channels.json");
const BASE_ICON = join(TAURI_DIR, "icons/icon.png");
const SOURCE_DIR = join(TAURI_DIR, "icons/channel");

const APP_NAME = "Ryu";
const STABLE = "stable";
const PROFILE_SCHEMES = JSON.parse(
	readFileSync(
		join(REPO, "packages/protocol/src/deep-link-profiles.json"),
		"utf8"
	)
);

export function applyProfileIdentity(config, channel) {
	const profile = channel === STABLE ? "release" : channel;
	if (!Object.hasOwn(PROFILE_SCHEMES, profile)) {
		throw new Error(`Unsupported desktop profile: ${profile}`);
	}
	config.identifier =
		profile === "release"
			? "ai.amajor.ryu.desktop"
			: `ai.amajor.ryu.desktop.${profile}`;
	config.plugins ??= {};
	config.plugins["deep-link"] ??= {};
	config.plugins["deep-link"].desktop = { schemes: [PROFILE_SCHEMES[profile]] };
	return config;
}

const die = (msg) => {
	process.stderr.write(`channel-brand: ${msg}\n`);
	process.exit(1);
};
const log = (msg) => process.stdout.write(`channel-brand: ${msg}\n`);

// ── Channel derivation ───────────────────────────────────────────────────────
//
// Mirrors Core's `channel_of` (apps/core/src/update/mod.rs): the FIRST dot-
// separated prerelease identifier is the channel, and no prerelease means stable.
// Kept byte-for-byte in step with that function and with the desktop's
// `channelOfVersion` — three readers, one rule.

export function channelOfVersion(version) {
	const raw = String(version ?? "")
		.trim()
		.replace(/^[vV]/, "");
	const withoutBuild = raw.split("+")[0] ?? "";
	const dash = withoutBuild.indexOf("-");
	if (dash === -1) {
		return STABLE;
	}
	const pre = withoutBuild.slice(dash + 1);
	const first = pre.split(".")[0];
	return first ? first : STABLE;
}

function channelTable() {
	return JSON.parse(readFileSync(CHANNELS, "utf8"));
}

export function labelFor(channel, table) {
	const known = table[channel]?.label;
	return known ?? channel.charAt(0).toUpperCase() + channel.slice(1);
}

// ── PNG recolour ─────────────────────────────────────────────────────────────
//
// The base icon is a solid dark tile with a white mark on it. A channel icon is
// that same art with the TILE re-tinted and the mark left white, so every channel
// stays recognisably the same logo. Each pixel's grey level is read as a blend
// factor between the tile colour (black in the source) and white, which keeps the
// mark's antialiased edges clean instead of hard-keying them.
//
// Hand-rolled rather than via `sharp`: this runs inside the release workflows,
// where the only guaranteed toolchain is Node itself. `zlib` ships with it.

function readPng(path) {
	const file = readFileSync(path);
	let pos = 8;
	let idat = Buffer.alloc(0);
	let header = null;
	while (pos < file.length) {
		const len = file.readUInt32BE(pos);
		const type = file.toString("ascii", pos + 4, pos + 8);
		const data = file.subarray(pos + 8, pos + 8 + len);
		if (type === "IHDR") {
			header = {
				width: data.readUInt32BE(0),
				height: data.readUInt32BE(4),
				depth: data[8],
				color: data[9],
				interlace: data[12],
			};
		}
		if (type === "IDAT") {
			idat = Buffer.concat([idat, data]);
		}
		pos += 12 + len;
	}
	if (!header) {
		die(`${path} has no IHDR`);
	}
	if (header.depth !== 8 || header.color !== 6 || header.interlace !== 0) {
		die(
			`${path} must be a non-interlaced 8-bit RGBA PNG (got depth ${header.depth}, colour type ${header.color})`
		);
	}
	return { header, raw: inflateSync(idat) };
}

/** Undo the per-scanline PNG filters, returning flat RGBA rows. */
function unfilter({ header, raw }) {
	const stride = header.width * 4;
	const out = Buffer.alloc(stride * header.height);
	let prev = Buffer.alloc(stride);
	let read = 0;
	for (let y = 0; y < header.height; y += 1) {
		const type = raw[read];
		read += 1;
		const line = Buffer.from(raw.subarray(read, read + stride));
		read += stride;
		for (let x = 0; x < stride; x += 1) {
			const a = x >= 4 ? line[x - 4] : 0;
			const b = prev[x];
			const c = x >= 4 ? prev[x - 4] : 0;
			if (type === 1) {
				line[x] = (line[x] + a) & 255;
			} else if (type === 2) {
				line[x] = (line[x] + b) & 255;
			} else if (type === 3) {
				line[x] = (line[x] + ((a + b) >> 1)) & 255;
			} else if (type === 4) {
				const p = a + b - c;
				const pa = Math.abs(p - a);
				const pb = Math.abs(p - b);
				const pc = Math.abs(p - c);
				const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
				line[x] = (line[x] + pr) & 255;
			}
		}
		line.copy(out, y * stride);
		prev = line;
	}
	return out;
}

function crc32(buf) {
	let crc = 0xff_ff_ff_ff;
	for (const byte of buf) {
		crc ^= byte;
		for (let i = 0; i < 8; i += 1) {
			crc = crc & 1 ? (crc >>> 1) ^ 0xed_b8_83_20 : crc >>> 1;
		}
	}
	return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
}

function writePng(path, width, height, pixels) {
	const stride = width * 4;
	// Filter type 0 on every row: the payload is tiny and already compresses
	// well, and a naive encoder is far easier to trust than a heuristic one.
	const rows = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y += 1) {
		pixels.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	writeFileSync(
		path,
		Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			chunk("IHDR", ihdr),
			chunk("IDAT", deflateSync(rows, { level: 9 })),
			chunk("IEND", Buffer.alloc(0)),
		])
	);
}

function parseHex(hex) {
	const m = /^#?([\da-f]{6})$/i.exec(hex ?? "");
	if (!m) {
		die(`bad tile colour "${hex}" — expected #rrggbb`);
	}
	const n = Number.parseInt(m[1], 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Write `icons/channel/<channel>.png` for every non-stable channel. */
function regenerateSources(table) {
	const png = readPng(BASE_ICON);
	const flat = unfilter(png);
	const { width, height } = png.header;
	mkdirSync(SOURCE_DIR, { recursive: true });
	for (const [channel, brand] of Object.entries(table)) {
		if (channel === STABLE) {
			// Stable keeps the committed art untouched — it IS the base icon.
			continue;
		}
		const [tr, tg, tb] = parseHex(brand.tile);
		const out = Buffer.from(flat);
		for (let p = 0; p < out.length; p += 4) {
			// Grey level of the source pixel = how far toward white this pixel sits.
			const level = out[p] / 255;
			out[p] = Math.round(tr + (255 - tr) * level);
			out[p + 1] = Math.round(tg + (255 - tg) * level);
			out[p + 2] = Math.round(tb + (255 - tb) * level);
		}
		const path = join(SOURCE_DIR, `${channel}.png`);
		writePng(path, width, height, out);
		log(`icon source → ${path} (${brand.tile})`);
	}
}

// ── Icon set ─────────────────────────────────────────────────────────────────

/**
 * Expand `icons/channel/<channel>.png` into the full platform set under
 * `icons/<channel>/` via the Tauri CLI — the same tool that produced the
 * committed stable set, so the .icns/.ico layouts match exactly.
 *
 * Derived art, so it is generated rather than committed: four more copies of
 * seventeen files would drift the moment the base logo changes. Returns false
 * when the CLI is unavailable, and the caller then keeps the stable icons — a
 * missing tint must not fail a release build.
 */
function buildIconSet(channel) {
	const source = join(SOURCE_DIR, `${channel}.png`);
	if (!existsSync(source)) {
		log(`no icons/channel/${channel}.png — keeping the stable icon set`);
		return false;
	}
	const out = join(TAURI_DIR, "icons", channel);
	if (existsSync(join(out, "icon.icns"))) {
		return true;
	}
	// `--no-install` keeps branding a build-time operation, never a trigger for
	// downloading and executing a mutable npm package. If the pinned local CLI is
	// unavailable, retain the stable icon set below.
	for (const runner of [
		["bunx", ["--no-install", "tauri", "icon", source, "-o", out]],
	]) {
		const run = spawnSync(runner[0], runner[1], {
			cwd: join(REPO, "apps/desktop"),
			stdio: "inherit",
		});
		if (run.status === 0) {
			log(`icon set → src-tauri/icons/${channel}/`);
			return true;
		}
	}
	log("could not run `tauri icon` — keeping the stable icon set");
	return false;
}

// ── Config stamp ─────────────────────────────────────────────────────────────

function stamp(channel, table, configPath) {
	const config = JSON.parse(readFileSync(configPath, "utf8"));
	applyProfileIdentity(config, channel);
	const name = `${APP_NAME} (${labelFor(channel, table)})`;
	config.productName = name;
	if (config.app?.windows?.[0]) {
		config.app.windows[0].title = name;
	}
	if (channel !== STABLE && buildIconSet(channel)) {
		const dir = `icons/${channel}`;
		// An overlay config (tauri.dev.conf.json) has no bundle block of its own;
		// Tauri merges what it does declare over the base, so creating one here
		// overrides only the icon.
		config.bundle ??= {};
		config.bundle.icon = [
			`${dir}/32x32.png`,
			`${dir}/128x128.png`,
			`${dir}/128x128@2x.png`,
			`${dir}/icon.icns`,
			`${dir}/icon.ico`,
		];
	}
	writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
	log(
		`productName → "${name}" (channel ${channel}${config.version ? `, version ${config.version}` : ""})`
	);
}

function argValue(argv, flag) {
	const at = argv.indexOf(flag);
	return at === -1 ? undefined : argv[at + 1];
}

function main() {
	const argv = process.argv.slice(2);
	const table = channelTable();
	if (argv.includes("--icons-only")) {
		regenerateSources(table);
		return;
	}
	const configPath = resolve(REPO, argValue(argv, "--config") ?? CONFIG);
	const config = JSON.parse(readFileSync(configPath, "utf8"));
	// An overlay config carries no version, so the base config's one decides —
	// the channel a build is on is a property of the build, not of the overlay.
	const version =
		config.version ?? JSON.parse(readFileSync(CONFIG, "utf8")).version;
	const channel = argValue(argv, "--channel") ?? channelOfVersion(version);
	if (!channel) {
		die("--channel needs a value");
	}
	stamp(channel, table, configPath);
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
	main();
}

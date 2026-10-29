import { existsSync } from "node:fs";
import path from "node:path";

// Features every Core binary a developer runs must carry (see dev.js); the
// restart rebuild must match or the replacement host loses them.
export const CORE_DEV_FEATURES = "sandbox-wasmtime,voice-parakeet,voice-vad";

const PROFILE_OFFSETS = {
	release: 0,
	dev: 1000,
	canary: 2000,
	nightly: 3000,
	beta: 4000,
};

export function coreHealthUrl(env = process.env) {
	const profile = (env.RYU_PROFILE ?? "").trim() || "dev";
	if (!Object.hasOwn(PROFILE_OFFSETS, profile)) {
		throw new Error(`Unknown RYU_PROFILE: ${profile}`);
	}
	const configuredOffset = (env.RYU_PORT_OFFSET ?? "").trim();
	const offset =
		/^\d+$/.test(configuredOffset) && Number(configuredOffset) <= 50_000
			? Number(configuredOffset)
			: PROFILE_OFFSETS[profile];
	const bind = env.RYU_BIND ?? `127.0.0.1:${7980 + offset}`;
	const url = new URL(`http://${bind}/api/health`);
	if (url.hostname === "0.0.0.0") {
		url.hostname = "127.0.0.1";
	} else if (url.hostname === "[::]") {
		url.hostname = "[::1]";
	}
	return url.href;
}

// Admit the health fingerprint consumed by this launcher, rather than claiming
// that the remaining Core health payload has been decoded. This script runs on
// stock Node and cannot require the application's package dependency graph.
function parseCoreHealthFingerprint(body) {
	if (body?.status !== "ok" || !Array.isArray(body.capabilities)) {
		return null;
	}
	try {
		const version = String.prototype.valueOf.call(body.version);
		if (version !== body.version) {
			return null;
		}
		return { status: "ok", version, capabilities: body.capabilities };
	} catch {
		return null;
	}
}

export async function hasHealthyCore(url) {
	try {
		const response = await fetch(url, {
			signal: AbortSignal.timeout(2000),
			redirect: "error",
		});
		if (!response.ok) {
			return false;
		}
		const body = await response.json();
		return parseCoreHealthFingerprint(body) !== null;
	} catch {
		return false;
	}
}

// Keep Turbo's persistent task alive without taking ownership of the existing
// Core. Stopping this launcher must not stop its conversations or children.
export function keepAttached() {
	const timer = setInterval(() => {}, 60_000);
	const stop = () => {
		clearInterval(timer);
		process.exit(0);
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
}

export function sharedTargetDir(env = process.env) {
	return (
		(env.CARGO_TARGET_DIR ?? "").trim() ||
		path.resolve(import.meta.dirname, "..", "..", "..", ".cargo-target-shared")
	);
}

export function coreBinaryPath(targetDir, platform = process.platform) {
	return path.join(
		targetDir,
		"debug",
		platform === "win32" ? "ryu-core.exe" : "ryu-core"
	);
}

// `dev:restart` flags: `--now` replaces the host without waiting for running
// turns; `--wait` stays in the foreground instead of detaching.
export function parseRestartOptions(argv) {
	const options = { now: false, wait: false };
	for (const argument of argv) {
		if (argument === "--now") {
			options.now = true;
		} else if (argument === "--wait") {
			options.wait = true;
		} else {
			throw new Error(
				`Unknown dev:restart option: ${argument} (expected --now or --wait)`
			);
		}
	}
	return options;
}

export function restartHostArgs(options) {
	return ["--restart-dev-execution", ...(options.now ? ["--now"] : [])];
}

// Every converted sidecar bin. Package name == binary name == `ryu-<suffix>`; the
// override env var Core reads is `RYU_<SUFFIX>_BIN` (uppercased). Keep this list in
// sync with the [[bin]] crates and the release/fetch wiring.
export const SIDECAR_BINS = [
	"mail",
	"checks",
	"projects",
	"token-table",
	"teams",
	"research",
	"clips",
	"finetune",
	"quests",
	"healing",
	"meetings",
	"recipes",
	"dashboards",
	"monitors",
	"ugc",
	"social",
	"reasoning",
	"rlm",
	"tuition",
	"news",
	"blueprint",
	"rooms",
	"mission-control",
	"crm",
	"drafts",
	"feedback-board",
	"expenses",
	"family",
	"places",
	"decks",
	"subtitles",
	"anydoc",
	"security",
];

// The built output of the browser app's sidecar (see apps-store/browser/sidecar).
export function browserSidecarOutputPath() {
	return path.resolve(
		import.meta.dirname,
		"..",
		"..",
		"..",
		"apps-store",
		"browser",
		"sidecar",
		"out",
		"main",
		"index.js"
	);
}

// Point the dev binary overrides at the builds in the shared target dir:
// `RYU_<SUFFIX>_BIN` for every sidecar bin, `RYU_GATEWAY_BIN` (so Core never
// launches a stale release Gateway from PATH) and `RYU_BROWSER_BIN` (the dev
// launcher, only once the browser sidecar is built). A host starts with the
// environment of the process that spawns it, so both `dev.js` (the original
// `cargo run`) and `dev-restart.mjs` (the replacement host) apply the same
// overrides. A value already in `env` is respected unless `overwrite` is set.
// Returns warnings for the overrides that could not be wired.
export function applyDevBinaryOverrides(
	sharedTarget,
	{
		env = process.env,
		platform = process.platform,
		overwrite = false,
		exists = existsSync,
	} = {}
) {
	const warnings = [];
	const binExt = platform === "win32" ? ".exe" : "";
	const set = (name, value) => {
		if (overwrite || !(env[name] ?? "").trim()) {
			env[name] = value;
		}
	};
	for (const name of SIDECAR_BINS) {
		const bin = path.join(sharedTarget, "debug", `ryu-${name}${binExt}`);
		if (exists(bin)) {
			set(`RYU_${name.toUpperCase()}_BIN`, bin);
		} else {
			warnings.push(`ryu-${name} build produced no binary at ${bin}`);
		}
	}
	const gatewayBin = path.join(sharedTarget, "debug", `ryu-gateway${binExt}`);
	if (exists(gatewayBin)) {
		set("RYU_GATEWAY_BIN", gatewayBin);
	} else {
		warnings.push(
			`shared ryu-gateway binary not found at ${gatewayBin}; Core will resolve it from PATH`
		);
	}
	if (exists(browserSidecarOutputPath())) {
		set(
			"RYU_BROWSER_BIN",
			path.join(
				import.meta.dirname,
				platform === "win32" ? "ryu-browser-dev.cmd" : "ryu-browser-dev.sh"
			)
		);
	} else {
		warnings.push(
			"browser sidecar not built; run `electron-vite build` in apps-store/browser/sidecar first (browser app disabled)"
		);
	}
	return { warnings };
}

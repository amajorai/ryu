// Core dev script: sets shared CARGO_TARGET_DIR, kills stale exe, spawns cargo run.
// Using a script (not inline shell) so CARGO_TARGET_DIR propagates to cargo run.
import { execSync, spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import path from "node:path";

const sharedTarget = path.resolve(
	import.meta.dirname,
	"..",
	"..",
	"..",
	".cargo-target-shared"
);
process.env.CARGO_TARGET_DIR = sharedTarget;

// Dev-stack isolation: default onto the dev profile (~/.ryu-dev, ports +1000)
// so a dev Core never touches a release install's data. Explicit wins —
// RYU_PROFILE=release restores the shared-folder behaviour.
if (!(process.env.RYU_PROFILE ?? "").trim()) {
	process.env.RYU_PROFILE = "dev";
}

if (process.platform === "win32") {
	try {
		execSync("taskkill /F /IM ryu-core.exe", { stdio: "ignore" });
	} catch {
		// Intentionally ignored.
	}
	// Poll up to 15s until the compiled exe is no longer locked.
	const exePath = path.join(sharedTarget, "debug", "ryu-core.exe");
	for (let i = 0; i < 15; i++) {
		try {
			execSync("cmd /c timeout /t 1 /nobreak", { stdio: "ignore" });
		} catch {
			// Intentionally ignored.
		}
		if (!existsSync(exePath)) {
			break;
		}
		try {
			closeSync(openSync(exePath, "r+"));
			break;
		} catch {
			// Intentionally ignored.
		}
	}
} else {
	try {
		execSync("pkill -f ryu-core", { stdio: "ignore" });
	} catch {
		// Intentionally ignored.
	}
}

// Dev-mode sidecar-app ergonomics: the out-of-process sidecar-app bins (ryu-mail
// + the wave 2-4 conversions: teams/research/clips/finetune/quests/healing/
// meetings/recipes/dashboards/monitors) and the browser (electron) app aren't
// auto-built/downloaded in dev the way ryu-core is, so enabling any of them would
// fail to spawn. Wire them all up here, best-effort — a failure warns but never
// blocks Core. Core inherits the RYU_*_BIN overrides via env, which the kind:local
// sidecar resolver prefers over the bare PATH lookup.
const binExt = process.platform === "win32" ? ".exe" : "";

// Every converted sidecar bin. Package name == binary name == `ryu-<suffix>`; the
// override env var Core reads is `RYU_<SUFFIX>_BIN` (uppercased). Keep this list in
// sync with the [[bin]] crates and the release/fetch wiring.
const sidecarBins = [
	"mail",
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
];

// Build ALL sidecar bins in a SINGLE cargo invocation so the shared dependency
// graph compiles once instead of once per crate. The first dev boot after a clean
// checkout is therefore noticeably slower (all bins compile up front); subsequent
// boots are incremental. Best-effort: a failed build warns but never blocks Core —
// individual apps whose binary is missing simply won't spawn.
const buildArgs = sidecarBins.flatMap((name) => ["-p", `ryu-${name}`]);
try {
	execSync(`cargo build ${buildArgs.join(" ")}`, {
		stdio: "inherit",
		env: process.env,
	});
} catch (err) {
	console.warn(
		`[dev] sidecar bin build failed (some apps may be disabled): ${err.message}`
	);
}

// Point each RYU_<SUFFIX>_BIN at the freshly built binary in the shared target dir
// so the matching `com.ryu.<app>` sidecar spawns it. Done per-bin (not gated on the
// single build succeeding) so a partial build still wires up whatever landed.
for (const name of sidecarBins) {
	const bin = path.join(sharedTarget, "debug", `ryu-${name}${binExt}`);
	const envVar = `RYU_${name.toUpperCase()}_BIN`;
	if (existsSync(bin)) {
		process.env[envVar] = bin;
	} else {
		console.warn(`[dev] ryu-${name} build produced no binary at ${bin}`);
	}
}

// Browser: point RYU_BROWSER_BIN at the dev launcher that runs the electron-vite
// build. Only wire it if the build output exists — otherwise Core would spawn a
// launcher that immediately fails. Build it with:
//   cd apps-store/browser/sidecar && bun run build
const browserOut = path.resolve(
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
// The sidecar is NOT a turbo dev task (a standalone `electron-vite dev` window
// would be unmanaged: no RYU_EXT_TOKEN, fail-closed control server). Core is the
// only launcher — lazy spawn on first use, idle-stop — so just build the output
// here when it's missing. Best-effort: a failed build warns but never blocks Core.
if (!existsSync(browserOut)) {
	try {
		execSync("bun run build", {
			cwd: path.resolve(
				import.meta.dirname,
				"..",
				"..",
				"..",
				"apps-store",
				"browser",
				"sidecar"
			),
			stdio: "inherit",
			env: process.env,
		});
	} catch (err) {
		console.warn(`[dev] browser sidecar build failed: ${err.message}`);
	}
}
if (existsSync(browserOut)) {
	const launcher =
		process.platform === "win32" ? "ryu-browser-dev.cmd" : "ryu-browser-dev.sh";
	process.env.RYU_BROWSER_BIN = path.join(import.meta.dirname, launcher);
} else {
	console.warn(
		"[dev] browser sidecar not built — run `electron-vite build` in apps-store/browser/sidecar first (browser app disabled)"
	);
}

// Ship the running-binary defaults that the lean Cargo `default` set omits (so
// `cargo test`/CI don't pay their compile cost per spike 0188), but the dev and
// release binaries the user actually runs must have compiled in:
//   - `sandbox-wasmtime`: the default WASM sandbox — otherwise `detect_backend`
//     reports wasmtime unavailable and the Store shows it as not-ready.
//   - `voice-parakeet`: the default STT engine (parakeet v3 ONNX inference) —
//     otherwise `default_stt_engine()` falls back to whisper.cpp.
//   - `voice-vad`: the default neural VAD (Silero ONNX) for voice mode —
//     otherwise the voice gate falls back to the energy heuristic.
// See apps/core/package.json `build` for the release counterpart.
const child = spawn(
	"cargo",
	["run", "--features", "sandbox-wasmtime,voice-parakeet,voice-vad"],
	{
		stdio: "inherit",
		env: process.env,
		shell: false,
	}
);
child.on("exit", (code) => process.exit(code ?? 0));

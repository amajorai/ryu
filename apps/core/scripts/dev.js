// Core dev script: sets shared CARGO_TARGET_DIR, kills stale exe, spawns cargo run.
// Using a script (not inline shell) so CARGO_TARGET_DIR propagates to cargo run.
const { execSync, spawn } = require("node:child_process");
const { existsSync, openSync, closeSync } = require("node:fs");
const path = require("node:path");

const sharedTarget = path.resolve(
	__dirname,
	"..",
	"..",
	"..",
	".cargo-target-shared"
);
process.env.CARGO_TARGET_DIR = sharedTarget;

if (process.platform === "win32") {
	try {
		execSync("taskkill /F /IM ryu-core.exe", { stdio: "ignore" });
	} catch {}
	// Poll up to 15s until the compiled exe is no longer locked.
	const exePath = path.join(sharedTarget, "debug", "ryu-core.exe");
	for (let i = 0; i < 15; i++) {
		try {
			execSync("cmd /c timeout /t 1 /nobreak", { stdio: "ignore" });
		} catch {}
		if (!existsSync(exePath)) {
			break;
		}
		try {
			closeSync(openSync(exePath, "r+"));
			break;
		} catch {}
	}
} else {
	try {
		execSync("pkill -f ryu-core", { stdio: "ignore" });
	} catch {}
}

// Ship the default WASM sandbox (wasmtime) in the running binary. The Cargo
// `default` feature set stays lean (so `cargo test`/CI don't pay the wasmtime +
// cranelift compile cost per spike 0188), but the dev and release binaries the
// user actually runs must have it compiled in — otherwise `detect_backend`
// reports wasmtime unavailable and the Store shows the default sandbox as
// not-ready. See apps/core/package.json `build` for the release counterpart.
const child = spawn("cargo", ["run", "--features", "sandbox-wasmtime"], {
	stdio: "inherit",
	env: process.env,
	shell: false,
});
child.on("exit", (code) => process.exit(code ?? 0));

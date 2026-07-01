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

const child = spawn("cargo", ["run"], {
	stdio: "inherit",
	env: process.env,
	shell: false,
});
child.on("exit", (code) => process.exit(code ?? 0));

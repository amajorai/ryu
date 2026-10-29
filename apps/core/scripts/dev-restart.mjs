// Apply Core code changes without stopping running chats.
//
// Rebuilds Core, then replaces the dev execution host once every running turn
// has finished (see docs/core-independent-execution.md). The public listener
// and Desktop stay up; open chats reattach to the new host on their own. The
// restarter detaches by default: run from a Ryu chat (Ryu building Ryu), it
// must not wait on the very turn that launched it.
//
//   bun run dev:core:restart          rebuild, restart when idle (detached)
//   bun run dev:core:restart --wait   same, but stay in the foreground
//   bun run dev:core:restart --now    rebuild, restart immediately; boot
//                                     recovery resumes interrupted threads
//
// RYU_DEV_RESTART_MAX_WAIT_SECS (default 1800) bounds the wait for idle.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import {
	applyDevBinaryOverrides,
	CORE_DEV_FEATURES,
	coreBinaryPath,
	parseRestartOptions,
	restartHostArgs,
	sharedTargetDir,
} from "./dev-runtime.mjs";

let options;
try {
	options = parseRestartOptions(process.argv.slice(2));
} catch (error) {
	process.stderr.write(`[dev] ${error.message}\n`);
	process.exit(2);
}

const targetDir = sharedTargetDir();
process.env.CARGO_TARGET_DIR = targetDir;
if (!(process.env.RYU_PROFILE ?? "").trim()) {
	process.env.RYU_PROFILE = "dev";
}

// The replacement host takes its environment from this process, not from the
// original `cargo run`, so point it at the same dev binaries `dev.js` wires up
// (an override the caller already set wins).
for (const warning of applyDevBinaryOverrides(targetDir).warnings) {
	process.stderr.write(`[dev] ${warning}\n`);
}

const build = spawnSync("cargo", ["build", "--features", CORE_DEV_FEATURES], {
	stdio: "inherit",
	env: process.env,
});
if (build.status !== 0) {
	process.stderr.write(
		"[dev] Core build failed; the running host and its chats are untouched.\n"
	);
	process.exit(build.status ?? 1);
}

let binary = coreBinaryPath(targetDir);
if (process.platform === "win32") {
	// Windows locks a running executable. Run the restarter from a copy so the
	// next `cargo build` can still replace target/debug while it waits.
	const restartDir = path.join(targetDir, "dev-restart");
	mkdirSync(restartDir, { recursive: true });
	const copy = path.join(restartDir, "ryu-core-restart.exe");
	copyFileSync(binary, copy);
	binary = copy;
}

const args = restartHostArgs(options);
if (options.wait) {
	const result = spawnSync(binary, args, {
		stdio: "inherit",
		env: process.env,
	});
	process.exit(result.status ?? 1);
}

const logPath = path.join(targetDir, "ryu-dev-restart.log");
const log = openSync(logPath, "a");
// `detached` gives the restarter its own process group, so stopping the old
// host's group (and the chat tool that ran this script) cannot stop it too.
const child = spawn(binary, args, {
	detached: true,
	stdio: ["ignore", log, log],
	env: process.env,
	windowsHide: true,
});
child.unref();
process.stdout.write(
	options.now
		? `[dev] Core rebuilt; restarting the execution host now (log: ${logPath}).\n`
		: `[dev] Core rebuilt; the execution host restarts once running turns finish (log: ${logPath}).\n`
);

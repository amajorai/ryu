// Desktop dev entry: default RYU_PROFILE=dev so a dev desktop dials the dev
// Core (:8980, ~/.ryu-dev) instead of a release install's stack. Explicit wins —
// RYU_PROFILE=release restores the old behaviour. Mirrors the defaulting in
// scripts/dev-stack.mjs (root) and apps/core/scripts/dev.js so single-task
// `bun dev:desktop` isolates the same way full-stack `bun dev` does.
import { spawn } from "node:child_process";

if (!(process.env.RYU_PROFILE ?? "").trim()) {
	process.env.RYU_PROFILE = "dev";
}

const child = spawn("tauri", ["dev", ...process.argv.slice(2)], {
	stdio: "inherit",
	shell: process.platform === "win32",
});
child.on("exit", (code) => process.exit(code ?? 0));

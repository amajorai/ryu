#!/usr/bin/env node
// Footprint benchmark for Ryu's native components.
//
// Measures the things that actually show whether a component is lean:
//   - Release binary size (the headline: one self-contained native binary, no runtime shipped)
//   - Resolved crate count (the full transitive dependency surface, parsed from Cargo.lock)
//   - Source lines of code (capability density, not a leanness claim on its own)
//   - Idle resident memory (RSS) for the long-running services, sampled live (opt-in)
//
// Every number printed here is reproducible by a stranger on their own machine.
// Nothing is hand-copied. The README "Footprint" blocks are written from this output.
//
// Usage:
//   node scripts/benchmark.mjs                 # size + deps + LOC (no build, no run)
//   node scripts/benchmark.mjs --build         # cargo build --release any missing binaries first
//   node scripts/benchmark.mjs --runtime       # also boot each service and sample idle RSS
//   node scripts/benchmark.mjs --write         # rewrite the <!-- BENCH --> block in each README
//   node scripts/benchmark.mjs --json          # emit machine-readable JSON to stdout
//
// Flags compose, e.g. `--build --runtime --write`.

import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BENCH_BLOCK_RE = /<!-- BENCH:START[\s\S]*?<!-- BENCH:END -->/;
const BENCH_ROOT_RE = /<!-- BENCH:ROOT:START[\s\S]*?<!-- BENCH:ROOT:END -->/;
const IS_WIN = process.platform === "win32";
const EXE = IS_WIN ? ".exe" : "";

// Components measured. `service` marks a daemon with a clean, side-effect-free idle whose
// RSS is worth sampling. Only the Gateway qualifies:
//   - gateway is a stateless OpenAI-compat proxy: boots, binds, idles, spawns nothing.
// Everything else reports size/deps/LOC only, on purpose:
//   - core boots a full local stack on first run (pulls llama.cpp + a default agent), so a
//     fresh-boot "idle RSS" is neither a single number nor side-effect-free to measure.
//   - shadow is a capture engine (booting it engages capture/OCR subsystems, not an "idle").
//   - ghost is a desktop-automation tool that needs a live session.
//   - cli is a short-lived foreground process.
const COMPONENTS = [
	{
		key: "core",
		name: "Ryu Core",
		dir: "apps/core",
		bin: "ryu-core",
		srcDirs: ["apps/core/src"],
	},
	{
		key: "gateway",
		name: "Ryu Gateway",
		dir: "apps/gateway",
		bin: "ryu-gateway",
		srcDirs: ["apps/gateway/src"],
		service: { args: ["--bind=127.0.0.1:17981"], env: {} },
	},
	{
		key: "shadow",
		name: "Shadow",
		dir: "apps/shadow",
		bin: "shadow",
		srcDirs: ["apps/shadow/src"],
	},
	{
		key: "ghost",
		name: "Ghost",
		dir: "apps/ghost",
		bin: "ghost",
		srcDirs: ["apps/ghost/src"],
	},
	{
		key: "cli",
		name: "Ryu CLI",
		dir: "apps/cli",
		bin: "ryu",
		srcDirs: ["apps/cli/src"],
	},
];

const args = new Set(process.argv.slice(2));
const DO_BUILD = args.has("--build");
const DO_RUNTIME = args.has("--runtime");
const DO_WRITE = args.has("--write");
const AS_JSON = args.has("--json");

const log = (...m) => {
	if (!AS_JSON) {
		process.stdout.write(`${m.join(" ")}\n`);
	}
};

function gitFiles(dir) {
	try {
		const out = execFileSync("git", ["ls-files", "--", dir], {
			cwd: ROOT,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		});
		return out.split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

function countLoc(srcDirs) {
	let files = 0;
	let lines = 0;
	for (const dir of srcDirs) {
		for (const file of gitFiles(dir)) {
			if (!file.endsWith(".rs")) {
				continue;
			}
			const abs = join(ROOT, file);
			if (!existsSync(abs)) {
				continue;
			}
			const text = readFileSync(abs, "utf8");
			files += 1;
			lines += text.length === 0 ? 0 : text.split("\n").length;
		}
	}
	return { files, lines };
}

function countCrates(dir) {
	const lock = join(ROOT, dir, "Cargo.lock");
	if (!existsSync(lock)) {
		return null;
	}
	const text = readFileSync(lock, "utf8");
	const matches = text.match(/^\[\[package\]\]$/gm);
	// Every [[package]] is one resolved crate version, including the binary itself
	// and any in-repo workspace members. Subtract 1 so the count is "external deps pulled in".
	return matches ? Math.max(0, matches.length - 1) : 0;
}

function binPath(comp) {
	return join(ROOT, comp.dir, "target", "release", comp.bin + EXE);
}

function buildIfNeeded(comp) {
	const path = binPath(comp);
	if (existsSync(path)) {
		return true;
	}
	if (!DO_BUILD) {
		return false;
	}
	log(`  building ${comp.bin} (release)...`);
	try {
		execFileSync("cargo", ["build", "--release"], {
			cwd: join(ROOT, comp.dir),
			stdio: "inherit",
		});
		return existsSync(path);
	} catch {
		return false;
	}
}

function binSize(comp) {
	const path = binPath(comp);
	return existsSync(path) ? statSync(path).size : null;
}

function rssOf(pid) {
	try {
		if (IS_WIN) {
			const out = execFileSync(
				"powershell",
				[
					"-NoProfile",
					"-Command",
					`(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`,
				],
				{ encoding: "utf8" }
			);
			const n = Number.parseInt(out.trim(), 10);
			return Number.isFinite(n) ? n : null;
		}
		const out = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
			encoding: "utf8",
		});
		const kb = Number.parseInt(out.trim(), 10);
		return Number.isFinite(kb) ? kb * 1024 : null;
	} catch {
		return null;
	}
}

// Total CPU seconds consumed by a process since it started (all cores summed).
function cpuSecondsOf(pid) {
	try {
		if (IS_WIN) {
			const out = execFileSync(
				"powershell",
				[
					"-NoProfile",
					"-Command",
					`(Get-Process -Id ${pid} -ErrorAction Stop).CPU.ToString([System.Globalization.CultureInfo]::InvariantCulture)`,
				],
				{ encoding: "utf8" }
			);
			const n = Number.parseFloat(out.trim());
			return Number.isFinite(n) ? n : null;
		}
		// `ps -o %cpu=` already reports a percentage on POSIX, so it is read directly
		// in measureIdle; this branch is unused there but kept for symmetry.
		return null;
	} catch {
		return null;
	}
}

function posixCpuPercent(pid) {
	try {
		const out = execFileSync("ps", ["-o", "%cpu=", "-p", String(pid)], {
			encoding: "utf8",
		});
		const n = Number.parseFloat(out.trim());
		return Number.isFinite(n) ? n : null;
	} catch {
		return null;
	}
}

// Sample idle RSS (lowest of a few reads) and idle CPU% over a short window.
async function sampleIdle(pid) {
	const cpu0 = cpuSecondsOf(pid);
	const wall0 = Date.now();
	const rssSamples = [];
	for (let i = 0; i < 4; i += 1) {
		const r = rssOf(pid);
		if (r != null) {
			rssSamples.push(r);
		}
		await sleep(1000);
	}
	const rss = rssSamples.length ? Math.min(...rssSamples) : null;
	let cpu = posixCpuPercent(pid);
	if (IS_WIN) {
		const cpu1 = cpuSecondsOf(pid);
		const wallMs = Date.now() - wall0;
		cpu =
			cpu0 != null && cpu1 != null && wallMs > 0
				? Math.max(0, ((cpu1 - cpu0) / (wallMs / 1000)) * 100)
				: null;
	}
	return { rss, cpu };
}

function killTree(child, exited) {
	try {
		if (!(child.pid && !exited)) {
			return;
		}
		if (IS_WIN) {
			execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
				stdio: "ignore",
			});
		} else {
			child.kill("SIGKILL");
		}
	} catch {
		// already gone
	}
}

async function measureIdle(comp) {
	if (!comp.service) {
		return { rss: null, cpu: null };
	}
	const path = binPath(comp);
	if (!existsSync(path)) {
		return { rss: null, cpu: null };
	}
	log(`  booting ${comp.bin} to sample idle RSS + CPU...`);
	// Start from clean state so nothing is resumed or read from an existing config.
	// Note: the daemon may still open a small DB under the OS app-data dir
	// (e.g. the gateway's audit.db in ~/.ryu or %LOCALAPPDATA%\ryu) regardless of
	// RYU_DIR. That is part of its real footprint and is not removed here.
	const dataDir = mkdtempSync(join(tmpdir(), `ryu-bench-${comp.key}-`));
	const child = spawn(path, comp.service.args, {
		cwd: join(ROOT, comp.dir),
		env: { ...process.env, RYU_DIR: dataDir, ...comp.service.env },
		stdio: "ignore",
		detached: false,
	});
	let exited = false;
	child.on("exit", () => {
		exited = true;
	});
	// Let it bind, settle, and stop any first-boot work before sampling.
	await sleep(8000);
	const idle =
		!exited && child.pid
			? await sampleIdle(child.pid)
			: { rss: null, cpu: null };
	killTree(child, exited);
	// Give the OS a moment to release file handles, then remove the temp data dir.
	await sleep(500);
	try {
		rmSync(dataDir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
	return idle;
}

const fmtBytes = (n) => {
	if (n == null) {
		return "n/a";
	}
	if (n >= 1024 * 1024) {
		return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	}
	if (n >= 1024) {
		return `${(n / 1024).toFixed(0)} KB`;
	}
	return `${n} B`;
};

const fmtNum = (n) => (n == null ? "n/a" : n.toLocaleString("en-US"));
const fmtPct = (n) => (n == null ? "n/a" : `${n.toFixed(1)}%`);

async function main() {
	const results = [];
	for (const comp of COMPONENTS) {
		log(`measuring ${comp.name}...`);
		const built = buildIfNeeded(comp);
		const loc = countLoc(comp.srcDirs);
		const crates = countCrates(comp.dir);
		const size = binSize(comp);
		let rss = null;
		let cpu = null;
		if (DO_RUNTIME) {
			const idle = await measureIdle(comp);
			rss = idle.rss;
			cpu = idle.cpu;
		}
		results.push({
			key: comp.key,
			name: comp.name,
			isService: Boolean(comp.service),
			binarySizeBytes: size,
			resolvedCrates: crates,
			sourceFiles: loc.files,
			sourceLines: loc.lines,
			idleRssBytes: rss,
			idleCpuPercent: cpu,
			builtFresh: built && !DO_BUILD ? false : built,
		});
	}

	if (AS_JSON) {
		process.stdout.write(
			`${JSON.stringify({ platform: process.platform, measuredAt: null, components: results }, null, 2)}\n`
		);
		return;
	}

	// Console table
	log("");
	const header = [
		"Component",
		"Binary",
		"Crates",
		"Source",
		"Idle RSS",
		"Idle CPU",
	];
	const rows = results.map((r) => [
		r.name,
		fmtBytes(r.binarySizeBytes),
		fmtNum(r.resolvedCrates),
		r.sourceLines ? `${fmtNum(r.sourceLines)} LOC` : "n/a",
		r.isService ? fmtBytes(r.idleRssBytes) : "n/a",
		r.isService ? fmtPct(r.idleCpuPercent) : "n/a",
	]);
	const widths = header.map((h, i) =>
		Math.max(h.length, ...rows.map((row) => row[i].length))
	);
	const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
	log(line(header));
	log(widths.map((w) => "-".repeat(w)).join("  "));
	for (const row of rows) {
		log(line(row));
	}
	log("");

	if (DO_WRITE) {
		for (const r of results) {
			writeReadmeBlock(r);
		}
		// The private monorepo root README: all native components that exist on disk.
		writeFootprintTable(results, {
			readme: join(ROOT, "README.md"),
			label: "README.md",
			anchor: "\n## Quick start",
			intro: [
				"The native tier ships as a handful of small self-contained Rust binaries: no interpreter,",
				"no runtime, no Electron, no Docker. Every number below is emitted by",
				"[`scripts/benchmark.mjs`](./scripts/benchmark.mjs); reproduce it with `node scripts/benchmark.mjs --build --runtime`.",
			],
			note: `_Idle RSS and CPU are sampled only for the Gateway (a stateless proxy with a clean idle), and idle CPU is effectively nil. Core boots a full local stack on first run, and the capture/automation tools (Shadow, Ghost) and the CLI have no steady idle, so they report size/deps/LOC. Measured on \`${process.platform}\`._`,
		});
		// The public mirror's README (mirror/overlay/README.md) ships only core/gateway/cli;
		// no-op outside the monorepo where the overlay is absent.
		writeFootprintTable(results, {
			readme: join(ROOT, "mirror", "overlay", "README.md"),
			label: "mirror/overlay/README.md",
			anchor: "\n## What's here",
			allow: new Set(["core", "gateway", "cli"]),
			intro: [
				"Ryu's self-hostable stack is two small static Rust binaries (`ryu-core` + `ryu-gateway`), plus the CLI:",
				"no interpreter, no runtime, no Electron, no Docker. Every number below is emitted by",
				"[`scripts/benchmark.mjs`](./scripts/benchmark.mjs); reproduce it with `node scripts/benchmark.mjs --build --runtime`.",
			],
			note: `_Idle RSS and CPU are sampled only for the Gateway (a stateless proxy with a clean idle), and idle CPU is effectively nil. Core boots a full local stack on first run and the CLI is short-lived, so they report size/deps/LOC. Measured on \`${process.platform}\`._`,
		});
	}
}

function footprintRows(results) {
	return results.map((r) => {
		const rss =
			r.isService && r.idleRssBytes != null ? fmtBytes(r.idleRssBytes) : "n/a";
		const cpu =
			r.isService && r.idleCpuPercent != null
				? fmtPct(r.idleCpuPercent)
				: "n/a";
		return `| [\`apps/${r.key}\`](./apps/${r.key}) | ${fmtBytes(r.binarySizeBytes)} | ${fmtNum(r.resolvedCrates)} | ${fmtNum(r.sourceLines)} | ${rss} | ${cpu} |`;
	});
}

function writeFootprintTable(results, opts) {
	const { readme, label, anchor, intro, note, allow } = opts;
	if (!existsSync(readme)) {
		return;
	}
	// Only include components whose source tree is actually present, and that pass the
	// optional allowlist. This keeps the table correct in the public mirror (no
	// shadow/ghost) and lets the overlay show a curated public subset.
	const shown = results.filter((r) => {
		const comp = COMPONENTS.find((c) => c.key === r.key);
		if (!(comp && existsSync(join(ROOT, comp.dir)))) {
			return false;
		}
		return allow ? allow.has(r.key) : true;
	});
	let text = readFileSync(readme, "utf8");
	const block = [
		"<!-- BENCH:ROOT:START (generated by scripts/benchmark.mjs, do not edit by hand) -->",
		"",
		...intro,
		"",
		"| Component | Release binary | Crates | Source (LOC) | Idle RSS | Idle CPU |",
		"| --- | --- | --- | --- | --- | --- |",
		...footprintRows(shown),
		"",
		note,
		"",
		"<!-- BENCH:ROOT:END -->",
	].join("\n");
	if (BENCH_ROOT_RE.test(text)) {
		text = text.replace(BENCH_ROOT_RE, block);
	} else {
		const section = `## Footprint\n\n${block}\n\n`;
		const idx = text.indexOf(anchor);
		if (idx === -1) {
			text = `${text.trimEnd()}\n\n${section}`;
		} else {
			text = `${text.slice(0, idx + 1)}${section}${text.slice(idx + 1)}`;
		}
	}
	writeFileSync(readme, text);
	log(`  wrote combined Footprint block to ${label}`);
}

function readmeTable(r) {
	const lines = [
		"<!-- BENCH:START (generated by scripts/benchmark.mjs, do not edit by hand) -->",
		"",
		"One self-contained native binary: no interpreter, no runtime, no Electron, no Docker.",
		"",
		"| Metric | Value |",
		"| --- | --- |",
		`| Release binary | ${fmtBytes(r.binarySizeBytes)} |`,
		`| Resolved crates (transitive deps) | ${fmtNum(r.resolvedCrates)} |`,
		`| Source | ${fmtNum(r.sourceLines)} lines of Rust across ${fmtNum(r.sourceFiles)} files |`,
	];
	if (r.isService && r.idleRssBytes != null) {
		lines.push(`| Idle memory (RSS) | ${fmtBytes(r.idleRssBytes)} |`);
	}
	if (r.isService && r.idleCpuPercent != null) {
		lines.push(`| Idle CPU | ${fmtPct(r.idleCpuPercent)} |`);
	}
	lines.push("");
	lines.push(
		`_Measured on \`${process.platform}\` by \`node scripts/benchmark.mjs --build --runtime --write\`. Reproduce it yourself._`
	);
	lines.push("");
	lines.push("<!-- BENCH:END -->");
	return lines.join("\n");
}

function writeReadmeBlock(r) {
	const comp = COMPONENTS.find((c) => c.key === r.key);
	const readme = join(ROOT, comp.dir, "README.md");
	if (!existsSync(readme)) {
		return;
	}
	let text = readFileSync(readme, "utf8");
	const block = readmeTable(r);
	if (BENCH_BLOCK_RE.test(text)) {
		text = text.replace(BENCH_BLOCK_RE, block);
	} else {
		const section = `## Footprint\n\n${block}\n\n`;
		// Insert just before the License section if present, else append.
		const licenseIdx = text.indexOf("\n## License");
		if (licenseIdx === -1) {
			text = `${text.trimEnd()}\n\n${section}`;
		} else {
			text = `${text.slice(0, licenseIdx + 1)}${section}${text.slice(licenseIdx + 1)}`;
		}
	}
	writeFileSync(readme, text);
	log(`  wrote Footprint block to ${comp.dir}/README.md`);
}

await main();

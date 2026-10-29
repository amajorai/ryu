import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Compilation and preview share one fresh owned directory. No build/cache output
// is written to the harness, Desktop sources, or readonly satellite repositories.
const desktopRoot = path.resolve(import.meta.dirname, "..");
const proofDirectory = mkdtempSync(
	path.join(tmpdir(), "ryu-agent-posture-native-http-")
);
const config = path.join(
	desktopRoot,
	"e2e/harness/vite.agent-posture-native-http.config.ts"
);
const env = {
	...process.env,
	RYU_AGENT_POSTURE_PROOF_DIR: proofDirectory,
};
let active: ChildProcess | null = null;
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		stopping = true;
		active?.kill(signal);
	});
}
async function run(args: string[]) {
	if (stopping) {
		throw new Error("Owned preview launch interrupted");
	}
	await new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, args, {
			cwd: desktopRoot,
			env,
			stdio: "inherit",
		});
		active = child;
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (active === child) {
				active = null;
			}
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`Owned Vite stage failed: ${code ?? signal}`));
			}
		});
	});
}
const sha = (file: string) =>
	createHash("sha256").update(readFileSync(file)).digest("hex");
const entry = path.join(
	desktopRoot,
	"e2e/harness/agent-posture-native-http.tsx"
);
const sourceBefore = {
	config: sha(config),
	entry: sha(entry),
	launcher: sha(import.meta.filename),
};
try {
	await run(["x", "--no-install", "vite", "build", "--config", config]);
	const sourceAfter = {
		config: sha(config),
		entry: sha(entry),
		launcher: sha(import.meta.filename),
	};
	if (JSON.stringify(sourceBefore) !== JSON.stringify(sourceAfter)) {
		throw new Error("Fixture launch inputs changed during compilation");
	}
	const output = path.join(proofDirectory, "out");
	const files: Array<{ path: string; sha256: string }> = [];
	function collect(directory: string) {
		for (const item of readdirSync(directory, { withFileTypes: true })) {
			const file = path.join(directory, item.name);
			if (item.isDirectory()) {
				collect(file);
			} else if (item.isFile()) {
				files.push({ path: path.relative(output, file), sha256: sha(file) });
			}
		}
	}
	collect(output);
	files.sort((a, b) => a.path.localeCompare(b.path));
	if (!files.some((file) => file.path === "agent-posture-native-http.html")) {
		throw new Error("Expected compiled provider fixture missing");
	}
	const provenance = {
		proofDirectory,
		sourceBefore,
		sourceAfter,
		compiledFiles: files,
		boundary:
			"Direct fixture inputs and compiled assets; the enclosing browser manager fingerprints the shipping source graph.",
	};
	writeFileSync(
		path.join(proofDirectory, "build-provenance.json"),
		`${JSON.stringify(provenance, null, 2)}\n`
	);
	console.log(JSON.stringify({ providerConnectionsBuild: provenance }));
	await run(["x", "--no-install", "vite", "preview", "--config", config]);
} catch (error) {
	console.error(error);
	process.exitCode = 1;
}

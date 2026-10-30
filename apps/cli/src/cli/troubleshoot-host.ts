// The real {@link TroubleshootHost}: every side effect `ryu troubleshoot` performs.

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, open, stat, statfs, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import {
	arch,
	cpus,
	freemem,
	homedir,
	release,
	tmpdir,
	totalmem,
} from "node:os";
import { basename, dirname } from "node:path";
import type { ApiTarget } from "@ryuhq/core-client/client";
import {
	ensureCoreRunning,
	resolveCoreBinary,
	resolveGatewayBinary,
} from "../core/bootstrap.ts";
import { cliDataDir } from "../core/cliStatePath.ts";

// ── Host seam ────────────────────────────────────────────────────────────────

export interface DirProbe {
	exists: boolean;
	/** Free bytes on the volume holding the path (or its nearest parent). */
	freeBytes: number | null;
	writable: boolean;
}

/** Every side effect `ryu troubleshoot` performs. Tests pass a fake. */
export interface TroubleshootHost {
	arch: string;
	/** The name the user typed for this CLI (`ryu-cli`, `ryu`), for fix text. */
	commandName: string;
	cpu: { count: number; model: string | null };
	dataDir: string;
	fetch: typeof fetch;
	homeDir: string;
	makeDir: (path: string) => Promise<void>;
	memory: { freeBytes: number; totalBytes: number };
	now: () => Date;
	/** Open a URL in the default browser; false when that is not possible. */
	openUrl: (url: string) => Promise<boolean>;
	osRelease: string;
	platform: NodeJS.Platform;
	probeDir: (path: string) => Promise<DirProbe>;
	/** True when something accepts TCP connections on host:port. */
	probePort: (host: string, port: number) => Promise<boolean>;
	/** The last `maxBytes` of a text file, or null when it cannot be read. */
	readTail: (path: string, maxBytes: number) => Promise<string | null>;
	resolveBinary: (bin: "core" | "gateway") => string | null;
	runtime: string;
	/** Start a local Core (downloading binaries if needed); see bootstrap.ts. */
	startCore: (target: ApiTarget) => Promise<void>;
	tempDir: string;
	writeFile: (path: string, content: string) => Promise<void>;
}

export async function nearestExisting(path: string): Promise<string | null> {
	let current = path;
	for (;;) {
		try {
			await stat(current);
			return current;
		} catch {
			const parent = dirname(current);
			if (parent === current) {
				return null;
			}
			current = parent;
		}
	}
}

export async function realProbeDir(path: string): Promise<DirProbe> {
	const existing = await nearestExisting(path);
	let freeBytes: number | null = null;
	if (existing) {
		try {
			const fs = await statfs(existing);
			freeBytes = Number(fs.bavail) * Number(fs.bsize);
		} catch {
			freeBytes = null;
		}
	}
	const exists = existing === path;
	let writable = false;
	if (existing) {
		try {
			await access(existing, fsConstants.W_OK);
			writable = true;
		} catch {
			writable = false;
		}
	}
	return { exists, freeBytes, writable };
}

export function realProbePort(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ host, port });
		const done = (open: boolean) => {
			socket.destroy();
			resolve(open);
		};
		socket.setTimeout(1000, () => done(false));
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});
}

export async function realReadTail(
	path: string,
	maxBytes: number
): Promise<string | null> {
	try {
		const handle = await open(path, "r");
		try {
			const { size } = await handle.stat();
			const length = Math.min(size, maxBytes);
			const buffer = Buffer.alloc(length);
			await handle.read(buffer, 0, length, size - length);
			return buffer.toString("utf8");
		} finally {
			await handle.close();
		}
	} catch {
		return null;
	}
}

export function realOpenUrl(url: string): Promise<boolean> {
	// `cmd /c start` splits a URL at `&`; the URL handler takes it verbatim.
	const command =
		process.platform === "win32"
			? ["rundll32", "url.dll,FileProtocolHandler", url]
			: process.platform === "darwin"
				? ["open", url]
				: ["xdg-open", url];
	return new Promise((resolve) => {
		try {
			const child = spawn(command[0], command.slice(1), {
				detached: true,
				stdio: "ignore",
			});
			child.once("error", () => resolve(false));
			child.once("spawn", () => {
				child.unref();
				resolve(true);
			});
		} catch {
			resolve(false);
		}
	});
}

export function invokedName(): string {
	const name = basename(process.execPath).replace(/\.exe$/i, "");
	return name.startsWith("ryu") ? name : "ryu";
}

export function realTroubleshootHost(): TroubleshootHost {
	const cpuList = cpus();
	return {
		arch: arch(),
		commandName: invokedName(),
		cpu: { count: cpuList.length, model: cpuList[0]?.model?.trim() || null },
		dataDir: cliDataDir(),
		fetch: globalThis.fetch,
		homeDir: homedir(),
		makeDir: async (path) => {
			await mkdir(path, { recursive: true });
		},
		memory: { freeBytes: freemem(), totalBytes: totalmem() },
		now: () => new Date(),
		openUrl: realOpenUrl,
		osRelease: release(),
		platform: process.platform,
		probeDir: realProbeDir,
		probePort: realProbePort,
		readTail: realReadTail,
		resolveBinary: (bin) =>
			bin === "core" ? resolveCoreBinary() : resolveGatewayBinary(),
		runtime: process.versions.bun
			? `bun ${process.versions.bun}`
			: `node ${process.versions.node}`,
		// Progress (downloads, start-up) goes to stderr, outside `--json` stdout.
		startCore: (target) => ensureCoreRunning(target),
		tempDir: tmpdir(),
		writeFile: async (path, content) => {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
		},
	};
}

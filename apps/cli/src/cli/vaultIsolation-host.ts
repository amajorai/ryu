// Docker seams (the captured runner and host facts), the signal guard, and
// small pure helpers for container isolation. Split from
// `vaultIsolation.ts`, which re-exports the public names.

import { getRandomValues } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { LocalizedError } from "./localizedText.ts";
import { isolationError, isolationText } from "./vaultIsolation-messages.ts";

export const NETWORK_PREFIX = "ryu-vault-";
export const ISOLATION_LABEL = "com.ryu.vault-isolation";
export const SESSION_LABEL = `${ISOLATION_LABEL}.session`;
/** Suffix of the network-owner container's name. */
export const OWNER_SUFFIX = "-net";
export const PRUNE_GRACE_MS = 60_000;
export const HASH_LENGTH = 12;
/** uid/gid used when the CLI itself runs as root. */
export const NOBODY = 65_534;
/** Owner lifetime when the session expiry is unknown. */
const DEFAULT_OWNER_SECONDS = 86_400;
export const KILL_RETRY_MS = 200;
export const KILL_RETRIES = 25;

/** The only capabilities in the run, held by the trusted network owner. */
export const FIREWALL_CAPABILITIES = ["NET_ADMIN", "NET_RAW"];

export const SIGNAL_NUMBERS: Record<string, number> = {
	SIGHUP: 1,
	SIGINT: 2,
	SIGTERM: 15,
};

// ── Seams ────────────────────────────────────────────────────────────────────

export interface DockerCapture {
	exitCode: number;
	stderr: string;
	stdout: string;
}

/** Runs `docker ARGS…` with captured output (and optional stdin bytes). An
 *  aborted `signal` kills the process. */
export type DockerRunner = (
	args: string[],
	stdin?: Uint8Array,
	signal?: AbortSignal
) => Promise<DockerCapture>;

/** Host facts and side-effect seams for container mode. */
export interface ContainerHost {
	cwd: () => string;
	docker: DockerRunner;
	gid: number;
	homeDir: string;
	/** True when stdin and stdout are terminals (adds `-t`). */
	isTty: boolean;
	/** Registers a handler for SIGINT/SIGTERM/SIGHUP; returns a disposer. */
	onSignal: (handler: (signal: string) => void) => () => void;
	platform: string;
	tmpDir: string;
	uid: number;
}

export class DockerUnavailableError extends LocalizedError {}

/** A signal arrived before the command started; setup was abandoned. */
export class IsolationCancelledError extends Error {
	readonly signal: string;
	constructor(signal: string) {
		super(`container setup cancelled by ${signal}`);
		this.signal = signal;
	}
	/** The conventional shell exit code, 128 + signal number. */
	get exitCode(): number {
		return 128 + (SIGNAL_NUMBERS[this.signal] ?? 15);
	}
}

function spawnDocker(args: string[], withStdin: boolean) {
	return Bun.spawn({
		cmd: ["docker", ...args],
		stdin: withStdin ? "pipe" : "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
}

function abortReason(signal: AbortSignal): string {
	return typeof signal.reason === "string" ? signal.reason : "SIGTERM";
}

/** A killed `docker build`/`pull` reports a failure; report the signal. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new IsolationCancelledError(abortReason(signal));
	}
}

const defaultDocker: DockerRunner = async (args, stdin, signal) => {
	throwIfAborted(signal);
	let proc: ReturnType<typeof spawnDocker>;
	try {
		proc = spawnDocker(args, stdin !== undefined);
	} catch {
		throw new DockerUnavailableError(isolationText.dockerMissing());
	}
	const kill = () => proc.kill();
	signal?.addEventListener("abort", kill, { once: true });
	try {
		const sink = proc.stdin;
		if (stdin !== undefined && sink) {
			sink.write(stdin);
			await sink.end();
		}
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		throwIfAborted(signal);
		return { exitCode, stdout, stderr };
	} finally {
		signal?.removeEventListener("abort", kill);
	}
};

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export function defaultContainerHost(): ContainerHost {
	return {
		cwd: () => process.cwd(),
		docker: defaultDocker,
		gid: process.getgid?.() ?? NOBODY,
		homeDir: homedir(),
		isTty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
		onSignal: (handler) => {
			const listeners = FORWARDED_SIGNALS.map((signal) => {
				const listener = () => handler(signal);
				process.on(signal, listener);
				return [signal, listener] as const;
			});
			return () => {
				for (const [signal, listener] of listeners) {
					process.off(signal, listener);
				}
			};
		},
		platform: process.platform,
		tmpDir: tmpdir(),
		uid: process.getuid?.() ?? NOBODY,
	};
}

// ── Signal guard ─────────────────────────────────────────────────────────────

export interface SignalGuard {
	/** Aborted (reason: the signal name) by a signal before the command starts. */
	readonly abort: AbortSignal;
	dispose: () => void;
	/** After the command starts, signals go to `handler` instead of aborting. */
	forwardTo: (handler: ((signal: string) => void) | null) => void;
	throwIfCancelled: () => void;
}

/** Installs the run's signal handling. Call before any setup step. */
export function guardSignals(host: ContainerHost): SignalGuard {
	const controller = new AbortController();
	let forward: ((signal: string) => void) | null = null;
	const dispose = host.onSignal((signal) => {
		if (forward) {
			forward(signal);
			return;
		}
		if (!controller.signal.aborted) {
			controller.abort(signal);
		}
	});
	return {
		abort: controller.signal,
		dispose,
		forwardTo: (handler) => {
			forward = handler;
		},
		throwIfCancelled: () => {
			if (controller.signal.aborted) {
				throw new IsolationCancelledError(abortReason(controller.signal));
			}
		},
	};
}

// ── Small pure helpers ───────────────────────────────────────────────────────

/** 16 lowercase hex characters naming the network, containers, and temp files. */
export function newIsolationId(): string {
	const bytes = getRandomValues(new Uint8Array(8));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		""
	);
}

export function firstLines(text: string, count = 20): string {
	const lines = text.trim().split("\n");
	return lines.slice(-count).join("\n");
}

const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,254}$/;
export const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

export function validateImageRef(ref: string): string {
	if (!IMAGE_REF.test(ref)) {
		throw isolationError(isolationText.invalidImage(JSON.stringify(ref)));
	}
	return ref;
}

/** Seconds the network owner must outlive the command: the session's
 *  remaining lifetime plus a minute (the session is useless afterwards). */
export function ownerLifetimeSeconds(
	expiresAt: string | number | undefined,
	nowMs: number
): number {
	// Core renders RFC 3339; a numeric fallback is an out-of-range epoch.
	const expiresMs =
		typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
	if (!Number.isFinite(expiresMs)) {
		return DEFAULT_OWNER_SECONDS;
	}
	return Math.max(60, Math.ceil((expiresMs - nowMs) / 1000)) + 60;
}

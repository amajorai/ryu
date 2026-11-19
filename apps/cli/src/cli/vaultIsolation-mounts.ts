// `--mount` parsing and host-path protection: reserved container paths,
// control sockets, and sources that must never reach the container. Split from
// `vaultIsolation.ts`, which re-exports the public names.

import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import {
	isolationError,
	isolationText,
	reasonOf,
} from "./vaultIsolation-messages.ts";
import {
	CONTAINER_CA_BUNDLE_PATH,
	CONTAINER_RUNTIME_DIR,
} from "./vaultIsolationAssets.ts";

// ── Mounts and host-path protection ──────────────────────────────────────────

export interface ParsedMount {
	destination: string;
	readOnly: boolean;
	source: string;
}

/** Container paths owned by the isolation runtime. A mount on, inside, or
 *  above one is refused: overlaying `/bin` or `/etc` could replace the shell
 *  that runs the run script, or the CA it trusts. */
export const RESERVED_CONTAINER_PATHS = [
	"/",
	"/bin",
	"/dev",
	"/etc",
	"/lib",
	"/lib32",
	"/lib64",
	"/libx32",
	"/proc",
	"/run",
	"/sbin",
	"/sys",
	"/tmp",
	"/usr",
	"/var/run",
	"/workspace",
	CONTAINER_RUNTIME_DIR,
	CONTAINER_CA_BUNDLE_PATH,
];

export function validateContainerDestination(destination: string): void {
	if (!posix.isAbsolute(destination)) {
		throw isolationError(isolationText.destinationNotAbsolute(destination));
	}
	if (
		posix.normalize(destination) !== destination ||
		(destination !== "/" && destination.endsWith("/"))
	) {
		throw isolationError(isolationText.destinationNotNormalized(destination));
	}
	for (const reserved of RESERVED_CONTAINER_PATHS) {
		const prefix = reserved === "/" ? "/" : `${reserved}/`;
		if (
			destination === reserved ||
			(reserved !== "/" && destination.startsWith(prefix)) ||
			reserved.startsWith(`${destination}/`)
		) {
			throw isolationError(isolationText.reservedDestination(reserved));
		}
	}
}

/** Known container-runtime control sockets, plus the active docker endpoint;
 *  binding one (or a directory holding one) would let the command start an
 *  unconfined container. Each path is also checked after resolving symlinks. */
export async function controlSockets(
	homeDir: string,
	env: Record<string, string | undefined>,
	endpoint?: string
): Promise<string[]> {
	const sockets = [
		"/var/run/docker.sock",
		"/run/docker.sock",
		"/private/var/run/docker.sock",
		"/run/podman/podman.sock",
		"/run/containerd/containerd.sock",
		join(homeDir, ".docker", "run", "docker.sock"),
		join(homeDir, ".docker", "desktop", "docker.sock"),
		join(homeDir, ".colima", "default", "docker.sock"),
		join(homeDir, ".orbstack", "run", "docker.sock"),
		join(homeDir, ".rd", "docker.sock"),
	];
	for (const host of [env.DOCKER_HOST, endpoint]) {
		if (host?.startsWith("unix://")) {
			sockets.push(host.slice("unix://".length));
		}
	}
	const resolved = new Set<string>();
	for (const socket of sockets) {
		resolved.add(socket);
		try {
			resolved.add(await realpath(socket));
		} catch {
			// A socket that does not exist cannot be exposed.
		}
	}
	return [...resolved];
}

function isWithin(child: string, parent: string): boolean {
	return (
		child === parent ||
		child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)
	);
}

/** Refuses a resolved host source that exposes the host root, a Unix socket
 *  (or a directory above a container-runtime socket), or Ryu's data
 *  directories (`$RYU_DIR`, `~/.ryu`, `~/.ryu-<profile>`), or a parent of one.
 *  `endpoint` is the active docker endpoint from `checkDocker`. */
export async function validateHostSource(
	resolved: string,
	homeDir: string,
	env: Record<string, string | undefined>,
	endpoint?: string
): Promise<void> {
	if (resolved === "/" || resolved === "") {
		throw isolationError(isolationText.hostRoot());
	}
	// colima keeps one directory per profile (~/.colima/<profile>/docker.sock).
	if (isWithin(resolved, join(homeDir, ".colima"))) {
		throw isolationError(isolationText.runtimeDirectory(resolved));
	}
	for (const socket of await controlSockets(homeDir, env, endpoint)) {
		if (isWithin(socket, resolved)) {
			throw isolationError(isolationText.runtimeSocket(resolved, socket));
		}
	}
	const info = await stat(resolved);
	if (info.isSocket()) {
		throw isolationError(isolationText.unixSocket(resolved));
	}
	const canonicalHome = await realpath(homeDir).catch(() => homeDir);
	const protectedDirs = [join(canonicalHome, ".ryu")];
	if (env.RYU_DIR) {
		protectedDirs.push(
			await realpath(env.RYU_DIR).catch(() => env.RYU_DIR ?? "")
		);
	}
	for (const dir of protectedDirs) {
		if (dir && (isWithin(resolved, dir) || isWithin(dir, resolved))) {
			throw isolationError(isolationText.dataDirectoryOverlap(resolved, dir));
		}
	}
	if (isWithin(resolved, canonicalHome) && resolved !== canonicalHome) {
		const first = relative(canonicalHome, resolved).split(sep)[0] ?? "";
		if (/^\.ryu(?:-|$)/.test(first)) {
			throw isolationError(isolationText.insideDataDirectory(resolved));
		}
	}
}

/** Parses and validates one `--mount SRC:DST[:ro|rw]`. The source must exist
 *  and is checked after resolving symlinks, so a link cannot launder a
 *  protected path. */
export async function parseMount(
	raw: string,
	homeDir: string,
	env: Record<string, string | undefined>,
	endpoint?: string
): Promise<ParsedMount> {
	const parts = raw.split(":");
	if (parts.length < 2 || parts.length > 3) {
		throw isolationError(isolationText.mountShape(raw));
	}
	const [source = "", destination = "", mode = "rw"] = parts;
	if (mode !== "ro" && mode !== "rw") {
		throw isolationError(isolationText.mountMode(raw));
	}
	if (!isAbsolute(source)) {
		throw isolationError(isolationText.mountSourceNotAbsolute(raw));
	}
	validateContainerDestination(destination);
	let resolved: string;
	try {
		resolved = await realpath(source);
	} catch {
		throw isolationError(isolationText.mountSourceMissing(raw));
	}
	if (resolved.includes(":")) {
		throw isolationError(isolationText.mountSourceColon(raw));
	}
	try {
		await validateHostSource(resolved, homeDir, env, endpoint);
	} catch (error) {
		throw isolationError(isolationText.mountRefused(raw, reasonOf(error)));
	}
	return { source: resolved, destination, readOnly: mode === "ro" };
}

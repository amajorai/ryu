// `ryu secrets run --broker SVC… --isolation=container -- CMD`: run CMD in a
// Docker container whose only network path is the credential broker.
//
// The run has two phases so nothing is minted for a run that cannot start:
//
// `prepareContainer` (before the broker session exists):
//   1. checks that Docker is local (`unix://` endpoint), reachable, runs Linux
//      containers, and is neither rootless nor `userns-remap` (a rootless
//      daemon's bridge gateways live in another network namespace; a
//      remapped daemon cannot give the command the host user's files);
//   2. validates the working directory and every `--mount` source;
//   3. builds (once, content-hash tagged) the trusted image and, with
//      `--image`, pulls the user's image and pins it by image id.
//
// `runPrepared` (after the session is minted):
//   4. creates a labeled bridge network `ryu-vault-<id>`. It is deliberately
//      not `--internal`: an internal network has no path to the host-side
//      gateway, so the container could not reach the relay;
//   5. starts a TCP relay that dials the broker on 127.0.0.1, so the broker
//      still sees a loopback peer. On Linux it binds the network gateway and
//      accepts only that subnet; on Docker Desktop it binds host loopback,
//      which `host-gateway` reaches, and accepts only loopback peers;
//   6. starts the network-owner container from the trusted image with only
//      NET_ADMIN/NET_RAW, installs the firewall with `docker exec`, and
//      probes the relay through it (fail closed if the path is broken);
//   7. writes the broker CA and the run script (a 0755 directory mounted
//      read-only) and an env file (0600) holding the proxy URL with the
//      session token, so the token never appears in an argv `ps` can show;
//   8. runs the command container in the owner's network namespace with
//      every capability dropped, `no-new-privileges`, the invoking user's
//      uid/gid, a read-only root filesystem, tmpfs `/tmp`, and the working
//      directory at `/workspace`;
//   9. always tears down: both containers, relay, network, temp directory
//      (the caller then revokes the broker session).
//
// A signal guard covers both phases: before the command starts a signal
// cancels setup (in-flight `docker build`/`pull` is killed) and the run
// unwinds through the same teardown; afterwards SIGTERM/SIGHUP are forwarded
// to the container with `docker kill` (SIGINT from a terminal already reaches
// the `docker run` client, which proxies it).
//
// Every Docker call goes through `ContainerHost.docker` (captured output) or
// `ctx.spawn` (the interactive `docker run`), so tests inject fakes.

import { createHash, getRandomValues } from "node:crypto";
import {
	chmod,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { type Forwarder, startForwarder } from "./vaultForwarder.ts";
import {
	CONTAINER_CA_BUNDLE_PATH,
	CONTAINER_CA_PATH,
	CONTAINER_RUNTIME_DIR,
	type ContextFile,
	contextFiles,
	DEFAULT_DOCKERFILE,
	FIREWALL_PATH,
	GATEWAY_HOST,
	ISOLATION_IMAGE_REPO,
	RUN_SCRIPT,
	RUN_SCRIPT_PATH,
} from "./vaultIsolationAssets.ts";

export const NETWORK_PREFIX = "ryu-vault-";
export const ISOLATION_LABEL = "com.ryu.vault-isolation";
const SESSION_LABEL = `${ISOLATION_LABEL}.session`;
/** Suffix of the network-owner container's name. */
export const OWNER_SUFFIX = "-net";
const PRUNE_GRACE_MS = 60_000;
const HASH_LENGTH = 12;
/** uid/gid used when the CLI itself runs as root. */
const NOBODY = 65_534;
/** Owner lifetime when the session expiry is unknown. */
const DEFAULT_OWNER_SECONDS = 86_400;
const KILL_RETRY_MS = 200;
const KILL_RETRIES = 25;

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

export class DockerUnavailableError extends Error {}

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
function throwIfAborted(signal: AbortSignal | undefined): void {
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
		throw new DockerUnavailableError(
			"Container isolation needs Docker, but the `docker` command was not found on PATH."
		);
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

function firstLines(text: string, count = 20): string {
	const lines = text.trim().split("\n");
	return lines.slice(-count).join("\n");
}

const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,254}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

export function validateImageRef(ref: string): string {
	if (!IMAGE_REF.test(ref)) {
		throw new Error(
			`--image ${JSON.stringify(ref)} is not a valid image reference.`
		);
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

// ── Build context (tar on stdin) ─────────────────────────────────────────────

function octal(value: number, width: number): string {
	return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
	for (let index = 0; index < text.length; index++) {
		target[offset + index] = text.charCodeAt(index);
	}
}

/** A minimal deterministic ustar archive (mtime 0, uid/gid 0). */
export function tarArchive(files: ContextFile[]): Uint8Array {
	const encoder = new TextEncoder();
	const blocks: Uint8Array[] = [];
	for (const file of files) {
		const data = encoder.encode(file.content);
		const header = new Uint8Array(512);
		writeAscii(header, 0, file.name);
		writeAscii(header, 100, octal(file.mode, 8));
		writeAscii(header, 108, octal(0, 8));
		writeAscii(header, 116, octal(0, 8));
		writeAscii(header, 124, octal(data.length, 12));
		writeAscii(header, 136, octal(0, 12));
		writeAscii(header, 148, "        ");
		writeAscii(header, 156, "0");
		writeAscii(header, 257, "ustar\0");
		writeAscii(header, 263, "00");
		let checksum = 0;
		for (const byte of header) {
			checksum += byte;
		}
		writeAscii(header, 148, `${checksum.toString(8).padStart(6, "0")}\0 `);
		blocks.push(header);
		const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
		padded.set(data);
		blocks.push(padded);
	}
	blocks.push(new Uint8Array(1024));
	const total = blocks.reduce((sum, block) => sum + block.length, 0);
	const archive = new Uint8Array(total);
	let offset = 0;
	for (const block of blocks) {
		archive.set(block, offset);
		offset += block.length;
	}
	return archive;
}

export function contextHash(files: ContextFile[], extra = ""): string {
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(file.name);
		hash.update("\0");
		hash.update(file.mode.toString(8));
		hash.update("\0");
		hash.update(file.content);
		hash.update("\0");
	}
	hash.update(extra);
	return hash.digest("hex").slice(0, HASH_LENGTH);
}

async function imageId(
	docker: DockerRunner,
	ref: string
): Promise<string | null> {
	const inspected = await docker([
		"image",
		"inspect",
		"--format",
		"{{.Id}}",
		ref,
	]);
	return inspected.exitCode === 0 ? inspected.stdout.trim() : null;
}

export interface IsolationImages {
	/** The image the command runs in: the trusted image or the user's, by id. */
	command: string;
	/** The trusted image that owns the network and installs the firewall. */
	owner: string;
}

/** The trusted image (built on first use from pinned, hashed assets) and the
 *  command image. A user `--image` is never trusted with the firewall: it
 *  only ever runs unprivileged, and is pinned by its image id so a tag that
 *  moves mid-run cannot swap it. */
export async function ensureIsolationImages(
	docker: DockerRunner,
	override: string | undefined,
	err: (text: string) => void,
	abort?: AbortSignal
): Promise<IsolationImages> {
	const files = contextFiles(DEFAULT_DOCKERFILE);
	const owner = `${ISOLATION_IMAGE_REPO}:${contextHash(files)}`;
	if ((await imageId(docker, owner)) === null) {
		err(`ryu: building the isolation image ${owner} (one-time setup)…\n`);
		const result = await docker(
			["build", "-t", owner, "-"],
			tarArchive(files),
			abort
		);
		throwIfAborted(abort);
		if (result.exitCode !== 0) {
			throw new Error(
				`docker build of ${owner} failed:\n${firstLines(`${result.stdout}\n${result.stderr}`)}`
			);
		}
	}
	if (override === undefined) {
		return { owner, command: owner };
	}
	const ref = validateImageRef(override);
	let id = await imageId(docker, ref);
	if (id === null) {
		const pulled = await docker(["pull", ref], undefined, abort);
		throwIfAborted(abort);
		if (pulled.exitCode !== 0) {
			throw new Error(
				`Could not pull ${ref}:\n${firstLines(pulled.stderr || pulled.stdout)}`
			);
		}
		id = await imageId(docker, ref);
	}
	if (id === null || !IMAGE_ID.test(id)) {
		throw new Error(`docker image inspect ${ref} did not return an image id.`);
	}
	return { owner, command: id };
}

// ── Docker daemon checks ─────────────────────────────────────────────────────

export interface DockerInfo {
	/** Docker Desktop (any host OS): the relay binds host loopback. */
	desktop: boolean;
	/** The daemon endpoint the docker CLI talks to (`unix://…`). */
	endpoint: string;
	operatingSystem: string;
	osType: string;
	rootless: boolean;
	userns: boolean;
}

/** Parses `docker info --format '{{.OSType}}|{{.OperatingSystem}}|{{json .SecurityOptions}}'`. */
export function parseDockerInfo(
	stdout: string
): Omit<DockerInfo, "desktop" | "endpoint"> {
	const [osType = "", operatingSystem = "", ...rest] = stdout.trim().split("|");
	const options = rest.join("|");
	return {
		osType: osType.trim(),
		operatingSystem: operatingSystem.trim(),
		rootless: /name=rootless/.test(options),
		userns: /name=userns/.test(options),
	};
}

const DEFAULT_ENDPOINT = "unix:///var/run/docker.sock";

async function dockerEndpoint(
	docker: DockerRunner,
	env: Record<string, string | undefined>
): Promise<string> {
	const inspected = await docker([
		"context",
		"inspect",
		"--format",
		"{{.Endpoints.docker.Host}}",
	]);
	const fromContext = inspected.exitCode === 0 ? inspected.stdout.trim() : "";
	return fromContext || env.DOCKER_HOST || DEFAULT_ENDPOINT;
}

export async function checkDocker(
	docker: DockerRunner,
	platform: string,
	env: Record<string, string | undefined> = {}
): Promise<DockerInfo> {
	if (platform !== "linux" && platform !== "darwin") {
		throw new DockerUnavailableError(
			`Container isolation supports Linux and macOS hosts only (this host is ${platform}).`
		);
	}
	const result = await docker([
		"info",
		"--format",
		"{{.OSType}}|{{.OperatingSystem}}|{{json .SecurityOptions}}",
	]);
	if (result.exitCode !== 0) {
		throw new DockerUnavailableError(
			`The Docker daemon is not reachable: ${firstLines(result.stderr || result.stdout, 3)}\n` +
				"Start Docker (or Docker Desktop) and try again."
		);
	}
	const parsed = parseDockerInfo(result.stdout);
	if (parsed.osType !== "linux") {
		throw new DockerUnavailableError(
			`Container isolation needs Linux containers, but Docker reports '${parsed.osType || "unknown"}'. Switch Docker to Linux containers.`
		);
	}
	const endpoint = await dockerEndpoint(docker, env);
	if (!endpoint.startsWith("unix://")) {
		throw new DockerUnavailableError(
			`Container isolation needs a Docker daemon on this machine, but the docker CLI talks to ${endpoint}. Switch to a local context (unix:// socket).`
		);
	}
	const desktop =
		platform !== "linux" || /docker desktop/i.test(parsed.operatingSystem);
	if (parsed.rootless && !desktop) {
		throw new DockerUnavailableError(
			"Container isolation does not support rootless Docker: its bridge networks live in a separate network namespace, so the host relay cannot reach them. Use a rootful Docker daemon."
		);
	}
	if (parsed.userns && !desktop) {
		throw new DockerUnavailableError(
			"Container isolation does not support a Docker daemon with userns-remap: the command could not use your files in /workspace. Use a daemon without user-namespace remapping."
		);
	}
	return { ...parsed, desktop, endpoint };
}

// ── Networks ─────────────────────────────────────────────────────────────────

export interface IsolationNetwork {
	gateway: string;
	name: string;
	subnet: string;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4ToInt(address: string): number | null {
	const match = IPV4.exec(address);
	if (!match) {
		return null;
	}
	let value = 0;
	for (const part of match.slice(1)) {
		const octet = Number(part);
		if (octet > 255) {
			return null;
		}
		value = value * 256 + octet;
	}
	return value;
}

export function ipv4InCidr(address: string, cidr: string): boolean {
	const [base, bitsText] = cidr.split("/");
	const ip = ipv4ToInt(address);
	const network = ipv4ToInt(base ?? "");
	const bits = Number(bitsText);
	if (ip === null || network === null || !Number.isInteger(bits)) {
		return false;
	}
	if (bits <= 0) {
		return true;
	}
	if (bits > 32) {
		return false;
	}
	const size = 2 ** (32 - bits);
	return Math.floor(ip / size) === Math.floor(network / size);
}

/** Parses `docker network inspect NAME --format '{{json .IPAM.Config}}'`. */
export function parseNetworkConfig(
	name: string,
	stdout: string
): IsolationNetwork {
	let entries: unknown;
	try {
		entries = JSON.parse(stdout.trim() || "null");
	} catch {
		throw new Error(`docker network inspect ${name}: unexpected output`);
	}
	if (Array.isArray(entries)) {
		for (const entry of entries) {
			if (typeof entry !== "object" || entry === null) {
				continue;
			}
			const gateway = Reflect.get(entry, "Gateway");
			const subnet = Reflect.get(entry, "Subnet");
			if (
				typeof gateway === "string" &&
				typeof subnet === "string" &&
				ipv4ToInt(gateway) !== null &&
				ipv4InCidr(gateway, subnet)
			) {
				return { name, gateway, subnet };
			}
		}
	}
	throw new Error(`docker network inspect ${name}: no IPv4 gateway`);
}

export async function createIsolationNetwork(
	docker: DockerRunner,
	id: string
): Promise<IsolationNetwork> {
	const name = `${NETWORK_PREFIX}${id}`;
	const created = await docker([
		"network",
		"create",
		"--driver",
		"bridge",
		"--label",
		`${ISOLATION_LABEL}=1`,
		"--label",
		`${SESSION_LABEL}=${id}`,
		name,
	]);
	if (created.exitCode !== 0) {
		throw new Error(
			`docker network create ${name} failed: ${firstLines(created.stderr, 3)}`
		);
	}
	try {
		const inspected = await docker([
			"network",
			"inspect",
			name,
			"--format",
			"{{json .IPAM.Config}}",
		]);
		if (inspected.exitCode !== 0) {
			throw new Error(
				`docker network inspect ${name} failed: ${firstLines(inspected.stderr, 3)}`
			);
		}
		return parseNetworkConfig(name, inspected.stdout);
	} catch (error) {
		await docker(["network", "rm", name]).catch(() => undefined);
		throw error;
	}
}

export type StaleNetwork = "empty" | "owner-only" | null;

/** Classifies a labeled isolation network created before `cutoffMs` from
 *  `docker network inspect --format '{{json .}}'`: `empty` (no containers),
 *  `owner-only` (only its network-owner container, whose command container
 *  may be gone), or `null` (keep). The command container joins through the
 *  owner's namespace, so it never shows up in the network's container list. */
export function classifyStaleNetwork(
	stdout: string,
	cutoffMs: number
): StaleNetwork {
	let info: unknown;
	try {
		info = JSON.parse(stdout);
	} catch {
		return null;
	}
	if (typeof info !== "object" || info === null) {
		return null;
	}
	const created = Reflect.get(info, "Created");
	const name = Reflect.get(info, "Name");
	if (typeof created !== "string") {
		return null;
	}
	// Docker prints nanoseconds; keep milliseconds for Date.parse.
	const createdMs = Date.parse(created.replace(/(\.\d{3})\d+/, "$1"));
	if (!(Number.isFinite(createdMs) && createdMs < cutoffMs)) {
		return null;
	}
	const containers = Reflect.get(info, "Containers");
	const entries =
		typeof containers === "object" && containers !== null
			? Object.values(containers)
			: [];
	if (entries.length === 0) {
		return "empty";
	}
	const ownerName = `${typeof name === "string" ? name : ""}${OWNER_SUFFIX}`;
	const onlyOwner = entries.every(
		(entry) =>
			typeof entry === "object" &&
			entry !== null &&
			Reflect.get(entry, "Name") === ownerName
	);
	return onlyOwner ? "owner-only" : null;
}

/** True for a labeled isolation network with no containers, created before
 *  `cutoffMs`. */
export function isStaleNetwork(stdout: string, cutoffMs: number): boolean {
	return classifyStaleNetwork(stdout, cutoffMs) === "empty";
}

/** Best-effort removal of isolation networks (and orphaned network owners)
 *  leaked by crashed runs. The grace period keeps a concurrent run's fresh
 *  network alive until its command container starts. */
export async function pruneStaleNetworks(
	docker: DockerRunner,
	nowMs: number
): Promise<void> {
	const listed = await docker([
		"network",
		"ls",
		"--filter",
		`label=${ISOLATION_LABEL}=1`,
		"--format",
		"{{.Name}}",
	]);
	if (listed.exitCode !== 0) {
		return;
	}
	for (const name of listed.stdout.split(/\s+/)) {
		if (!name.startsWith(NETWORK_PREFIX)) {
			continue;
		}
		const inspected = await docker([
			"network",
			"inspect",
			name,
			"--format",
			"{{json .}}",
		]);
		if (inspected.exitCode !== 0) {
			continue;
		}
		const stale = classifyStaleNetwork(
			inspected.stdout,
			nowMs - PRUNE_GRACE_MS
		);
		if (stale === "owner-only") {
			// The command container shares the network's name; when it is gone
			// the owner only holds a dead run's namespace.
			const command = await docker(["container", "inspect", name]);
			if (command.exitCode === 0) {
				continue;
			}
			await docker(["rm", "-f", `${name}${OWNER_SUFFIX}`]);
		}
		if (stale !== null) {
			await docker(["network", "rm", name]);
		}
	}
}

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
		throw new Error(
			`--mount destination ${destination} must be an absolute path.`
		);
	}
	if (
		posix.normalize(destination) !== destination ||
		(destination !== "/" && destination.endsWith("/"))
	) {
		throw new Error(
			`--mount destination ${destination} must be a normalized path without '..' or a trailing '/'.`
		);
	}
	for (const reserved of RESERVED_CONTAINER_PATHS) {
		const prefix = reserved === "/" ? "/" : `${reserved}/`;
		if (
			destination === reserved ||
			(reserved !== "/" && destination.startsWith(prefix)) ||
			reserved.startsWith(`${destination}/`)
		) {
			throw new Error(
				`--mount: refusing to mount over the reserved container path ${reserved}.`
			);
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
		throw new Error("refusing to mount the host root filesystem.");
	}
	// colima keeps one directory per profile (~/.colima/<profile>/docker.sock).
	if (isWithin(resolved, join(homeDir, ".colima"))) {
		throw new Error(
			`refusing to mount ${resolved}: it can expose a container runtime socket.`
		);
	}
	for (const socket of await controlSockets(homeDir, env, endpoint)) {
		if (isWithin(socket, resolved)) {
			throw new Error(
				`refusing to mount ${resolved}: it exposes the container runtime socket ${socket}.`
			);
		}
	}
	const info = await stat(resolved);
	if (info.isSocket()) {
		throw new Error(`refusing to mount the Unix socket ${resolved}.`);
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
			throw new Error(
				`refusing to mount ${resolved}: it overlaps the Ryu data directory ${dir}.`
			);
		}
	}
	if (isWithin(resolved, canonicalHome) && resolved !== canonicalHome) {
		const first = relative(canonicalHome, resolved).split(sep)[0] ?? "";
		if (/^\.ryu(?:-|$)/.test(first)) {
			throw new Error(
				`refusing to mount ${resolved}: it is inside a Ryu data directory.`
			);
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
		throw new Error(`--mount ${raw}: expected SRC:DST[:ro|rw].`);
	}
	const [source = "", destination = "", mode = "rw"] = parts;
	if (mode !== "ro" && mode !== "rw") {
		throw new Error(`--mount ${raw}: the mode must be 'ro' or 'rw'.`);
	}
	if (!isAbsolute(source)) {
		throw new Error(`--mount ${raw}: the source must be an absolute path.`);
	}
	validateContainerDestination(destination);
	let resolved: string;
	try {
		resolved = await realpath(source);
	} catch {
		throw new Error(`--mount ${raw}: the source does not exist.`);
	}
	if (resolved.includes(":")) {
		throw new Error(`--mount ${raw}: the resolved source contains ':'.`);
	}
	try {
		await validateHostSource(resolved, homeDir, env, endpoint);
	} catch (error) {
		throw new Error(
			`--mount ${raw}: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	return { source: resolved, destination, readOnly: mode === "ro" };
}

// ── Container environment and argv ───────────────────────────────────────────

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The command's whole environment (plus the image's own `PATH`). Nothing is
 *  inherited from the host. */
export function buildContainerEnv(options: {
	port: number;
	token: string;
}): Record<string, string> {
	const proxy = `http://rvb:${encodeURIComponent(options.token)}@${GATEWAY_HOST}:${options.port}`;
	const env: Record<string, string> = {};
	for (const name of [
		"HTTPS_PROXY",
		"HTTP_PROXY",
		"https_proxy",
		"http_proxy",
	]) {
		env[name] = proxy;
	}
	// Empty: even "local" names must go through the proxy, the only route out.
	env.NO_PROXY = "";
	env.no_proxy = "";
	env.NODE_USE_ENV_PROXY = "1";
	env.NODE_EXTRA_CA_CERTS = CONTAINER_CA_PATH;
	env.DENO_CERT = CONTAINER_CA_PATH;
	for (const name of [
		"SSL_CERT_FILE",
		"REQUESTS_CA_BUNDLE",
		"CURL_CA_BUNDLE",
		"GIT_SSL_CAINFO",
	]) {
		env[name] = CONTAINER_CA_BUNDLE_PATH;
	}
	env.HOME = "/tmp/home";
	return env;
}

/** Renders a `docker run --env-file` body (`KEY=VALUE` lines, taken literally). */
export function renderEnvFile(env: Record<string, string>): string {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(env)) {
		if (!ENV_KEY.test(key)) {
			throw new Error(`invalid container environment name ${key}`);
		}
		if (/[\r\n\0]/.test(value)) {
			throw new Error(
				`container environment value for ${key} contains a newline`
			);
		}
		lines.push(`${key}=${value}`);
	}
	return `${lines.join("\n")}\n`;
}

export interface OwnerArgsConfig {
	/** `--add-host` target: the gateway IP, or `host-gateway` on Docker Desktop. */
	gatewayAddress: string;
	image: string;
	/** Seconds the owner sleeps; it must outlive the command container. */
	lifetimeSeconds: number;
	name: string;
	network: string;
}

/** `docker run` argv for the network owner: the trusted image, detached,
 *  holding only the firewall capabilities. Pure. */
export function buildOwnerArgs(config: OwnerArgsConfig): string[] {
	if (!config.network.startsWith(NETWORK_PREFIX)) {
		throw new Error("the owner must run on its per-invocation network");
	}
	if (!config.image.startsWith(`${ISOLATION_IMAGE_REPO}:`)) {
		throw new Error("the network owner must run the trusted isolation image");
	}
	const args = [
		"run",
		"-d",
		"--rm",
		"--name",
		`${config.name}${OWNER_SUFFIX}`,
		"--label",
		`${ISOLATION_LABEL}=1`,
		"--network",
		config.network,
		"--cap-drop",
		"ALL",
	];
	for (const capability of FIREWALL_CAPABILITIES) {
		args.push("--cap-add", capability);
	}
	args.push(
		"--security-opt",
		"no-new-privileges",
		"--read-only",
		"--tmpfs",
		"/run:rw,nosuid,nodev,mode=0755",
		"--add-host",
		`${GATEWAY_HOST}:${config.gatewayAddress}`,
		"--entrypoint",
		"sleep",
		config.image,
		String(Math.max(1, Math.floor(config.lifetimeSeconds)))
	);
	return args;
}

export interface RunArgsConfig {
	command: string[];
	envFile: string;
	gid: number;
	image: string;
	mounts: ParsedMount[];
	name: string;
	/** Host directory mounted read-only at `CONTAINER_RUNTIME_DIR`. */
	runtimeDir: string;
	tty: boolean;
	uid: number;
	workDir: string;
}

/** The command container's `docker run` argv. Pure; carries no secret (the
 *  token is in the env file) and no capability. */
export function buildRunArgs(config: RunArgsConfig): string[] {
	if (config.command.length === 0) {
		throw new Error("container isolation needs a command to run");
	}
	if (!config.name.startsWith(NETWORK_PREFIX)) {
		throw new Error("the container must run on its per-invocation network");
	}
	const args = ["run", "--rm", "-i"];
	if (config.tty) {
		args.push("-t");
	}
	args.push(
		"--init",
		"--name",
		config.name,
		"--label",
		`${ISOLATION_LABEL}=1`,
		// Joining the owner's namespace also shares its /etc/hosts (Docker
		// points a `container:` member at the owner's hosts/resolv files), so
		// the owner's `--add-host` entry resolves `GATEWAY_HOST` here too;
		// `--add-host` itself is rejected in this mode.
		"--network",
		`container:${config.name}${OWNER_SUFFIX}`,
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		"--user",
		`${config.uid}:${config.gid}`,
		"--read-only",
		"--tmpfs",
		"/tmp:rw,nosuid,nodev,mode=1777",
		"--env-file",
		config.envFile,
		"-v",
		`${config.workDir}:/workspace`,
		"-v",
		`${config.runtimeDir}:${CONTAINER_RUNTIME_DIR}:ro`
	);
	for (const mount of config.mounts) {
		args.push(
			"-v",
			`${mount.source}:${mount.destination}${mount.readOnly ? ":ro" : ""}`
		);
	}
	args.push(
		"-w",
		"/workspace",
		"--entrypoint",
		"/bin/sh",
		config.image,
		RUN_SCRIPT_PATH,
		...config.command
	);
	return args;
}

// ── Orchestration ────────────────────────────────────────────────────────────

export interface ContainerContext {
	err: (text: string) => void;
	guard: SignalGuard;
	host: ContainerHost;
}

export interface PrepareRequest {
	/** The CLI's environment (`DOCKER_HOST`, `RYU_DIR`); never the container's. */
	env: Record<string, string | undefined>;
	image?: string;
	mounts: string[];
}

export interface PreparedContainer {
	desktop: boolean;
	gid: number;
	images: IsolationImages;
	mounts: ParsedMount[];
	uid: number;
	workDir: string;
}

/** Everything that needs no broker session: Docker checks, host-path
 *  validation, and images. Creates nothing a failed run must clean up. */
export async function prepareContainer(
	ctx: ContainerContext,
	request: PrepareRequest
): Promise<PreparedContainer> {
	const { host, guard } = ctx;
	const { docker } = host;
	const info = await checkDocker(docker, host.platform, request.env);
	guard.throwIfCancelled();

	const workDir = await realpath(host.cwd());
	await validateHostSource(
		workDir,
		host.homeDir,
		request.env,
		info.endpoint
	).catch((error: Error) => {
		throw new Error(`working directory: ${error.message}`);
	});
	if (workDir.includes(":")) {
		throw new Error("the working directory path contains ':'.");
	}
	const mounts: ParsedMount[] = [];
	for (const raw of request.mounts) {
		mounts.push(
			await parseMount(raw, host.homeDir, request.env, info.endpoint)
		);
	}

	await pruneStaleNetworks(docker, Date.now()).catch(() => undefined);
	guard.throwIfCancelled();
	const images = await ensureIsolationImages(
		docker,
		request.image,
		ctx.err,
		guard.abort
	);
	guard.throwIfCancelled();

	let uid = host.uid;
	let gid = host.gid;
	if (uid === 0) {
		ctx.err("ryu: running as root; the container command runs as uid 65534.\n");
		uid = NOBODY;
		gid = NOBODY;
	}
	return { desktop: info.desktop, gid, images, mounts, uid, workDir };
}

export interface ContainerRunRequest {
	/** Loopback port of the broker on this host. */
	brokerPort: number;
	caPem: string;
	command: string[];
	/** Environment for the `docker` CLI process itself (never the container). */
	dockerEnv: Record<string, string>;
	/** Session expiry; the network owner outlives it by a minute. */
	expiresAt?: string | number;
	token: string;
}

export interface ContainerRunContext extends ContainerContext {
	spawn: (cmd: string[], env: Record<string, string>) => Promise<number>;
}

async function dockerOrThrow(
	docker: DockerRunner,
	args: string[],
	what: string
): Promise<DockerCapture> {
	const result = await docker(args);
	if (result.exitCode !== 0) {
		throw new Error(
			`${what} failed:\n${firstLines(`${result.stdout}\n${result.stderr}`, 6)}`
		);
	}
	return result;
}

/** Sends `signal` to the command container. A kill that lands before
 *  `docker run` has created the container is retried until it exists or the
 *  run ends. */
function containerSignaller(
	docker: DockerRunner,
	name: string,
	isRunning: () => boolean
): (signal: string) => void {
	const send = (signal: string, attempt: number): void => {
		docker(["kill", "--signal", signal, name])
			.then((result) => {
				if (result.exitCode !== 0 && attempt < KILL_RETRIES && isRunning()) {
					setTimeout(() => send(signal, attempt + 1), KILL_RETRY_MS);
				}
			})
			.catch(() => undefined);
	};
	return (signal) => {
		// A terminal Ctrl-C already reaches the `docker run` client (same
		// process group), which proxies it; forwarding it too would deliver
		// SIGINT twice.
		if (signal !== "SIGINT") {
			send(signal, 0);
		}
	};
}

/** Runs the prepared command in an isolated container and resolves to its
 *  exit code. Every resource it creates is released before it returns or
 *  throws; the caller revokes the session afterwards. */
export async function runPrepared(
	ctx: ContainerRunContext,
	prepared: PreparedContainer,
	request: ContainerRunRequest
): Promise<number> {
	const { host, guard } = ctx;
	const { docker } = host;
	const id = newIsolationId();
	const name = `${NETWORK_PREFIX}${id}`;
	const ownerName = `${name}${OWNER_SUFFIX}`;

	let tempDir: string | null = null;
	let network: IsolationNetwork | null = null;
	let forwarder: Forwarder | null = null;
	let ownerStarted = false;
	let started = false;
	let running = false;
	try {
		guard.throwIfCancelled();
		tempDir = await mkdtemp(join(host.tmpDir, "ryu-vault-isolation-"));
		await chmod(tempDir, 0o700);
		// The runtime directory holds no secret: 0755/0644 so the unprivileged
		// command user can read the bind mount.
		const runtimeDir = join(tempDir, "runtime");
		await mkdir(runtimeDir);
		await chmod(runtimeDir, 0o755);
		await writeFile(join(runtimeDir, "ca.pem"), request.caPem, { mode: 0o644 });
		await chmod(join(runtimeDir, "ca.pem"), 0o644);
		await writeFile(join(runtimeDir, "run.sh"), RUN_SCRIPT, { mode: 0o755 });
		await chmod(join(runtimeDir, "run.sh"), 0o755);

		network = await createIsolationNetwork(docker, id);
		guard.throwIfCancelled();
		const subnet = network.subnet;
		forwarder = await startForwarder(
			prepared.desktop
				? {
						bindHost: "127.0.0.1",
						upstreamPort: request.brokerPort,
						allowPeer: (peer) => ipv4InCidr(peer, "127.0.0.0/8"),
					}
				: {
						bindHost: network.gateway,
						upstreamPort: request.brokerPort,
						allowPeer: (peer) => ipv4InCidr(peer, subnet),
					}
		);
		const port = forwarder.port;

		ownerStarted = true;
		await dockerOrThrow(
			docker,
			buildOwnerArgs({
				gatewayAddress: prepared.desktop ? "host-gateway" : network.gateway,
				image: prepared.images.owner,
				lifetimeSeconds: ownerLifetimeSeconds(request.expiresAt, Date.now()),
				name,
				network: network.name,
			}),
			"starting the isolation network owner"
		);
		guard.throwIfCancelled();
		await dockerOrThrow(
			docker,
			[
				"exec",
				"-e",
				`RYU_VAULT_FORWARD_PORT=${port}`,
				ownerName,
				FIREWALL_PATH,
			],
			"installing the container firewall"
		);
		const probe = await docker([
			"exec",
			ownerName,
			"timeout",
			"5",
			"bash",
			"-c",
			'exec 3<>"/dev/tcp/$0/$1"',
			GATEWAY_HOST,
			String(port),
		]);
		if (probe.exitCode !== 0) {
			throw new Error(
				prepared.desktop
					? "The isolated container could not reach the relay on this host's loopback interface through Docker Desktop's host-gateway."
					: `The isolated container could not reach the relay at ${network.gateway}:${port}. A host firewall must let containers on ${network.subnet} reach that address.`
			);
		}
		guard.throwIfCancelled();

		const envFile = join(tempDir, "container.env");
		await writeFile(
			envFile,
			renderEnvFile(buildContainerEnv({ token: request.token, port })),
			{ mode: 0o600 }
		);
		await chmod(envFile, 0o600);

		const args = buildRunArgs({
			command: request.command,
			envFile,
			gid: prepared.gid,
			image: prepared.images.command,
			mounts: prepared.mounts,
			name,
			runtimeDir,
			tty: host.isTty,
			uid: prepared.uid,
			workDir: prepared.workDir,
		});
		guard.throwIfCancelled();
		started = true;
		running = true;
		guard.forwardTo(containerSignaller(docker, name, () => running));
		ctx.err(
			`ryu: running ${request.command[0]} in an isolated container (${network.name}); network access only through the credential broker.\n`
		);
		return await ctx.spawn(["docker", ...args], request.dockerEnv);
	} finally {
		running = false;
		guard.forwardTo(null);
		if (started) {
			await docker(["rm", "-f", name]).catch(() => undefined);
		}
		if (ownerStarted) {
			await docker(["rm", "-f", ownerName]).catch(() => undefined);
		}
		await forwarder?.close();
		if (network) {
			await docker(["network", "rm", network.name]).catch(() => undefined);
		}
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true });
		}
	}
}

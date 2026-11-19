// The trusted image build context (tar on stdin), image pins, and the
// Docker daemon checks that run before anything is minted. Split from
// `vaultIsolation.ts`, which re-exports the public names.

import { createHash } from "node:crypto";
import {
	type DockerRunner,
	DockerUnavailableError,
	firstLines,
	HASH_LENGTH,
	IMAGE_ID,
	throwIfAborted,
	validateImageRef,
} from "./vaultIsolation-host.ts";
import { isolationError, isolationText } from "./vaultIsolation-messages.ts";
import {
	type ContextFile,
	contextFiles,
	DEFAULT_DOCKERFILE,
	ISOLATION_IMAGE_REPO,
} from "./vaultIsolationAssets.ts";

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
			throw isolationError(
				isolationText.pullFailed(
					ref,
					firstLines(pulled.stderr || pulled.stdout)
				)
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
		throw new DockerUnavailableError(isolationText.unsupportedHost(platform));
	}
	const result = await docker([
		"info",
		"--format",
		"{{.OSType}}|{{.OperatingSystem}}|{{json .SecurityOptions}}",
	]);
	if (result.exitCode !== 0) {
		throw new DockerUnavailableError(
			isolationText.daemonUnreachable(
				firstLines(result.stderr || result.stdout, 3)
			)
		);
	}
	const parsed = parseDockerInfo(result.stdout);
	if (parsed.osType !== "linux") {
		throw new DockerUnavailableError(
			isolationText.notLinuxContainers(parsed.osType || "unknown")
		);
	}
	const endpoint = await dockerEndpoint(docker, env);
	if (!endpoint.startsWith("unix://")) {
		throw new DockerUnavailableError(isolationText.remoteDaemon(endpoint));
	}
	const desktop =
		platform !== "linux" || /docker desktop/i.test(parsed.operatingSystem);
	if (parsed.rootless && !desktop) {
		throw new DockerUnavailableError(isolationText.rootless());
	}
	if (parsed.userns && !desktop) {
		throw new DockerUnavailableError(isolationText.usernsRemap());
	}
	return { ...parsed, desktop, endpoint };
}

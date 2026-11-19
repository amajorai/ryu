// `ryu-cli secrets run --isolation=container`: Docker output parsing, stale
// network pruning, the image build context and the host relay over real
// loopback sockets, with a fake Docker runner. Nothing here starts a container.

import { afterEach, expect, test } from "bun:test";
import { startForwarder } from "../cli/vaultForwarder.ts";
import {
	checkDocker,
	classifyStaleNetwork,
	contextHash,
	ensureIsolationImages,
	ipv4InCidr,
	isStaleNetwork,
	pruneStaleNetworks,
	tarArchive,
} from "../cli/vaultIsolation.ts";
import {
	contextFiles,
	DEFAULT_DOCKERFILE,
	FIREWALL_SCRIPT,
} from "../cli/vaultIsolationAssets.ts";
import {
	echoServer,
	exchange,
	fakeDocker,
	removeTempDirs,
} from "./vault-isolation-fixture.ts";

afterEach(removeTempDirs);

function dockerDaemon(info: string, endpoint = "unix:///var/run/docker.sock") {
	return fakeDocker((args) => {
		if (args[0] === "info") {
			return { stdout: info };
		}
		if (args[0] === "context") {
			return { stdout: `${endpoint}\n` };
		}
		return {};
	});
}

test("checkDocker explains a missing daemon, Windows containers, rootless, userns, remote daemons, and hosts", async () => {
	const down = fakeDocker(() => ({
		exitCode: 1,
		stderr:
			"Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
	}));
	await expect(checkDocker(down.docker, "linux")).rejects.toThrow(
		/not reachable: Cannot connect/
	);
	await expect(
		checkDocker(dockerDaemon("windows|Windows|[]").docker, "darwin")
	).rejects.toThrow(/Linux containers/);
	await expect(
		checkDocker(dockerDaemon('linux|Ubuntu|["name=rootless"]').docker, "linux")
	).rejects.toThrow(/rootless/);
	await expect(
		checkDocker(dockerDaemon('linux|Ubuntu|["name=userns"]').docker, "linux")
	).rejects.toThrow(/userns-remap/);
	await expect(
		checkDocker(
			dockerDaemon("linux|Ubuntu|[]", "tcp://10.0.0.5:2376").docker,
			"linux"
		)
	).rejects.toThrow(/local context/);
	await expect(
		checkDocker(
			dockerDaemon("linux|Ubuntu|[]", "ssh://build-box").docker,
			"darwin"
		)
	).rejects.toThrow(/local context/);
	const fine = dockerDaemon("linux|Ubuntu 24.04|[]");
	await expect(checkDocker(fine.docker, "win32")).rejects.toThrow(
		/Linux and macOS/
	);
	const info = await checkDocker(fine.docker, "linux");
	expect(info).toMatchObject({
		osType: "linux",
		desktop: false,
		endpoint: "unix:///var/run/docker.sock",
	});
	expect(fine.calls).toEqual([
		[
			"info",
			"--format",
			"{{.OSType}}|{{.OperatingSystem}}|{{json .SecurityOptions}}",
		],
		["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
	]);
	// Docker Desktop on Linux takes the Desktop path, as on macOS.
	expect(
		(
			await checkDocker(
				dockerDaemon(
					"linux|Docker Desktop|[]",
					"unix:///home/u/.docker/desktop/docker.sock"
				).docker,
				"linux"
			)
		).desktop
	).toBe(true);
	expect((await checkDocker(fine.docker, "darwin")).desktop).toBe(true);
	// Without contexts, DOCKER_HOST (or the default socket) is the endpoint.
	const noContext = fakeDocker((args) =>
		args[0] === "info" ? { stdout: "linux|Ubuntu|[]" } : { exitCode: 1 }
	);
	await expect(
		checkDocker(noContext.docker, "linux", { DOCKER_HOST: "tcp://h:2375" })
	).rejects.toThrow(/local context/);
	expect((await checkDocker(noContext.docker, "linux", {})).endpoint).toBe(
		"unix:///var/run/docker.sock"
	);
});

test("stale isolation networks are pruned after the grace period only", async () => {
	const now = Date.parse("2026-10-15T12:00:00Z");
	expect(
		isStaleNetwork(
			'{"Created":"2026-10-15T11:00:00.123456789Z","Containers":{}}',
			now - 60_000
		)
	).toBe(true);
	expect(
		isStaleNetwork(
			'{"Created":"2026-10-15T11:59:30.1Z","Containers":{}}',
			now - 60_000
		)
	).toBe(false);
	expect(
		isStaleNetwork(
			'{"Created":"2026-10-15T11:00:00Z","Containers":{"abc":{}}}',
			now - 60_000
		)
	).toBe(false);
	const ownerOnly = (name: string) =>
		`{"Name":"${name}","Created":"2026-10-15T10:00:00Z","Containers":{"c1":{"Name":"${name}-net"}}}`;
	expect(classifyStaleNetwork(ownerOnly("ryu-vault-a"), now - 60_000)).toBe(
		"owner-only"
	);
	expect(
		classifyStaleNetwork(
			'{"Name":"ryu-vault-a","Created":"2026-10-15T10:00:00Z","Containers":{"c1":{"Name":"other"}}}',
			now - 60_000
		)
	).toBe(null);
	const docker = fakeDocker((args) => {
		if (args[1] === "ls") {
			return {
				stdout:
					"ryu-vault-old\nryu-vault-new\nryu-vault-orphan\nryu-vault-live\nother-ryu-vault-x\n",
			};
		}
		if (args[0] === "network" && args[1] === "inspect") {
			const name = args[2] ?? "";
			if (name === "ryu-vault-old") {
				return { stdout: '{"Created":"2026-10-15T10:00:00Z","Containers":{}}' };
			}
			if (name === "ryu-vault-orphan" || name === "ryu-vault-live") {
				return { stdout: ownerOnly(name) };
			}
			return { stdout: '{"Created":"2026-10-15T11:59:59Z","Containers":{}}' };
		}
		if (args[0] === "container" && args[1] === "inspect") {
			// The live run's command container still exists.
			return { exitCode: args[2] === "ryu-vault-live" ? 0 : 1 };
		}
		return {};
	});
	await pruneStaleNetworks(docker.docker, now);
	expect(
		docker.calls.filter((call) => call[1] === "rm" || call[0] === "rm")
	).toEqual([
		["network", "rm", "ryu-vault-old"],
		["rm", "-f", "ryu-vault-orphan-net"],
		["network", "rm", "ryu-vault-orphan"],
	]);
	expect(docker.calls.some((call) => call.includes("other-ryu-vault-x"))).toBe(
		false
	);
});

// ── image ────────────────────────────────────────────────────────────────────

interface TarEntry {
	body: string;
	checksumOk: boolean;
	magic: string;
	mode: number;
}

function tarEntries(archive: Uint8Array): Map<string, TarEntry> {
	const entries = new Map<string, TarEntry>();
	const decoder = new TextDecoder();
	let offset = 0;
	while (offset + 512 <= archive.length) {
		const header = archive.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) {
			break;
		}
		const field = (start: number, length: number) =>
			decoder
				.decode(header.subarray(start, start + length))
				.replace(/\0.*$/s, "");
		let sum = 0;
		for (let index = 0; index < 512; index++) {
			sum += index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
		}
		const size = Number.parseInt(field(124, 12), 8);
		const body = decoder.decode(
			archive.subarray(offset + 512, offset + 512 + size)
		);
		entries.set(field(0, 100), {
			mode: Number.parseInt(field(100, 8), 8),
			body,
			checksumOk: Number.parseInt(field(148, 8).trim(), 8) === sum,
			magic: field(257, 6),
		});
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	return entries;
}

test("the build context is a valid tar with executable scripts", () => {
	const entries = tarEntries(tarArchive(contextFiles(DEFAULT_DOCKERFILE)));
	expect([...entries.keys()]).toEqual(["Dockerfile", "ryu-init-firewall.sh"]);
	for (const entry of entries.values()) {
		expect(entry.checksumOk).toBe(true);
		expect(entry.magic).toBe("ustar");
	}
	expect(entries.get("Dockerfile")?.body).toBe(DEFAULT_DOCKERFILE);
	expect(entries.get("ryu-init-firewall.sh")?.mode).toBe(0o755);
	expect(entries.get("ryu-init-firewall.sh")?.body).toBe(FIREWALL_SCRIPT);
});

const USER_IMAGE_ID = `sha256:${"ab".repeat(32)}`;

test("the trusted image is built once per asset hash; a user image is pinned by id and never rebuilt", async () => {
	const tag = `ryu-vault-isolation:${contextHash(contextFiles(DEFAULT_DOCKERFILE))}`;
	const cached = fakeDocker(() => ({ stdout: "sha256:x" }));
	expect(
		await ensureIsolationImages(cached.docker, undefined, () => undefined)
	).toEqual({ owner: tag, command: tag });
	expect(cached.calls.some((call) => call[0] === "build")).toBe(false);

	const missing = fakeDocker((args) => ({
		exitCode: args[0] === "image" ? 1 : 0,
	}));
	let notice = "";
	await ensureIsolationImages(missing.docker, undefined, (text) => {
		notice += text;
	});
	expect(notice).toContain("one-time setup");
	const buildIndex = missing.calls.findIndex((call) => call[0] === "build");
	expect(missing.calls[buildIndex]).toEqual(["build", "-t", tag, "-"]);
	expect(missing.stdins[buildIndex]?.length).toBeGreaterThan(1024);

	let inspections = 0;
	const custom = fakeDocker((args) => {
		if (args[0] === "image" && args.at(-1) === "node:22-bookworm") {
			inspections++;
			return inspections === 1
				? { exitCode: 1 }
				: { stdout: `${USER_IMAGE_ID}\n` };
		}
		return { stdout: "sha256:trusted" };
	});
	const images = await ensureIsolationImages(
		custom.docker,
		"node:22-bookworm",
		() => undefined
	);
	expect(images).toEqual({ owner: tag, command: USER_IMAGE_ID });
	expect(
		custom.calls.some((call) => call.join(" ") === "pull node:22-bookworm")
	).toBe(true);
	// The user image is never layered or built: it runs unprivileged as-is.
	expect(custom.calls.some((call) => call[0] === "build")).toBe(false);

	const noId = fakeDocker(() => ({ stdout: "not-an-id" }));
	await expect(
		ensureIsolationImages(noId.docker, "node:22", () => undefined)
	).rejects.toThrow(/image id/);
	await expect(
		ensureIsolationImages(custom.docker, "evil\nRUN curl x", () => undefined)
	).rejects.toThrow(/not a valid image reference/);
});

// ── relay ────────────────────────────────────────────────────────────────────

test("the relay pipes bytes to the loopback broker and honours the peer filter", async () => {
	const upstream = await echoServer();
	const upstreamPort = upstream.port;
	try {
		const relay = await startForwarder({
			bindHost: "127.0.0.1",
			upstreamPort,
			allowPeer: (peer) => ipv4InCidr(peer, "127.0.0.0/8"),
		});
		expect(relay.port).toBeGreaterThan(0);
		expect(relay.port).not.toBe(upstreamPort);
		expect(await exchange(relay.port, "CONNECT api.example:443")).toBe(
			"echo:CONNECT api.example:443"
		);
		await relay.close();
		await relay.close();

		const strict = await startForwarder({
			bindHost: "127.0.0.1",
			upstreamPort,
			allowPeer: (peer) => ipv4InCidr(peer, "172.18.0.0/16"),
		});
		expect(await exchange(strict.port, "hello")).toBe("");
		await strict.close();
	} finally {
		await new Promise<void>((resolve) =>
			upstream.server.close(() => resolve())
		);
	}
});

// ── end-to-end orchestration ─────────────────────────────────────────────────

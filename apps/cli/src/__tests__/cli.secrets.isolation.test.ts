// `ryu secrets run --broker … --isolation=container`: pure argv/env/mount
// builders, the host relay over real loopback sockets, Docker output parsing,
// and end-to-end orchestration with a fake Docker runner and a fake node. No
// Docker daemon is needed; nothing here starts a container.

import { afterEach, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { runCli } from "../cli/dispatch.ts";
import type { CliIO, CoreApi } from "../cli/types.ts";
import { startForwarder } from "../cli/vaultForwarder.ts";
import {
	buildContainerEnv,
	buildOwnerArgs,
	buildRunArgs,
	type ContainerHost,
	checkDocker,
	classifyStaleNetwork,
	contextHash,
	controlSockets,
	type DockerCapture,
	type DockerRunner,
	ensureIsolationImages,
	FIREWALL_CAPABILITIES,
	ipv4InCidr,
	isStaleNetwork,
	ownerLifetimeSeconds,
	parseDockerInfo,
	parseMount,
	parseNetworkConfig,
	pruneStaleNetworks,
	type RunArgsConfig,
	renderEnvFile,
	tarArchive,
	validateContainerDestination,
	validateHostSource,
} from "../cli/vaultIsolation.ts";
import {
	BASE_IMAGE,
	CONTAINER_CA_BUNDLE_PATH,
	CONTAINER_CA_PATH,
	CONTAINER_RUNTIME_DIR,
	contextFiles,
	DEFAULT_DOCKERFILE,
	FIREWALL_PATH,
	FIREWALL_SCRIPT,
	RUN_SCRIPT,
	RUN_SCRIPT_PATH,
} from "../cli/vaultIsolationAssets.ts";

const TOKEN = "rvb_session_secret";
const tempDirs: string[] = [];

async function tempDir(prefix = "ryu-iso-test-"): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

function runConfig(overrides: Partial<RunArgsConfig> = {}): RunArgsConfig {
	return {
		command: ["python", "agent.py"],
		envFile: "/tmp/x/container.env",
		gid: 100,
		image: "sha256:abc",
		mounts: [],
		name: "ryu-vault-0011223344556677",
		runtimeDir: "/tmp/x/runtime",
		tty: false,
		uid: 1000,
		workDir: "/home/dev/project",
		...overrides,
	};
}

function valuesOf(args: string[], name: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < args.length; index++) {
		if (args[index] === name) {
			values.push(args[index + 1] ?? "");
		}
	}
	return values;
}

// ── argv builder ─────────────────────────────────────────────────────────────

test("the command container has no capability and shares the owner's network namespace", () => {
	const args = buildRunArgs(
		runConfig({
			mounts: [{ source: "/srv/data", destination: "/data", readOnly: true }],
			tty: true,
		})
	);
	expect(args.slice(0, 4)).toEqual(["run", "--rm", "-i", "-t"]);
	expect(valuesOf(args, "--cap-drop")).toEqual(["ALL"]);
	expect(valuesOf(args, "--cap-add")).toEqual([]);
	expect(valuesOf(args, "--security-opt")).toEqual(["no-new-privileges"]);
	expect(valuesOf(args, "--user")).toEqual(["1000:100"]);
	expect(args).toContain("--read-only");
	expect(args).toContain("--init");
	expect(valuesOf(args, "--tmpfs")).toEqual(["/tmp:rw,nosuid,nodev,mode=1777"]);
	expect(valuesOf(args, "--network")).toEqual([
		"container:ryu-vault-0011223344556677-net",
	]);
	// --add-host conflicts with a shared namespace; the owner's hosts file applies.
	expect(valuesOf(args, "--add-host")).toEqual([]);
	expect(valuesOf(args, "--sysctl")).toEqual([]);
	expect(valuesOf(args, "--env-file")).toEqual(["/tmp/x/container.env"]);
	expect(valuesOf(args, "-e")).toEqual([]);
	expect(valuesOf(args, "--env")).toEqual([]);
	expect(valuesOf(args, "-v")).toEqual([
		"/home/dev/project:/workspace",
		`/tmp/x/runtime:${CONTAINER_RUNTIME_DIR}:ro`,
		"/srv/data:/data:ro",
	]);
	expect(valuesOf(args, "--entrypoint")).toEqual(["/bin/sh"]);
	expect(args.join(" ")).not.toContain("docker.sock");
	expect(args.slice(-4)).toEqual([
		"sha256:abc",
		RUN_SCRIPT_PATH,
		"python",
		"agent.py",
	]);
	expect(args).not.toContain("--privileged");
	expect(args).not.toContain("--sig-proxy=false");
});

test("the network owner runs the trusted image with only the firewall capabilities", () => {
	const args = buildOwnerArgs({
		gatewayAddress: "172.18.0.1",
		image: "ryu-vault-isolation:abc",
		lifetimeSeconds: 3660,
		name: "ryu-vault-0011223344556677",
		network: "ryu-vault-0011223344556677",
	});
	expect(args.slice(0, 3)).toEqual(["run", "-d", "--rm"]);
	expect(valuesOf(args, "--name")).toEqual(["ryu-vault-0011223344556677-net"]);
	expect(valuesOf(args, "--network")).toEqual(["ryu-vault-0011223344556677"]);
	expect(valuesOf(args, "--cap-drop")).toEqual(["ALL"]);
	expect(valuesOf(args, "--cap-add")).toEqual(FIREWALL_CAPABILITIES);
	expect(FIREWALL_CAPABILITIES).toEqual(["NET_ADMIN", "NET_RAW"]);
	expect(valuesOf(args, "--security-opt")).toEqual(["no-new-privileges"]);
	expect(valuesOf(args, "--add-host")).toEqual([
		"ryu-vault-gateway:172.18.0.1",
	]);
	expect(args.slice(-4)).toEqual([
		"--entrypoint",
		"sleep",
		"ryu-vault-isolation:abc",
		"3660",
	]);
	expect(() =>
		buildOwnerArgs({
			gatewayAddress: "host-gateway",
			image: "node:22",
			lifetimeSeconds: 60,
			name: "ryu-vault-x",
			network: "ryu-vault-x",
		})
	).toThrow(/trusted isolation image/);
	expect(
		ownerLifetimeSeconds(
			"2026-10-15T13:00:00Z",
			Date.parse("2026-10-15T12:00:00Z")
		)
	).toBe(3660);
	expect(
		ownerLifetimeSeconds(
			"2026-10-15T11:00:00Z",
			Date.parse("2026-10-15T12:00:00Z")
		)
	).toBe(120);
	expect(ownerLifetimeSeconds("not a date", 0)).toBe(86_400);
});

test("run argv refuses a foreign container name and an empty command", () => {
	expect(() => buildRunArgs(runConfig({ name: "bridge" }))).toThrow(
		/per-invocation network/
	);
	expect(() => buildRunArgs(runConfig({ command: [] }))).toThrow(/command/);
});

// ── mounts ───────────────────────────────────────────────────────────────────

test("reserved container destinations are refused on, inside, and above", () => {
	for (const destination of [
		"/",
		"/etc",
		"/etc/passwd",
		"/usr",
		"/usr/local/sbin",
		"/usr/local/sbin/ryu-entrypoint.sh",
		"/bin",
		"/workspace",
		"/workspace/sub",
		"/run",
		"/var",
		"/proc/self",
		"/etc/ryu-vault",
	]) {
		expect(() => validateContainerDestination(destination)).toThrow(/reserved/);
	}
	expect(() => validateContainerDestination("/data/../etc")).toThrow(
		/normalized/
	);
	expect(() => validateContainerDestination("data")).toThrow(/absolute/);
	expect(() => validateContainerDestination("/data/")).toThrow(/normalized/);
	for (const destination of ["/data", "/opt/tools", "/home/agent/.cache"]) {
		expect(() => validateContainerDestination(destination)).not.toThrow();
	}
});

test("mount sources resolve symlinks and refuse Ryu data, sockets, and runtime sockets", async () => {
	const home = await tempDir();
	const ryuDir = join(home, ".ryu-dev");
	await mkdir(join(ryuDir, "vault"), { recursive: true });
	const data = join(home, "data");
	await mkdir(data);
	const link = join(home, "innocent");
	await symlink(join(ryuDir, "vault"), link);

	const ok = await parseMount(`${data}:/data:ro`, home, {});
	expect(ok.destination).toBe("/data");
	expect(ok.readOnly).toBe(true);

	await expect(parseMount(`${link}:/data`, home, {})).rejects.toThrow(
		/Ryu data directory/
	);
	// The home directory holds both ~/.ryu* and ~/.docker/run/docker.sock.
	await expect(parseMount(`${home}:/data`, home, {})).rejects.toThrow(
		/Ryu data directory|runtime socket/
	);
	await expect(parseMount("relative:/data", home, {})).rejects.toThrow(
		/absolute/
	);
	await expect(parseMount(`${data}:/data:rx`, home, {})).rejects.toThrow(
		/'ro' or 'rw'/
	);
	await expect(parseMount(`${home}/missing:/data`, home, {})).rejects.toThrow(
		/does not exist/
	);
	await expect(parseMount(`${data}:/etc/x`, home, {})).rejects.toThrow(
		/reserved/
	);
	await expect(parseMount(`${data}`, home, {})).rejects.toThrow(/SRC:DST/);

	const custom = join(home, "custom-data");
	await mkdir(custom);
	await expect(
		parseMount(`${custom}:/data`, home, { RYU_DIR: custom })
	).rejects.toThrow(/Ryu data directory/);

	// A directory above the configured Docker socket exposes it.
	const sockDir = join(home, "sockdir");
	await mkdir(sockDir);
	await expect(
		parseMount(`${sockDir}:/data`, home, {
			DOCKER_HOST: `unix://${join(sockDir, "docker.sock")}`,
		})
	).rejects.toThrow(/runtime socket/);
	await expect(validateHostSource("/var/run", home, {})).rejects.toThrow(
		/runtime socket/
	);
	// The active docker context's socket, and well-known desktop runtimes.
	const ctxDir = join(home, "ctx");
	await mkdir(ctxDir);
	await expect(
		parseMount(`${ctxDir}:/data`, home, {}, `unix://${join(ctxDir, "d.sock")}`)
	).rejects.toThrow(/runtime socket/);
	await mkdir(join(home, ".docker", "desktop"), { recursive: true });
	await expect(
		parseMount(`${join(home, ".docker", "desktop")}:/data`, home, {})
	).rejects.toThrow(/runtime socket/);
	await mkdir(join(home, ".colima", "work"), { recursive: true });
	await expect(
		parseMount(`${join(home, ".colima", "work")}:/data`, home, {})
	).rejects.toThrow(/runtime socket/);
	// A socket reached through a symlinked directory is compared resolved.
	const realSockDir = join(home, "real-sock");
	await mkdir(realSockDir);
	const realSocket = join(realSockDir, "docker.sock");
	const dockerServer = createServer();
	await new Promise<void>((resolve) =>
		dockerServer.listen(realSocket, resolve)
	);
	try {
		const linkDir = join(home, "link-sock");
		await symlink(realSockDir, linkDir);
		expect(
			await controlSockets(home, {}, `unix://${join(linkDir, "docker.sock")}`)
		).toContain(realSocket);
		await expect(
			parseMount(
				`${realSockDir}:/data`,
				home,
				{},
				`unix://${join(linkDir, "docker.sock")}`
			)
		).rejects.toThrow(/runtime socket/);
	} finally {
		await new Promise<void>((resolve) => dockerServer.close(() => resolve()));
	}

	// Any Unix socket is refused.
	const socketPath = join(home, "agent.sock");
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	try {
		await expect(parseMount(`${socketPath}:/data`, home, {})).rejects.toThrow(
			/Unix socket/
		);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

// ── environment ──────────────────────────────────────────────────────────────

test("container env points every client at the relay and trusts the broker CA", () => {
	const env = buildContainerEnv({ token: TOKEN, port: 40_123 });
	const proxy = `http://rvb:${TOKEN}@ryu-vault-gateway:40123`;
	expect(env.HTTPS_PROXY).toBe(proxy);
	expect(env.HTTP_PROXY).toBe(proxy);
	expect(env.https_proxy).toBe(proxy);
	expect(env.http_proxy).toBe(proxy);
	expect(env.NO_PROXY).toBe("");
	expect(env.no_proxy).toBe("");
	expect(env.NODE_USE_ENV_PROXY).toBe("1");
	expect(env.NODE_EXTRA_CA_CERTS).toBe(CONTAINER_CA_PATH);
	expect(env.DENO_CERT).toBe(CONTAINER_CA_PATH);
	for (const name of [
		"SSL_CERT_FILE",
		"REQUESTS_CA_BUNDLE",
		"CURL_CA_BUNDLE",
		"GIT_SSL_CAINFO",
	]) {
		expect(env[name]).toBe(CONTAINER_CA_BUNDLE_PATH);
	}
	expect(env.HOME).toBe("/tmp/home");
	expect(Object.keys(env).sort()).not.toContain("PATH");
	expect(Object.keys(env).some((key) => key.startsWith("RYU_"))).toBe(false);

	const file = renderEnvFile(env);
	expect(file).toContain(`HTTPS_PROXY=${proxy}\n`);
	expect(file).toContain("NO_PROXY=\n");
	expect(() => renderEnvFile({ A: "x\ny" })).toThrow(/newline/);
	expect(() => renderEnvFile({ "A-B": "x" })).toThrow(/invalid/);
});

test("the firewall denies inbound and only allows connections to the relay", () => {
	expect(FIREWALL_SCRIPT).toContain("iptables -P OUTPUT DROP");
	expect(FIREWALL_SCRIPT).toContain("iptables -P INPUT DROP");
	expect(FIREWALL_SCRIPT).toContain("-d 127.0.0.11 -j DROP");
	expect(FIREWALL_SCRIPT).toContain(
		'-A OUTPUT -d "$gateway" -p tcp --dport "$port" -j ACCEPT'
	);
	expect(FIREWALL_SCRIPT).toContain(
		'-A INPUT -s "$gateway" -p tcp --sport "$port" -m conntrack --ctstate ESTABLISHED -j ACCEPT'
	);
	expect(FIREWALL_SCRIPT).toContain("ip6tables -P OUTPUT DROP");
	expect(FIREWALL_SCRIPT).toContain("ip6tables -P INPUT DROP");
	// No reply path that a connection opened from outside could use.
	for (const line of FIREWALL_SCRIPT.split("\n")) {
		if (/-A OUTPUT/.test(line)) {
			expect(line).not.toMatch(/ESTABLISHED|RELATED|ctstate/);
		}
		if (/-A INPUT/.test(line)) {
			expect(line).toMatch(/-i lo -j ACCEPT|-s "\$gateway"/);
		}
	}
	expect(FIREWALL_SCRIPT).not.toMatch(/--dport 53|udp/);
	expect(RUN_SCRIPT).toContain('exec "$@"');
	expect(RUN_SCRIPT).not.toMatch(/iptables|setpriv|sudo/);
	expect(RUN_SCRIPT).toContain(CONTAINER_CA_BUNDLE_PATH);
	expect(DEFAULT_DOCKERFILE).toContain("iptables");
	expect(DEFAULT_DOCKERFILE).toContain(`FROM ${BASE_IMAGE}\n`);
	expect(BASE_IMAGE).toMatch(/^debian:bookworm-slim@sha256:[0-9a-f]{64}$/);
	expect(DEFAULT_DOCKERFILE).not.toContain("ENTRYPOINT");
});

// ── Docker output parsing ────────────────────────────────────────────────────

test("docker info, network config, and CIDR parsing", () => {
	expect(
		parseDockerInfo('linux|Ubuntu 24.04|["name=seccomp,profile=builtin"]\n')
	).toEqual({
		osType: "linux",
		operatingSystem: "Ubuntu 24.04",
		rootless: false,
		userns: false,
	});
	expect(
		parseDockerInfo(
			'linux|Debian|["name=seccomp,profile=builtin","name=rootless"]'
		)
	).toMatchObject({ rootless: true, userns: false });
	expect(parseDockerInfo('linux|Debian|["name=userns"]')).toMatchObject({
		rootless: false,
		userns: true,
	});
	expect(
		parseNetworkConfig(
			"ryu-vault-x",
			'[{"Subnet":"fd00::/64","Gateway":"fd00::1"},{"Subnet":"172.18.0.0/16","Gateway":"172.18.0.1"}]\n'
		)
	).toEqual({
		name: "ryu-vault-x",
		gateway: "172.18.0.1",
		subnet: "172.18.0.0/16",
	});
	expect(() => parseNetworkConfig("n", "[]")).toThrow(/no IPv4 gateway/);
	expect(() => parseNetworkConfig("n", "<no value>")).toThrow(/unexpected/);
	expect(() =>
		parseNetworkConfig("n", '[{"Subnet":"10.0.0.0/24","Gateway":"10.0.1.1"}]')
	).toThrow(/no IPv4 gateway/);
	expect(ipv4InCidr("172.18.0.2", "172.18.0.0/16")).toBe(true);
	expect(ipv4InCidr("172.19.0.2", "172.18.0.0/16")).toBe(false);
	expect(ipv4InCidr("192.168.1.10", "172.18.0.0/16")).toBe(false);
	expect(ipv4InCidr("::1", "172.18.0.0/16")).toBe(false);
	expect(ipv4InCidr("10.0.0.300", "10.0.0.0/8")).toBe(false);
});

function fakeDocker(
	respond: (args: string[], stdin?: Uint8Array) => Partial<DockerCapture>
): {
	calls: string[][];
	stdins: (Uint8Array | undefined)[];
	docker: DockerRunner;
} {
	const calls: string[][] = [];
	const stdins: (Uint8Array | undefined)[] = [];
	return {
		calls,
		stdins,
		docker: (args, stdin) => {
			calls.push(args);
			stdins.push(stdin);
			const result = respond(args, stdin);
			return Promise.resolve({
				exitCode: result.exitCode ?? 0,
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
			});
		},
	};
}

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

async function echoServer(): Promise<{ server: Server; port: number }> {
	const server = createServer((socket) => {
		socket.on("data", (chunk) => socket.write(`echo:${chunk.toString()}`));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("no port");
	}
	return { server, port: address.port };
}

function exchange(port: number, message: string): Promise<string> {
	return new Promise((resolve) => {
		const socket = connect({ host: "127.0.0.1", port });
		let received = "";
		socket.on("data", (chunk) => {
			received += chunk.toString();
			if (received.length >= `echo:${message}`.length) {
				socket.end();
			}
		});
		socket.on("error", () => resolve(received));
		socket.on("close", () => resolve(received));
		socket.write(message);
	});
}

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

function makeIo() {
	let outBuf = "";
	let errBuf = "";
	const io: CliIO = {
		out: (s) => {
			outBuf += s;
		},
		err: (s) => {
			errBuf += s;
		},
	};
	return { io, out: () => outBuf, err: () => errBuf };
}

function stubApi(): CoreApi {
	const notCalled = () => Promise.reject(new Error("unexpected CoreApi call"));
	return {
		fetchApps: notCalled,
		fetchAppsCatalog: notCalled,
		installApp: notCalled,
		enableApp: notCalled,
		disableApp: notCalled,
		uninstallApp: notCalled,
		execAppCommand: notCalled,
		streamChat: notCalled,
	};
}

const CA_PEM =
	"-----BEGIN CERTIFICATE-----\nbroker\n-----END CERTIFICATE-----\n";
const T = "2030-01-01T00:00:00Z";

function brokerNode(brokerPort: number, caPath: string) {
	const calls: string[] = [];
	const proxyUrl = `http://rvb:${TOKEN}@127.0.0.1:${brokerPort}`;
	const target: ApiTarget = {
		url: "http://127.0.0.1:7777",
		token: "node-token",
		fetch: (input, init) => {
			const url = new URL(String(input));
			const route = `${init?.method ?? "GET"} ${url.pathname}`;
			calls.push(route);
			if (route === "POST /api/vault/broker/sessions") {
				return Promise.resolve(
					Response.json({
						token: TOKEN,
						session: {
							id: "bs_1",
							environment: "prod",
							services: ["github"],
							label: "ryu secrets run curl",
							mintedBy: "user:u1",
							createdAt: T,
							expiresAt: T,
						},
						proxy: {
							url: `http://127.0.0.1:${brokerPort}`,
							port: brokerPort,
							caPath,
							caBundlePath: caPath,
							caUrl: "/api/vault/broker/ca.pem",
							env: { HTTPS_PROXY: proxyUrl },
						},
					})
				);
			}
			if (route === "DELETE /api/vault/broker/sessions/bs_1") {
				return Promise.resolve(Response.json({ revoked: true }));
			}
			return Promise.resolve(
				Response.json({ error: "no route" }, { status: 404 })
			);
		},
	};
	return { calls, target };
}

interface HostFixture {
	docker: ReturnType<typeof fakeDocker>;
	host: ContainerHost;
	signals: { handler: ((signal: string) => void) | null; disposed: boolean };
}

async function hostFixture(
	respond?: (args: string[]) => Partial<DockerCapture> | null,
	platform = "linux"
): Promise<HostFixture> {
	const home = await tempDir("ryu-iso-home-");
	const work = await tempDir("ryu-iso-work-");
	const scratch = await tempDir("ryu-iso-tmp-");
	const signals: HostFixture["signals"] = { handler: null, disposed: false };
	const docker = fakeDocker((args) => {
		const custom = respond?.(args);
		if (custom) {
			return custom;
		}
		if (args[0] === "info") {
			return { stdout: "linux|Ubuntu 24.04|[]" };
		}
		if (args[0] === "context") {
			return { stdout: "unix:///var/run/docker.sock" };
		}
		if (args[0] === "network" && args[1] === "inspect") {
			return { stdout: '[{"Subnet":"127.0.0.0/8","Gateway":"127.0.0.1"}]' };
		}
		if (args[0] === "network" && args[1] === "ls") {
			return { stdout: "" };
		}
		return { stdout: "sha256:x" };
	});
	return {
		docker,
		signals,
		host: {
			cwd: () => work,
			docker: docker.docker,
			gid: 1000,
			homeDir: home,
			isTty: false,
			onSignal: (handler) => {
				signals.handler = handler;
				signals.disposed = false;
				return () => {
					signals.disposed = true;
				};
			},
			platform,
			tmpDir: scratch,
			uid: 1000,
		},
	};
}

interface SpawnObservation {
	argv: string[];
	caBody: string;
	dockerEnv: Record<string, string>;
	envFile: string;
	envMode: number;
	relayed: string;
	runScript: string;
}

function envFileFrom(args: string[]): string {
	const index = args.indexOf("--env-file");
	return args[index + 1] ?? "";
}

function runtimeDirFrom(args: string[]): string {
	const volume =
		args.find((value) => value.endsWith(`:${CONTAINER_RUNTIME_DIR}:ro`)) ?? "";
	return volume.split(":")[0] ?? "";
}

async function brokerCaFile(): Promise<string> {
	const caDir = await tempDir();
	const caPath = join(caDir, "broker-ca.pem");
	await writeFile(caPath, CA_PEM);
	return caPath;
}

function secretsRun(
	fixture: HostFixture,
	target: ApiTarget,
	spawn: (cmd: string[], env: Record<string, string>) => Promise<number>,
	extra: string[] = []
) {
	const cap = makeIo();
	const result = runCli(
		[
			"secrets",
			"run",
			"--broker",
			"github",
			"--container",
			...extra,
			"--",
			"sh",
		],
		{
			api: stubApi(),
			containerHost: fixture.host,
			env: {},
			io: cap.io,
			target,
			spawn,
		}
	);
	return { cap, result };
}

test("secrets run --container relays through the broker, keeps the token out of argv, and tears down", async () => {
	const broker = await echoServer();
	const caPath = await brokerCaFile();
	const node = brokerNode(broker.port, caPath);
	const fixture = await hostFixture();
	const cap = makeIo();
	const seen: { value: SpawnObservation | null } = { value: null };
	try {
		const code = await runCli(
			[
				"secrets",
				"run",
				"--broker",
				"github",
				"--container",
				"--",
				"curl",
				"https://api.github.com",
			],
			{
				api: stubApi(),
				containerHost: fixture.host,
				env: { RYU_VAULT_TOKEN: undefined, PATH: "/usr/bin" },
				io: cap.io,
				target: node.target,
				spawn: async (cmd, env) => {
					const argv = cmd.slice(1);
					const envFile = envFileFrom(argv);
					const body = await readFile(envFile, "utf8");
					const port = Number(/ryu-vault-gateway:(\d+)/.exec(body)?.[1]);
					const runtimeDir = runtimeDirFrom(argv);
					seen.value = {
						argv: cmd,
						envFile: body,
						envMode: (await stat(envFile)).mode & 0o777,
						caBody: await readFile(join(runtimeDir, "ca.pem"), "utf8"),
						runScript: await readFile(join(runtimeDir, "run.sh"), "utf8"),
						// The container would dial the relay; here the test does.
						relayed: await exchange(
							port,
							"GET http://api.github.com/ HTTP/1.1"
						),
						dockerEnv: env,
					};
					return 7;
				},
			}
		);
		expect(cap.err()).toContain("isolated container");
		expect(code).toBe(7);
	} finally {
		await new Promise<void>((resolve) => broker.server.close(() => resolve()));
	}
	const observed = seen.value;
	if (observed === null) {
		throw new Error("docker run was not spawned");
	}
	expect(observed.argv[0]).toBe("docker");
	expect(observed.argv.join(" ")).not.toContain(TOKEN);
	expect(observed.argv.slice(-2)).toEqual(["curl", "https://api.github.com"]);
	expect(observed.envFile).toContain(
		`HTTPS_PROXY=http://rvb:${TOKEN}@ryu-vault-gateway:`
	);
	expect(observed.envMode).toBe(0o600);
	expect(observed.caBody).toBe(CA_PEM);
	expect(observed.runScript).toBe(RUN_SCRIPT);
	expect(observed.relayed).toBe("echo:GET http://api.github.com/ HTTP/1.1");
	expect(Object.values(observed.dockerEnv).join(" ")).not.toContain(TOKEN);

	const name = valuesOf(observed.argv, "--name")[0] ?? "";
	expect(name).toMatch(/^ryu-vault-[0-9a-f]{16}$/);
	expect(valuesOf(observed.argv, "--network")).toEqual([
		`container:${name}-net`,
	]);
	const calls = fixture.docker.calls.map((call) => call.join(" "));
	// Setup order: checks and images before the session, then the owner,
	// firewall, and probe before the command.
	const ownerRun = fixture.docker.calls.find(
		(call) => call[0] === "run" && call[1] === "-d"
	);
	expect(ownerRun).toBeDefined();
	expect(valuesOf(ownerRun ?? [], "--add-host")).toEqual([
		"ryu-vault-gateway:127.0.0.1",
	]);
	const port = /ryu-vault-gateway:(\d+)/.exec(observed.envFile)?.[1];
	expect(calls).toContain(
		`exec -e RYU_VAULT_FORWARD_PORT=${port} ${name}-net ${FIREWALL_PATH}`
	);
	expect(
		calls.some((call) => call.startsWith(`exec ${name}-net timeout 5 bash`))
	).toBe(true);
	expect(calls.indexOf(`rm -f ${name}`)).toBeLessThan(
		calls.indexOf(`rm -f ${name}-net`)
	);
	expect(calls.indexOf(`rm -f ${name}-net`)).toBeLessThan(
		calls.indexOf(`network rm ${name}`)
	);
	expect(fixture.signals.disposed).toBe(true);
	// The env file and the runtime directory are gone.
	await expect(stat(envFileFrom(observed.argv.slice(1)))).rejects.toThrow();
	await expect(stat(runtimeDirFrom(observed.argv))).rejects.toThrow();
	expect(node.calls).toEqual([
		"POST /api/vault/broker/sessions",
		"DELETE /api/vault/broker/sessions/bs_1",
	]);
});

test("on Docker Desktop the relay binds host loopback and accepts loopback peers only", async () => {
	const broker = await echoServer();
	const node = brokerNode(broker.port, await brokerCaFile());
	const fixture = await hostFixture(
		(args) =>
			args[0] === "network" && args[1] === "inspect"
				? { stdout: '[{"Subnet":"172.30.0.0/16","Gateway":"172.30.0.1"}]' }
				: null,
		"darwin"
	);
	let relayed = "";
	let ownerHost: string[] = [];
	try {
		const { result } = secretsRun(fixture, node.target, async (cmd) => {
			const body = await readFile(envFileFrom(cmd.slice(1)), "utf8");
			const port = Number(/ryu-vault-gateway:(\d+)/.exec(body)?.[1]);
			relayed = await exchange(port, "ping");
			const owner = fixture.docker.calls.find(
				(call) => call[0] === "run" && call[1] === "-d"
			);
			ownerHost = valuesOf(owner ?? [], "--add-host");
			return 0;
		});
		expect(await result).toBe(0);
	} finally {
		await new Promise<void>((resolve) => broker.server.close(() => resolve()));
	}
	// The test reached the relay over 127.0.0.1, so it is bound to loopback.
	expect(relayed).toBe("echo:ping");
	expect(ownerHost).toEqual(["ryu-vault-gateway:host-gateway"]);
});

test("a failed docker run still removes both containers, the network, and temp files and revokes the session", async () => {
	const node = brokerNode(1, await brokerCaFile());
	const fixture = await hostFixture();
	let envFile = "";
	const { cap, result } = secretsRun(fixture, node.target, (cmd) => {
		envFile = envFileFrom(cmd.slice(1));
		fixture.signals.handler?.("SIGTERM");
		// SIGINT reaches the docker client from the terminal; not re-sent.
		fixture.signals.handler?.("SIGINT");
		return Promise.reject(new Error("could not run 'docker'"));
	});
	expect(await result).toBe(1);
	expect(cap.err()).toContain("could not run 'docker'");
	const calls = fixture.docker.calls.map((call) => call.join(" "));
	expect(calls.filter((call) => call.startsWith("kill "))).toHaveLength(1);
	expect(
		calls.some((call) =>
			/^kill --signal SIGTERM ryu-vault-[0-9a-f]+$/.test(call)
		)
	).toBe(true);
	expect(
		calls.some((call) => /^rm -f ryu-vault-[0-9a-f]+-net$/.test(call))
	).toBe(true);
	expect(calls.some((call) => call.startsWith("network rm ryu-vault-"))).toBe(
		true
	);
	await expect(stat(envFile)).rejects.toThrow();
	expect(node.calls).toContain("DELETE /api/vault/broker/sessions/bs_1");
});

test("a signal before the container exists is re-sent once docker run creates it", async () => {
	const node = brokerNode(1, await brokerCaFile());
	let kills = 0;
	const fixture = await hostFixture((args) => {
		if (args[0] === "kill") {
			kills++;
			return kills === 1 ? { exitCode: 1, stderr: "No such container" } : {};
		}
		return null;
	});
	const { result } = secretsRun(fixture, node.target, async () => {
		fixture.signals.handler?.("SIGHUP");
		await new Promise((resolve) => setTimeout(resolve, 500));
		return 129;
	});
	expect(await result).toBe(129);
	expect(kills).toBe(2);
});

test("a signal during the image build cancels before any session is minted", async () => {
	const node = brokerNode(1, await brokerCaFile());
	let fixtureRef: HostFixture | null = null;
	const fixture = await hostFixture((args) => {
		if (args[0] === "image") {
			return { exitCode: 1 };
		}
		if (args[0] === "build") {
			fixtureRef?.signals.handler?.("SIGINT");
			return { exitCode: 137 };
		}
		return null;
	});
	fixtureRef = fixture;
	let spawned = false;
	const { cap, result } = secretsRun(fixture, node.target, () => {
		spawned = true;
		return Promise.resolve(0);
	});
	expect(await result).toBe(130);
	expect(cap.err()).toContain("cancelled by SIGINT");
	expect(spawned).toBe(false);
	expect(node.calls).toEqual([]);
	expect(fixture.docker.calls.some((call) => call[1] === "create")).toBe(false);
	expect(fixture.signals.disposed).toBe(true);
});

test("a signal during network setup tears down, revokes the session, and exits 128+n", async () => {
	const node = brokerNode(1, await brokerCaFile());
	let fixtureRef: HostFixture | null = null;
	const fixture = await hostFixture((args) => {
		if (args[0] === "run" && args[1] === "-d") {
			fixtureRef?.signals.handler?.("SIGTERM");
		}
		return null;
	});
	fixtureRef = fixture;
	let spawned = false;
	const { result } = secretsRun(fixture, node.target, () => {
		spawned = true;
		return Promise.resolve(0);
	});
	expect(await result).toBe(143);
	expect(spawned).toBe(false);
	const calls = fixture.docker.calls.map((call) => call.join(" "));
	expect(
		calls.some((call) => /^rm -f ryu-vault-[0-9a-f]+-net$/.test(call))
	).toBe(true);
	expect(calls.some((call) => call.startsWith("network rm ryu-vault-"))).toBe(
		true
	);
	expect(calls.some((call) => call.startsWith("exec "))).toBe(false);
	const scratch = fixture.host.tmpDir;
	expect(
		(await readdir(scratch)).filter((entry) => entry.startsWith("ryu-vault"))
	).toEqual([]);
	expect(node.calls).toEqual([
		"POST /api/vault/broker/sessions",
		"DELETE /api/vault/broker/sessions/bs_1",
	]);
});

test("a failed firewall or relay probe never starts the command", async () => {
	for (const failing of ["firewall", "probe"]) {
		const node = brokerNode(1, await brokerCaFile());
		const fixture = await hostFixture((args) => {
			if (args[0] !== "exec") {
				return null;
			}
			const isProbe = args.includes("timeout");
			return (failing === "probe") === isProbe
				? { exitCode: 1, stderr: "iptables: Permission denied" }
				: null;
		});
		let spawned = false;
		const { cap, result } = secretsRun(fixture, node.target, () => {
			spawned = true;
			return Promise.resolve(0);
		});
		expect(await result).toBe(1);
		expect(spawned).toBe(false);
		expect(cap.err()).toMatch(
			failing === "probe"
				? /could not reach the relay/
				: /installing the container firewall/
		);
		expect(node.calls).toContain("DELETE /api/vault/broker/sessions/bs_1");
		const calls = fixture.docker.calls.map((call) => call.join(" "));
		expect(calls.some((call) => call.startsWith("network rm ryu-vault-"))).toBe(
			true
		);
	}
});

test("an unreachable daemon or a refused mount mints no session and creates nothing", async () => {
	const caPath = await brokerCaFile();
	const down = await hostFixture((args) =>
		args[0] === "info"
			? { exitCode: 1, stderr: "Cannot connect to the Docker daemon" }
			: null
	);
	const downNode = brokerNode(1, caPath);
	const downRun = secretsRun(down, downNode.target, () => Promise.resolve(0));
	expect(await downRun.result).toBe(1);
	expect(downRun.cap.err()).toContain("Docker daemon is not reachable");
	expect(down.docker.calls).toEqual([
		[
			"info",
			"--format",
			"{{.OSType}}|{{.OperatingSystem}}|{{json .SecurityOptions}}",
		],
	]);
	expect(downNode.calls).toEqual([]);

	const refused = await hostFixture();
	const refusedNode = brokerNode(1, caPath);
	const refusedRun = secretsRun(
		refused,
		refusedNode.target,
		() => Promise.resolve(0),
		["--mount", "/var/run:/data"]
	);
	expect(await refusedRun.result).toBe(1);
	expect(refusedRun.cap.err()).toContain("runtime socket");
	expect(refusedNode.calls).toEqual([]);
	expect(refused.docker.calls.some((call) => call[1] === "create")).toBe(false);

	const inspectFails = await hostFixture((args) =>
		args[0] === "network" && args[1] === "inspect"
			? { exitCode: 1, stderr: "boom" }
			: null
	);
	const node = brokerNode(1, caPath);
	const failed = secretsRun(inspectFails, node.target, () =>
		Promise.resolve(0)
	);
	expect(await failed.result).toBe(1);
	const created = inspectFails.docker.calls.find(
		(call) => call[0] === "network" && call[1] === "create"
	);
	expect(inspectFails.docker.calls.map((call) => call.join(" "))).toContain(
		`network rm ${created?.at(-1) ?? ""}`
	);
	expect(node.calls).toContain("DELETE /api/vault/broker/sessions/bs_1");
});

test("container flags need --broker and container mode", async () => {
	const usage = async (argv: string[]) => {
		const cap = makeIo();
		const code = await runCli(argv, {
			api: stubApi(),
			env: {},
			io: cap.io,
			target: { url: "http://127.0.0.1:7777", token: "t" },
			spawn: () => Promise.resolve(0),
		});
		return { code, err: cap.err() };
	};
	const noBroker = await usage(["secrets", "run", "--container", "--", "sh"]);
	expect(noBroker.code).toBe(2);
	expect(noBroker.err).toContain("needs --broker");
	const imageOnly = await usage([
		"secrets",
		"run",
		"--broker",
		"github",
		"--image",
		"node:22",
		"--",
		"sh",
	]);
	expect(imageOnly.code).toBe(2);
	expect(imageOnly.err).toContain("need --isolation=container");
	const bogus = await usage([
		"secrets",
		"run",
		"--broker",
		"github",
		"--isolation=vm",
		"--",
		"sh",
	]);
	expect(bogus.code).toBe(2);
	expect(bogus.err).toContain("'host' or 'container'");
});

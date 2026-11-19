// `ryu-cli secrets run --broker … --isolation=container`: the pure argv, env,
// mount and firewall builders. Docker parsing and the relay are in
// cli.secrets.isolation-docker.test.ts, end-to-end orchestration in
// cli.secrets.isolation-run.test.ts, shared helpers in vault-isolation-fixture.ts.
// No Docker daemon is needed; nothing here starts a container.

import { afterEach, expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import {
	buildContainerEnv,
	buildOwnerArgs,
	buildRunArgs,
	controlSockets,
	FIREWALL_CAPABILITIES,
	ipv4InCidr,
	ownerLifetimeSeconds,
	parseDockerInfo,
	parseMount,
	parseNetworkConfig,
	type RunArgsConfig,
	renderEnvFile,
	validateContainerDestination,
	validateHostSource,
} from "../cli/vaultIsolation.ts";
import {
	BASE_IMAGE,
	CONTAINER_CA_BUNDLE_PATH,
	CONTAINER_CA_PATH,
	CONTAINER_RUNTIME_DIR,
	DEFAULT_DOCKERFILE,
	FIREWALL_SCRIPT,
	RUN_SCRIPT,
	RUN_SCRIPT_PATH,
} from "../cli/vaultIsolationAssets.ts";
import {
	removeTempDirs,
	TOKEN,
	tempDir,
	valuesOf,
} from "./vault-isolation-fixture.ts";

afterEach(removeTempDirs);

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

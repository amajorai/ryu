// `ryu-cli secrets run --broker … --isolation=container` end to end, with a fake
// Docker runner and a fake node: relay, token handling, teardown and signals.
// Nothing here starts a container.

import { afterEach, expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../cli/dispatch.ts";
import { FIREWALL_PATH, RUN_SCRIPT } from "../cli/vaultIsolationAssets.ts";
import {
	brokerCaFile,
	brokerNode,
	CA_PEM,
	echoServer,
	envFileFrom,
	exchange,
	type HostFixture,
	hostFixture,
	makeIo,
	removeTempDirs,
	runtimeDirFrom,
	type SpawnObservation,
	secretsRun,
	stubApi,
	TOKEN,
	valuesOf,
} from "./vault-isolation-fixture.ts";

afterEach(removeTempDirs);

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

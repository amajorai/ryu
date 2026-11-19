// Shared helpers for the cli.secrets.isolation*.test.ts files: temp dirs, a fake
// Docker runner, a loopback echo server, and the fake host and node behind the
// end-to-end `secrets run --isolation=container` tests.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { runCli } from "../cli/dispatch.ts";
import type { CliIO, CoreApi } from "../cli/types.ts";
import type {
	ContainerHost,
	DockerCapture,
	DockerRunner,
} from "../cli/vaultIsolation.ts";
import { CONTAINER_RUNTIME_DIR } from "../cli/vaultIsolationAssets.ts";

export const TOKEN = "rvb_session_secret";

export const tempDirs: string[] = [];

export async function tempDir(prefix = "ryu-iso-test-"): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

export function removeTempDirs(): Promise<void> {
	return Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
	).then(() => undefined);
}

export function valuesOf(args: string[], name: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < args.length; index++) {
		if (args[index] === name) {
			values.push(args[index + 1] ?? "");
		}
	}
	return values;
}

export function fakeDocker(
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

export async function echoServer(): Promise<{ server: Server; port: number }> {
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

export function exchange(port: number, message: string): Promise<string> {
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

export function makeIo() {
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

export function stubApi(): CoreApi {
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

export const CA_PEM =
	"-----BEGIN CERTIFICATE-----\nbroker\n-----END CERTIFICATE-----\n";

export const T = "2030-01-01T00:00:00Z";

export function brokerNode(brokerPort: number, caPath: string) {
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
							label: "ryu-cli secrets run curl",
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

export interface HostFixture {
	docker: ReturnType<typeof fakeDocker>;
	host: ContainerHost;
	signals: { handler: ((signal: string) => void) | null; disposed: boolean };
}

export async function hostFixture(
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

export interface SpawnObservation {
	argv: string[];
	caBody: string;
	dockerEnv: Record<string, string>;
	envFile: string;
	envMode: number;
	relayed: string;
	runScript: string;
}

export function envFileFrom(args: string[]): string {
	const index = args.indexOf("--env-file");
	return args[index + 1] ?? "";
}

export function runtimeDirFrom(args: string[]): string {
	const volume =
		args.find((value) => value.endsWith(`:${CONTAINER_RUNTIME_DIR}:ro`)) ?? "";
	return volume.split(":")[0] ?? "";
}

export async function brokerCaFile(): Promise<string> {
	const caDir = await tempDir();
	const caPath = join(caDir, "broker-ca.pem");
	await writeFile(caPath, CA_PEM);
	return caPath;
}

export function secretsRun(
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

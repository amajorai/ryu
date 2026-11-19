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
// The sections live in `vaultIsolation-{host,docker,network,mounts,args}.ts`;
// this file keeps the orchestration and re-exports their public names.

import {
	chmod,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { renderLocalized } from "./localizedText.ts";
import { type Forwarder, startForwarder } from "./vaultForwarder.ts";
import {
	buildContainerEnv,
	buildOwnerArgs,
	buildRunArgs,
	renderEnvFile,
} from "./vaultIsolation-args.ts";
import {
	checkDocker,
	ensureIsolationImages,
	type IsolationImages,
} from "./vaultIsolation-docker.ts";
import {
	type ContainerHost,
	type DockerCapture,
	type DockerRunner,
	firstLines,
	KILL_RETRIES,
	KILL_RETRY_MS,
	NETWORK_PREFIX,
	NOBODY,
	newIsolationId,
	OWNER_SUFFIX,
	ownerLifetimeSeconds,
	type SignalGuard,
} from "./vaultIsolation-host.ts";
import { isolationError, isolationText } from "./vaultIsolation-messages.ts";
import {
	type ParsedMount,
	parseMount,
	validateHostSource,
} from "./vaultIsolation-mounts.ts";
import {
	createIsolationNetwork,
	type IsolationNetwork,
	ipv4InCidr,
	pruneStaleNetworks,
} from "./vaultIsolation-network.ts";
import {
	FIREWALL_PATH,
	GATEWAY_HOST,
	RUN_SCRIPT,
} from "./vaultIsolationAssets.ts";

export {
	buildContainerEnv,
	buildOwnerArgs,
	buildRunArgs,
	type OwnerArgsConfig,
	type RunArgsConfig,
	renderEnvFile,
} from "./vaultIsolation-args.ts";
export {
	checkDocker,
	contextHash,
	type DockerInfo,
	ensureIsolationImages,
	type IsolationImages,
	parseDockerInfo,
	tarArchive,
} from "./vaultIsolation-docker.ts";
export {
	type ContainerHost,
	type DockerCapture,
	type DockerRunner,
	DockerUnavailableError,
	defaultContainerHost,
	FIREWALL_CAPABILITIES,
	guardSignals,
	ISOLATION_LABEL,
	IsolationCancelledError,
	NETWORK_PREFIX,
	newIsolationId,
	OWNER_SUFFIX,
	ownerLifetimeSeconds,
	SIGNAL_NUMBERS,
	type SignalGuard,
	validateImageRef,
} from "./vaultIsolation-host.ts";
export {
	controlSockets,
	type ParsedMount,
	parseMount,
	RESERVED_CONTAINER_PATHS,
	validateContainerDestination,
	validateHostSource,
} from "./vaultIsolation-mounts.ts";
export {
	classifyStaleNetwork,
	createIsolationNetwork,
	type IsolationNetwork,
	ipv4InCidr,
	isStaleNetwork,
	parseNetworkConfig,
	pruneStaleNetworks,
	type StaleNetwork,
} from "./vaultIsolation-network.ts";

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
		throw isolationError(isolationText.workDir(error.message));
	});
	if (workDir.includes(":")) {
		throw isolationError(isolationText.workDirColon());
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
		ctx.err(`${renderLocalized(isolationText.runningAsRoot())}\n`);
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
			throw isolationError(
				prepared.desktop
					? isolationText.relayDesktop()
					: isolationText.relayFirewall(
							`${network.gateway}:${port}`,
							network.subnet
						)
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
			`${renderLocalized(isolationText.running(request.command[0] ?? "", network.name))}\n`
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

// The container environment, env file, and `docker run` argv for the network
// owner and the command container. Split from
// `vaultIsolation.ts`, which re-exports the public names.

import {
	FIREWALL_CAPABILITIES,
	ISOLATION_LABEL,
	NETWORK_PREFIX,
	OWNER_SUFFIX,
} from "./vaultIsolation-host.ts";
import type { ParsedMount } from "./vaultIsolation-mounts.ts";
import {
	CONTAINER_CA_BUNDLE_PATH,
	CONTAINER_CA_PATH,
	CONTAINER_RUNTIME_DIR,
	GATEWAY_HOST,
	ISOLATION_IMAGE_REPO,
	RUN_SCRIPT_PATH,
} from "./vaultIsolationAssets.ts";

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

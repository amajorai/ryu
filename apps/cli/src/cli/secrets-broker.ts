import { constants } from "node:fs";
import {
	access,
	chmod,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getVaultBrokerCaPem,
	type VaultBrokerProxy,
} from "@ryuhq/core-client/vault";
import { flag, type SecretsArgs } from "./secrets-args.ts";
import { machineTarget } from "./secrets-output.ts";
import { type CliContext, UsageError } from "./types.ts";
import { IsolationCancelledError, type SignalGuard } from "./vaultIsolation.ts";

// ── Developer workflow ───────────────────────────────────────────────────────

const CHILD_RUNTIME_ENV_KEYS = new Set([
	"APPDATA",
	"COLORTERM",
	"COMSPEC",
	"FORCE_COLOR",
	"HOME",
	"HOMEDRIVE",
	"HOMEPATH",
	"LANG",
	"LANGUAGE",
	"LC_ALL",
	"LC_CTYPE",
	"LOCALAPPDATA",
	"LOGNAME",
	"NODE_EXTRA_CA_CERTS",
	"NO_COLOR",
	"PATH",
	"PATHEXT",
	"PROGRAMDATA",
	"SHELL",
	"SSL_CERT_DIR",
	"SSL_CERT_FILE",
	"SYSTEMROOT",
	"TEMP",
	"TERM",
	"TMP",
	"TMPDIR",
	"TZ",
	"USER",
	"USERPROFILE",
	"WINDIR",
]);

/** Network routing the child needs to reach anything from a proxied host.
 *  Forwarded only while the value carries no credential of its own. */
const CHILD_NETWORK_ENV_KEYS = new Set([
	"ALL_PROXY",
	"CURL_CA_BUNDLE",
	"HTTPS_PROXY",
	"HTTP_PROXY",
	"NODE_USE_ENV_PROXY",
	"NO_PROXY",
	"REQUESTS_CA_BUNDLE",
]);

/** A proxy URL with userinfo (`http://user:pass@proxy`) is an ambient
 *  credential, so it stays with the CLI rather than reaching the child. */
function carriesUrlCredential(value: string): boolean {
	return /^(?:[a-z][a-z0-9+.-]*:\/\/)?[^/?#]*@/i.test(value.trim());
}

export function childRuntimeEnvironment(
	environment: Readonly<Record<string, string | undefined>>
): Record<string, string> {
	const runtime: Record<string, string> = {};
	for (const [key, value] of Object.entries(environment)) {
		if (value === undefined) {
			continue;
		}
		const name = key.toUpperCase();
		if (CHILD_RUNTIME_ENV_KEYS.has(name)) {
			runtime[key] = value;
		} else if (
			CHILD_NETWORK_ENV_KEYS.has(name) &&
			!carriesUrlCredential(value)
		) {
			runtime[key] = value;
		}
	}
	return runtime;
}

/** Environment for the trusted host `docker` CLI in container isolation. The
 *  container itself receives only explicit `-e`/`--env-file` values. */
export function dockerCliEnvironment(
	environment: Readonly<Record<string, string | undefined>>
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(environment)) {
		// The vault token authenticates this CLI, not Docker or the child.
		if (value !== undefined && key !== "RYU_VAULT_TOKEN") {
			env[key] = value;
		}
	}
	return env;
}

// ── Credential broker ────────────────────────────────────────────────────────

/** `--isolation host|container`, with `--container` as an alias. */
export function isolationMode(args: SecretsArgs): "host" | "container" {
	const value = flag(args, "--isolation");
	if (value !== undefined && value !== "host" && value !== "container") {
		throw new UsageError("--isolation must be 'host' or 'container'.");
	}
	if (args.booleans.has("--container")) {
		if (value === "host") {
			throw new UsageError("--container conflicts with --isolation=host.");
		}
		return "container";
	}
	return value ?? "host";
}

/** The broker CA PEM: Core's file when this user can read it, else the
 *  public certificate from the node. */
export async function brokerCaPem(
	ctx: CliContext,
	proxy: VaultBrokerProxy
): Promise<string> {
	if (proxy.caPath && (await isReadableFile(proxy.caPath))) {
		return await readFile(proxy.caPath, "utf8");
	}
	return await getVaultBrokerCaPem(machineTarget(ctx));
}

/** `--broker a,b --broker c` → `["a", "b", "c"]`. */
export function brokerServices(args: SecretsArgs): string[] {
	return (args.values.get("--broker") ?? [])
		.flatMap((value) => value.split(","))
		.map((name) => name.trim())
		.filter((name) => name !== "");
}

/** Where a host trust store usually lives; the broker CA is appended to it. */
const SYSTEM_CA_BUNDLES = [
	"/etc/ssl/certs/ca-certificates.crt",
	"/etc/pki/tls/certs/ca-bundle.crt",
	"/etc/ssl/cert.pem",
];

async function isReadableFile(path: string): Promise<boolean> {
	try {
		if (!(await stat(path)).isFile()) {
			return false;
		}
		await access(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

/** True for `localhost`, `127.0.0.0/8`, and `::1` host names. */
function isLoopbackHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	return (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host === "::1" ||
		/^127(?:\.\d{1,3}){3}$/.test(host)
	);
}

function urlHostname(value: string | undefined): string | null {
	if (!value) {
		return null;
	}
	try {
		return new URL(value).hostname;
	} catch {
		return null;
	}
}

/** Core renders the proxy URL on its own loopback interface. When this CLI
 *  talks to a node on another host, that URL would point at this machine
 *  instead, and the child would send the session token to whatever listens
 *  there. Returns true when the proxy is reachable from this host. */
export function brokerProxyReachable(
	ctx: CliContext,
	proxy: VaultBrokerProxy
): boolean {
	const proxyHost =
		urlHostname(proxy.url) ??
		urlHostname(proxy.env.HTTPS_PROXY ?? proxy.env.https_proxy);
	if (proxyHost === null || !isLoopbackHost(proxyHost)) {
		return true;
	}
	const targetHost = urlHostname(ctx.target.url);
	return targetHost !== null && isLoopbackHost(targetHost);
}

async function systemCaBundle(): Promise<string> {
	for (const path of SYSTEM_CA_BUNDLES) {
		try {
			return await readFile(path, "utf8");
		} catch {
			// Try the next conventional location.
		}
	}
	return "";
}

interface BrokerCaFiles {
	/** Removes the temporary directory, if one was written. */
	cleanup: () => Promise<void>;
	/** Replacements for CA paths Core reported but this user cannot read. */
	replacements: Map<string, string>;
}

/** Core writes the CA files on its own host, which is this host (see
 *  `brokerProxyReachable`). When Core runs as another user and those paths are
 *  not readable, fetch the public PEM and write the CA-only and the combined
 *  bundle to a private temporary directory (0700, files 0600). */
export async function localBrokerCa(
	ctx: CliContext,
	proxy: VaultBrokerProxy
): Promise<BrokerCaFiles> {
	const replacements = new Map<string, string>();
	const missing: string[] = [];
	for (const path of [proxy.caPath, proxy.caBundlePath]) {
		if (path && !(await isReadableFile(path))) {
			missing.push(path);
		}
	}
	if (missing.length === 0) {
		return { cleanup: () => Promise.resolve(), replacements };
	}
	const pem = await getVaultBrokerCaPem(machineTarget(ctx));
	const dir = await mkdtemp(join(tmpdir(), "ryu-broker-"));
	await chmod(dir, 0o700);
	const caOnly = join(dir, "ca.pem");
	const combined = join(dir, "ca-bundle.pem");
	const system = await systemCaBundle();
	await writeFile(caOnly, pem, { mode: 0o600 });
	await writeFile(combined, system ? `${system.trimEnd()}\n${pem}` : pem, {
		mode: 0o600,
	});
	if (proxy.caPath) {
		replacements.set(proxy.caPath, caOnly);
	}
	if (proxy.caBundlePath) {
		replacements.set(proxy.caBundlePath, combined);
	}
	return {
		cleanup: () => rm(dir, { recursive: true, force: true }),
		replacements,
	};
}

/** Runs the host-mode child under `guard`. Ctrl-C reaches the child through
 *  the terminal (same process group), so the CLI waits for its exit code.
 *  The runner exposes no child handle to pass SIGTERM/SIGHUP on, so on those
 *  the CLI stops waiting and unwinds, which revokes the session. */
export async function spawnUntilStopped(
	ctx: CliContext,
	guard: SignalGuard,
	command: string[],
	env: Record<string, string>
): Promise<number> {
	const stopped = new Promise<never>((_resolve, reject) => {
		guard.forwardTo((signal) => {
			if (signal !== "SIGINT") {
				reject(new IsolationCancelledError(signal));
			}
		});
	});
	try {
		return await Promise.race([ctx.spawn(command, env), stopped]);
	} finally {
		guard.forwardTo(null);
	}
}

// packages/core-client/src/vault/broker-env.ts
//
// Proxy environment for a credential-broker session: part of the Secret Vault
// client. `../vault.ts` re-exports these names.
//
// `buildVaultProxyEnv` renders the same variables Core's `broker::proxy_env`
// does (`apps/core/src/vault/broker/mod.rs`) for a session token and port,
// so a program that minted a session can start a child on any host or
// container address. `buildVaultBrokerContainerConfig` adds what a container
// needs: the CA PEM as a file to mount, the gateway host entry, and the env
// pointing at the mounted paths. Dummy values (`VAULT_BROKER_PLACEHOLDER`)
// let SDKs that refuse to start without an API key run; the broker replaces
// the auth header on the way out, so the dummy never reaches the upstream.

import type { VaultBrokerSessionGrant } from "./broker.ts";

/** The dummy value brokered credentials get in a child's environment. */
export const VAULT_BROKER_PLACEHOLDER = "__ryu_broker__";

/** Host name a container reaches the broker by (mapped to the host gateway). */
export const VAULT_BROKER_CONTAINER_HOST = "host.docker.internal";

/** Where the container config mounts the broker CA. */
export const VAULT_BROKER_CONTAINER_CA_PATH = "/etc/ryu-broker/ca.pem";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROXY_NAMES = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"];
const CA_ONLY_NAMES = ["NODE_EXTRA_CA_CERTS", "DENO_CERT"];
const CA_BUNDLE_NAMES = [
	"SSL_CERT_FILE",
	"REQUESTS_CA_BUNDLE",
	"CURL_CA_BUNDLE",
	"GIT_SSL_CAINFO",
];
const LOOPBACK_NO_PROXY = "localhost,127.0.0.1,::1";

/** SDK variables for the broker catalog's services (`broker/catalog.json`). */
const SERVICE_ENV_NAMES: Record<string, string[]> = {
	anthropic: ["ANTHROPIC_API_KEY"],
	openai: ["OPENAI_API_KEY"],
	github: ["GITHUB_TOKEN", "GH_TOKEN"],
	gitlab: ["GITLAB_TOKEN"],
	gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
	linear: ["LINEAR_API_KEY"],
	npm: ["NPM_TOKEN"],
	slack: ["SLACK_BOT_TOKEN"],
	stripe: ["STRIPE_SECRET_KEY", "STRIPE_API_KEY"],
};

export interface VaultProxyEnvInput {
	/** CA bundle path for OpenSSL/Python/curl/git (system roots + broker CA). */
	caBundlePath?: string;
	/** CA-only path for Node and Deno (which add it to their own roots). */
	caPath?: string;
	/** Proxy host the child reaches the broker by. Default `127.0.0.1`. */
	host?: string;
	/** `NO_PROXY`; default loopback. Pass `[]` to send everything to the broker. */
	noProxy?: string[];
	/** Variables to set to {@link VAULT_BROKER_PLACEHOLDER}. */
	placeholders?: string[];
	port: number;
	/** The session token (`rvb_…`); it travels as the proxy URL's password. */
	token: string;
}

function isEnvName(name: string): boolean {
	return ENV_NAME.test(name);
}

/** `KEY` from a `secret:KEY` reference, when it can be an env var name. */
function secretRefName(value: unknown): string | null {
	if (typeof value !== "string" || !value.startsWith("secret:")) {
		return null;
	}
	const name = value.slice("secret:".length).split("/").at(-1) ?? "";
	return isEnvName(name) ? name : null;
}

function collectRefs(value: unknown, into: Set<string>): void {
	const name = secretRefName(value);
	if (name) {
		into.add(name);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			collectRefs(item, into);
		}
	} else if (value && typeof value === "object") {
		for (const item of Object.values(value)) {
			collectRefs(item, into);
		}
	}
}

/** The SDK variables of the catalog service `name` (empty when unknown). */
export function vaultBrokerCatalogEnvNames(name: string): string[] {
	return [...(SERVICE_ENV_NAMES[name.toLowerCase()] ?? [])];
}

/**
 * Variable names that should hold a placeholder for brokered `services` -
 * the `secret:NAME` references in a service's `auth` when its definition is
 * known, else the SDK variables of a catalog service with that name.
 */
export function vaultBrokerPlaceholderNames(
	services: ReadonlyArray<string | { auth?: unknown; name: string }>
): string[] {
	const names = new Set<string>();
	for (const service of services) {
		const name = typeof service === "string" ? service : service.name;
		const refs = new Set<string>();
		if (typeof service !== "string") {
			collectRefs(service.auth, refs);
		}
		for (const ref of refs) {
			names.add(ref);
		}
		if (refs.size === 0) {
			for (const known of vaultBrokerCatalogEnvNames(name)) {
				names.add(known);
			}
		}
	}
	return [...names].sort();
}

function bracketHost(host: string): string {
	return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** The child-process environment for a broker session. */
export function buildVaultProxyEnv(
	input: VaultProxyEnvInput
): Record<string, string> {
	if (
		!(Number.isInteger(input.port) && input.port > 0 && input.port < 65_536)
	) {
		throw new Error("buildVaultProxyEnv: port must be 1-65535");
	}
	const host = bracketHost(input.host ?? "127.0.0.1");
	const proxy = `http://rvb:${encodeURIComponent(input.token)}@${host}:${input.port}`;
	const env: Record<string, string> = {};
	for (const name of input.placeholders ?? []) {
		if (!isEnvName(name)) {
			throw new Error(`buildVaultProxyEnv: invalid variable name ${name}`);
		}
		env[name] = VAULT_BROKER_PLACEHOLDER;
	}
	for (const name of PROXY_NAMES) {
		env[name] = proxy;
	}
	const noProxy = input.noProxy?.join(",") ?? LOOPBACK_NO_PROXY;
	env.NO_PROXY = noProxy;
	env.no_proxy = noProxy;
	env.NODE_USE_ENV_PROXY = "1";
	if (input.caPath) {
		for (const name of CA_ONLY_NAMES) {
			env[name] = input.caPath;
		}
	}
	const bundle = input.caBundlePath ?? input.caPath;
	if (bundle) {
		for (const name of CA_BUNDLE_NAMES) {
			env[name] = bundle;
		}
	}
	return env;
}

/** The proxy environment for a minted session, with placeholders for its
 *  services. Null when the broker is not listening. */
export function vaultProxyEnvFromGrant(
	grant: VaultBrokerSessionGrant,
	options: { host?: string; placeholders?: string[] } = {}
): Record<string, string> | null {
	if (!grant.proxy) {
		return null;
	}
	return buildVaultProxyEnv({
		token: grant.token,
		port: grant.proxy.port,
		host: options.host,
		caPath: grant.proxy.caPath,
		caBundlePath: grant.proxy.caBundlePath,
		placeholders:
			options.placeholders ??
			vaultBrokerPlaceholderNames(grant.session.services),
	});
}

export interface VaultBrokerContainerInput {
	/** A bundle the image builds from its roots plus the mounted CA. When
	 *  unset, OpenSSL-style variables point at the CA alone, which trusts only
	 *  hosts the broker terminates. */
	caBundlePath?: string;
	/** Where to mount the CA. Default {@link VAULT_BROKER_CONTAINER_CA_PATH}. */
	caPath?: string;
	/** The broker CA certificate (`getVaultBrokerCaPem`). */
	caPem: string;
	/** Default {@link VAULT_BROKER_CONTAINER_HOST}. */
	gatewayHost?: string;
	placeholders?: string[];
	port: number;
	token: string;
}

export interface VaultBrokerContainerConfig {
	/** Write `content` to a host file and bind-mount it read-only at `path`. */
	caFile: { content: string; path: string };
	/** The container's environment. No host variable is inherited. */
	env: Record<string, string>;
	/** `docker run --add-host` entries. */
	extraHosts: string[];
}

/**
 * Configuration for running a container through the broker: every request
 * goes to the proxy (`NO_PROXY` is empty), and the CA PEM is handed over
 * inline so the caller can mount it. The broker must listen where the gateway
 * host resolves (Core binds loopback; relay it, as `ryu secrets run
 * --isolation=container` does, when the container cannot reach the host's
 * loopback).
 */
export function buildVaultBrokerContainerConfig(
	input: VaultBrokerContainerInput
): VaultBrokerContainerConfig {
	if (!input.caPem.includes("-----BEGIN CERTIFICATE-----")) {
		throw new Error("buildVaultBrokerContainerConfig: caPem is not a PEM");
	}
	const caPath = input.caPath ?? VAULT_BROKER_CONTAINER_CA_PATH;
	const gatewayHost = input.gatewayHost ?? VAULT_BROKER_CONTAINER_HOST;
	const env = buildVaultProxyEnv({
		token: input.token,
		port: input.port,
		host: gatewayHost,
		caPath,
		caBundlePath: input.caBundlePath,
		noProxy: [],
		placeholders: input.placeholders,
	});
	return {
		caFile: { path: caPath, content: input.caPem },
		env,
		extraHosts: [`${gatewayHost}:host-gateway`],
	};
}

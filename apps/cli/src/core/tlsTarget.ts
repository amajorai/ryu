// TLS settings for the Core node the CLI talks to, for nodes behind a private
// CA or (for local testing only) a self-signed certificate:
//
//   --ca-cert FILE      / RYU_CA_CERT=FILE      trust the PEM bundle in FILE
//                                               in addition to the system roots
//   --tls-skip-verify   / RYU_TLS_SKIP_VERIFY=1 do not verify the certificate
//
// Flags win over the environment. They apply to https node URLs only, through
// Bun's per-request `tls` fetch option, so nothing else in the process (and no
// child process) changes its trust. Skipping verification prints a warning on
// every run: a node token then goes to whoever answers.

import {
	type ApiTarget,
	fetchForTarget,
	type RyuFetch,
} from "@ryuhq/core-client/client";

export interface TlsSettings {
	/** PEM text of extra trusted CAs. */
	ca?: string;
	rejectUnauthorized?: boolean;
}

export interface TlsFlags {
	caCert: string | null;
	tlsSkipVerify: boolean;
}

function truthy(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase() ?? "";
	return normalized !== "" && normalized !== "0" && normalized !== "false";
}

/**
 * The settings the flags and environment ask for, or null for the default
 * (system roots, verification on). Throws when the CA file cannot be read
 * or holds no PEM certificate.
 */
export function tlsSettings(
	flags: TlsFlags,
	env: Record<string, string | undefined>,
	readFile: (path: string) => string
): TlsSettings | null {
	const caPath = flags.caCert ?? (env.RYU_CA_CERT?.trim() || null);
	const skip = flags.tlsSkipVerify || truthy(env.RYU_TLS_SKIP_VERIFY);
	if (!(caPath || skip)) {
		return null;
	}
	const settings: TlsSettings = {};
	if (caPath) {
		let pem: string;
		try {
			pem = readFile(caPath);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`Could not read the CA bundle ${caPath}: ${reason}`);
		}
		if (!pem.includes("-----BEGIN CERTIFICATE-----")) {
			throw new Error(`${caPath} holds no PEM certificate.`);
		}
		settings.ca = pem;
	}
	if (skip) {
		settings.rejectUnauthorized = false;
	}
	return settings;
}

/** `target` with its https requests made under `settings`. */
export function withTargetTls(
	target: ApiTarget,
	settings: TlsSettings | null
): ApiTarget {
	if (!(settings && target.url.toLowerCase().startsWith("https://"))) {
		return target;
	}
	const inner = fetchForTarget(target);
	const tlsFetch: RyuFetch = (input, init) =>
		inner(input, { ...init, tls: settings } as RequestInit);
	return { ...target, fetch: tlsFetch };
}

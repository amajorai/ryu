// packages/services-cli/src/curl.ts
//
// `--dry-run`: the CLI swaps in a capture fetch, so the SDK builds the exact
// request it would send (auth header, Accept, Idempotency-Key, body) and the
// CLI prints it as a curl command instead. Nothing leaves the machine.
//
// Keys never reach the output. Before the client is built, every key of the
// target service is replaced by its env placeholder (`$RYU_NOTIFY_API_KEY`,
// `$RYU_GATEWAY_TOKEN`, `$RYU_MAIL_GATEWAY_KEY`), so the captured request
// only ever holds the placeholder; the printer then redacts auth headers and
// scrubs any real secret it is given, as a second line of defence.

import type { RyuFetch, RyuService } from "@ryuhq/services";
import { CONTROL_PLANE_URL, ENV_VARS } from "@ryuhq/services";

/** One request the capture fetch saw. */
export interface CapturedRequest {
	readonly body: string | null;
	/** Lower-case names, in the order the request carried them. */
	readonly headers: readonly (readonly [string, string])[];
	readonly method: string;
	readonly url: string;
}

/** A fetch that records requests instead of sending them. */
export interface CaptureFetch {
	readonly fetch: RyuFetch;
	readonly requests: readonly CapturedRequest[];
}

/** The code of the synthetic response a captured request gets. */
export const DRY_RUN_CODE = "dry_run";

/**
 * A fetch that records each request and answers with a synthetic 400
 * (`dry_run`): a 4xx is never retried, and it stops reconnecting streams, so
 * a dry run settles after the first request.
 */
export function createCaptureFetch(): CaptureFetch {
	const requests: CapturedRequest[] = [];
	const fetch: RyuFetch = async (input, init) => {
		const request = new Request(input, init);
		const body = request.body === null ? null : await request.clone().text();
		requests.push({
			method: request.method,
			url: request.url,
			headers: [...request.headers.entries()],
			body,
		});
		return new Response(
			JSON.stringify({
				error: {
					code: DRY_RUN_CODE,
					message: "Dry run: the request was printed, not sent.",
				},
			}),
			{ status: 400, headers: { "content-type": "application/json" } }
		);
	};
	return { fetch, requests };
}

const KEY_ROLES = new Set([
	"key",
	"gateway-key",
	"management-key",
	"runtime-key",
]);

/** Every env var that holds a credential, for any service. */
export const SECRET_ENV_VARS: readonly string[] = ENV_VARS.filter((row) =>
	KEY_ROLES.has(row.role)
).map((row) => row.name);

function envValue(
	env: Readonly<Record<string, string | undefined>>,
	name: string
): string | undefined {
	const value = env[name]?.trim();
	return value ? value : undefined;
}

function originOf(url: string | undefined): string | null {
	if (url === undefined) {
		return null;
	}
	try {
		return new URL(url).origin;
	} catch {
		return null;
	}
}

/**
 * Whether `--api-key` means the self-hosted Mail bearer (`apiKey`) or the
 * hosted gateway key (`gatewayKey`): self-hosted when a Mail URL is given
 * that is not the control-plane origin, matching the SDK's precedence.
 */
export function mailKeyField(
	env: Readonly<Record<string, string | undefined>>,
	baseUrlFlag: string | undefined
): "apiKey" | "gatewayKey" {
	const url = baseUrlFlag ?? envValue(env, "RYU_MAIL_URL");
	const controlPlane = envValue(env, "RYU_API_URL") ?? CONTROL_PLANE_URL;
	const urlOrigin = originOf(url);
	return urlOrigin !== null && urlOrigin !== originOf(controlPlane)
		? "apiKey"
		: "gatewayKey";
}

/**
 * The env var `--api-key` (or the service's main key) stands for. Hosted Mail
 * with neither Mail key set but `RYU_API_KEY` present is reached with that
 * `ryu_` key, unless `--api-key` was given (it fills the gateway key).
 */
export function primaryKeyEnv(
	service: RyuService,
	env: Readonly<Record<string, string | undefined>> = {},
	baseUrlFlag?: string,
	apiKeyFlagGiven = false
): string {
	if (service === "mail") {
		if (mailKeyField(env, baseUrlFlag) === "apiKey") {
			return "RYU_MAIL_API_KEY";
		}
		const ryuKeyOnly =
			!apiKeyFlagGiven &&
			envValue(env, "RYU_MAIL_GATEWAY_KEY") === undefined &&
			envValue(env, "RYU_MAIL_API_KEY") === undefined &&
			envValue(env, "RYU_API_KEY") !== undefined;
		return ryuKeyOnly ? "RYU_API_KEY" : "RYU_MAIL_GATEWAY_KEY";
	}
	const row = ENV_VARS.find(
		(entry) => entry.service === service && entry.role === "key"
	);
	return row?.name ?? "RYU_API_KEY";
}

/** `$NAME`: how a key appears in dry-run output. */
export function placeholder(envName: string): string {
	return `$${envName}`;
}

/** The env and `--api-key` value a dry run builds its client with. */
export interface DryRunCredentials {
	/** The placeholder to pass as the `--api-key` option, when the flag was given. */
	readonly apiKey: string | undefined;
	readonly env: Record<string, string | undefined>;
}

/**
 * Replaces every key of `service` with its placeholder. When the service has
 * no key at all, its main key is set to the placeholder so a dry run works
 * without credentials (Gateway's token is optional and stays unset).
 */
export function dryRunCredentials(
	service: RyuService,
	env: Readonly<Record<string, string | undefined>>,
	flags: { apiKey?: string; baseUrl?: string }
): DryRunCredentials {
	const next: Record<string, string | undefined> = { ...env };
	let anyKey = false;
	for (const row of ENV_VARS) {
		if (
			row.service === service &&
			KEY_ROLES.has(row.role) &&
			envValue(env, row.name)
		) {
			next[row.name] = placeholder(row.name);
			anyKey = true;
		}
	}
	const primary = primaryKeyEnv(
		service,
		env,
		flags.baseUrl,
		flags.apiKey !== undefined
	);
	if (service === "mail" && primary === "RYU_API_KEY") {
		next[primary] = placeholder(primary);
		anyKey = true;
	}
	const apiKey = flags.apiKey === undefined ? undefined : placeholder(primary);
	if (!(anyKey || apiKey !== undefined || service === "gateway")) {
		next[primary] = placeholder(primary);
	}
	return { env: next, apiKey };
}

const AUTH_HEADERS = new Set(["authorization", "x-api-key", "x-gateway-key"]);
const PLACEHOLDER = /\$RYU_[A-Z0-9_]+/gu;
const HAS_PLACEHOLDER = /\$RYU_[A-Z0-9_]+/u;
const SAFE_LITERAL = /^[A-Za-z0-9 _:./,=+@%-]*$/u;
const MIN_SECRET_LENGTH = 4;

/** Single-quotes `value` for POSIX shells. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Quotes `value` so `$RYU_*` placeholders still expand: double quotes when
 * the rest is plain, otherwise literal parts single-quoted and placeholders
 * spliced in as `"$NAME"`.
 */
export function quoteWithPlaceholders(value: string): string {
	const placeholders = value.match(PLACEHOLDER);
	if (placeholders === null) {
		return shellQuote(value);
	}
	const literals = value.split(PLACEHOLDER);
	if (literals.every((part) => SAFE_LITERAL.test(part))) {
		return `"${value}"`;
	}
	let quoted = "";
	literals.forEach((part, index) => {
		if (part !== "") {
			quoted += shellQuote(part);
		}
		const name = placeholders[index];
		if (name !== undefined) {
			quoted += `"${name}"`;
		}
	});
	return quoted;
}

function redactAuthHeader(
	name: string,
	value: string,
	keyPlaceholder: string
): string {
	if (!AUTH_HEADERS.has(name) || HAS_PLACEHOLDER.test(value)) {
		return value;
	}
	return name === "authorization" ? `Bearer ${keyPlaceholder}` : keyPlaceholder;
}

function scrub(text: string, secrets: readonly string[]): string {
	let result = text;
	for (const secret of secrets) {
		if (secret.length >= MIN_SECRET_LENGTH && !secret.startsWith("$RYU_")) {
			result = result.replaceAll(secret, "[redacted]");
		}
	}
	return result;
}

/** Options for {@link toCurl}. */
export interface CurlOptions {
	/** Used for an auth header that somehow carries no placeholder. */
	readonly keyPlaceholder: string;
	/** Real secret values to scrub from the output wherever they appear. */
	readonly secrets?: readonly string[];
}

/** The request with auth headers forced to placeholders and real secrets scrubbed. */
export function redactRequest(
	request: CapturedRequest,
	options: CurlOptions
): CapturedRequest {
	const secrets = options.secrets ?? [];
	return {
		method: request.method,
		url: scrub(request.url, secrets),
		headers: request.headers.map(
			([name, value]) =>
				[
					name,
					scrub(redactAuthHeader(name, value, options.keyPlaceholder), secrets),
				] as const
		),
		body: request.body === null ? null : scrub(request.body, secrets),
	};
}

/** Formats a captured request as a multi-line curl command, redacted as {@link redactRequest}. */
export function toCurl(request: CapturedRequest, options: CurlOptions): string {
	const safe = redactRequest(request, options);
	const parts = [`curl -X ${safe.method} ${shellQuote(safe.url)}`];
	for (const [name, value] of safe.headers) {
		parts.push(`-H ${quoteWithPlaceholders(`${name}: ${value}`)}`);
	}
	if (safe.body !== null) {
		parts.push(`--data-raw ${shellQuote(safe.body)}`);
	}
	return parts.join(" \\\n  ");
}

/** Real credential values from `env` and `--api-key`, for {@link toCurl}'s scrubber. */
export function collectSecrets(
	env: Readonly<Record<string, string | undefined>>,
	apiKeyFlag: string | undefined
): string[] {
	const secrets = SECRET_ENV_VARS.map((name) => envValue(env, name)).filter(
		(value): value is string => value !== undefined
	);
	if (apiKeyFlag) {
		secrets.push(apiKeyFlag);
	}
	return secrets;
}

// packages/services-cli/src/commands/webhooks.ts
//
// `ryu-services webhooks verify --service mail|notify|messaging [--kind destination|callback]
// [--scheme standard|legacy] [--require-timestamp|--allow-body-only-signature]
// [--secret @file] --headers @h.json < payload`: checks a delivery's signature with
// `@ryuhq/services/webhooks` and prints its parsed body. Exit 4 means the
// delivery was rejected. The payload is read raw from stdin, never re-encoded.
// The secret comes from `--secret @file`, `--secret value` or RYU_WEBHOOK_SECRET.

import type { RyuError } from "@ryuhq/services";
import { isRyuError } from "@ryuhq/services";
import {
	type VerifyWebhookOptions,
	verifyWebhook,
	type WebhookService,
} from "@ryuhq/services/webhooks";
import {
	booleanFlag,
	CliUsageError,
	type FlagSpecs,
	numberFlag,
	type ParsedFlags,
	requireStringFlag,
	stringFlag,
} from "../args.ts";
import {
	EXIT_CODES,
	type ExitCode,
	printError,
	printSuccess,
} from "../output.ts";
import type { CommandIo } from "../registry.ts";

/** The env var `webhooks verify` reads the signing secret from when `--secret` is absent. */
export const WEBHOOK_SECRET_ENV = "RYU_WEBHOOK_SECRET";

/** The `webhooks verify` synopsis for help output. */
export const WEBHOOKS_VERIFY_USAGE =
	"ryu-services webhooks verify --service mail|notify|messaging [--kind destination|callback] [--scheme standard|legacy] [--require-timestamp|--allow-body-only-signature] [--secret @file] --headers @h.json < payload";

/** `webhooks verify` flags. */
export const WEBHOOKS_VERIFY_FLAGS: FlagSpecs = {
	service: {
		type: "string",
		valueName: "mail|notify|messaging",
		description: "Which service signed the delivery.",
		required: true,
	},
	kind: {
		type: "string",
		valueName: "destination|callback",
		description:
			"Notify only: a channel destination delivery or a response callback.",
	},
	secret: {
		type: "string",
		valueName: "@file|secret",
		description: `The signing secret (whsec_… for Mail and Messaging), or @path to a file holding it. Prefer @file or ${WEBHOOK_SECRET_ENV}: a literal value ends up in shell history and process listings.`,
	},
	scheme: {
		type: "string",
		valueName: "standard|legacy",
		description:
			"Mail only: legacy for a webhook created before Standard Webhooks signing (default standard).",
	},
	"allow-body-only-signature": {
		type: "boolean",
		description:
			"Notify destinations only: accept the body-only x-ryu-notify-signature when the webhook-* headers are absent. It has no timestamp, so a captured delivery can be replayed; by default such a delivery is rejected (allowBodyOnlySignature).",
	},
	"require-timestamp": {
		type: "boolean",
		description:
			"Notify destinations only: reject a delivery without the webhook-id, webhook-timestamp and webhook-signature headers. This is already the default; the flag is kept for scripts (requireTimestamp).",
	},
	headers: {
		type: "string",
		valueName: "@file|json",
		description:
			"The delivery's headers as a JSON object mapping each header name to its value, inline or @path to a file.",
		required: true,
	},
	tolerance: {
		type: "number",
		valueName: "seconds",
		description: "Accepted clock skew for timestamped schemes (default 300).",
	},
};

/** The verifier the command calls; injectable so tests do not depend on the webhooks work package. */
export type WebhookVerifier = (
	options: VerifyWebhookOptions
) => Promise<unknown>;

const SERVICES: readonly WebhookService[] = ["mail", "notify", "messaging"];
const KINDS = ["destination", "callback"] as const;
const SCHEMES = ["standard", "legacy"] as const;

function isScheme(value: string): value is (typeof SCHEMES)[number] {
	return (SCHEMES as readonly string[]).includes(value);
}

/**
 * The signing secret: `--secret @path` reads a file (trailing newline
 * trimmed), `--secret value` is taken as is, and with no flag
 * {@link WEBHOOK_SECRET_ENV} is used.
 */
export async function resolveWebhookSecret(
	flags: ParsedFlags,
	io: CommandIo
): Promise<string> {
	const flag = stringFlag(flags, "secret");
	let secret: string | undefined;
	if (flag === undefined) {
		secret = io.env[WEBHOOK_SECRET_ENV];
	} else if (flag.startsWith("@")) {
		secret = (await io.readFile(flag.slice(1))).replace(/\r?\n$/u, "");
	} else {
		secret = flag;
	}
	if (secret === undefined || secret.trim() === "") {
		throw new CliUsageError(
			`A signing secret is required: pass --secret @file or set ${WEBHOOK_SECRET_ENV}.`
		);
	}
	return secret;
}

function isWebhookService(value: string): value is WebhookService {
	return (SERVICES as readonly string[]).includes(value);
}

function isKind(value: string): value is (typeof KINDS)[number] {
	return (KINDS as readonly string[]).includes(value);
}

/** Parses `--headers` JSON into a string record. */
export function parseHeadersJson(text: string): Record<string, string> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new CliUsageError("--headers is not valid JSON.");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new CliUsageError(
			"--headers must be a JSON object of header names to values."
		);
	}
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(parsed)) {
		if (typeof value !== "string") {
			throw new CliUsageError(
				`--headers value for ${JSON.stringify(name)} must be a string.`
			);
		}
		headers[name] = value;
	}
	return headers;
}

/** The stdin payload as raw bytes, so a BOM or non-UTF-8 byte reaches the HMAC unchanged. */
async function readPayload(io: CommandIo): Promise<Uint8Array> {
	return io.readStdinBytes === undefined
		? new TextEncoder().encode(await io.readStdin())
		: await io.readStdinBytes();
}

/** Builds the verifier options from flags, reading `@file` headers and the stdin payload. */
export async function verifyOptionsFromFlags(
	flags: ParsedFlags,
	io: CommandIo
): Promise<VerifyWebhookOptions> {
	const service = requireStringFlag(flags, "service");
	if (!isWebhookService(service)) {
		throw new CliUsageError(`--service must be one of ${SERVICES.join(", ")}.`);
	}
	const kind = stringFlag(flags, "kind");
	if (kind !== undefined && !isKind(kind)) {
		throw new CliUsageError(`--kind must be one of ${KINDS.join(", ")}.`);
	}
	if (kind !== undefined && service !== "notify") {
		throw new CliUsageError("--kind applies to --service notify only.");
	}
	const scheme = stringFlag(flags, "scheme");
	if (scheme !== undefined && !isScheme(scheme)) {
		throw new CliUsageError(`--scheme must be one of ${SCHEMES.join(", ")}.`);
	}
	if (scheme !== undefined && service !== "mail") {
		throw new CliUsageError("--scheme applies to --service mail only.");
	}
	const requireTimestamp = booleanFlag(flags, "require-timestamp");
	if (requireTimestamp && service !== "notify") {
		throw new CliUsageError(
			"--require-timestamp applies to --service notify only."
		);
	}
	if (requireTimestamp && kind === "callback") {
		throw new CliUsageError(
			"--require-timestamp applies to Notify destination deliveries, not --kind callback."
		);
	}
	const allowBodyOnly = booleanFlag(flags, "allow-body-only-signature");
	if (allowBodyOnly && service !== "notify") {
		throw new CliUsageError(
			"--allow-body-only-signature applies to --service notify only."
		);
	}
	if (allowBodyOnly && kind === "callback") {
		throw new CliUsageError(
			"--allow-body-only-signature applies to Notify destination deliveries, not --kind callback."
		);
	}
	if (allowBodyOnly && requireTimestamp) {
		throw new CliUsageError(
			"--allow-body-only-signature and --require-timestamp contradict each other; pass one."
		);
	}
	const secret = await resolveWebhookSecret(flags, io);
	const headersArg = requireStringFlag(flags, "headers");
	const headersText = headersArg.startsWith("@")
		? await io.readFile(headersArg.slice(1))
		: headersArg;
	const options: VerifyWebhookOptions = {
		service,
		secret,
		headers: parseHeadersJson(headersText),
		payload: await readPayload(io),
	};
	const tolerance = numberFlag(flags, "tolerance");
	return {
		...options,
		...(kind === undefined ? {} : { kind }),
		...(scheme === undefined ? {} : { scheme }),
		...(tolerance === undefined ? {} : { toleranceSeconds: tolerance }),
		...(requireTimestamp ? { requireTimestamp: true } : {}),
		...(allowBodyOnly ? { allowBodyOnlySignature: true } : {}),
	};
}

function exitFor(error: RyuError): ExitCode {
	if (error.code.startsWith("webhook_")) {
		return EXIT_CODES.webhookVerification;
	}
	return error.status === 0 ? EXIT_CODES.usage : EXIT_CODES.error;
}

/** Runs `webhooks verify`. Exit 0 verified, 4 rejected, 2 bad usage or configuration. */
export async function runWebhooksVerify(
	flags: ParsedFlags,
	io: CommandIo,
	json: boolean,
	verify: WebhookVerifier = verifyWebhook
): Promise<ExitCode> {
	const options = await verifyOptionsFromFlags(flags, io);
	try {
		const body = await verify(options);
		printSuccess(io.stdout, json, body, null);
		return EXIT_CODES.ok;
	} catch (error) {
		if (!isRyuError(error)) {
			throw error;
		}
		printError(io, json, error);
		return exitFor(error);
	}
}

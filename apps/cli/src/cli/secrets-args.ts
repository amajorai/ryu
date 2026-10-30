import type {
	VaultCoords,
	VaultPasswordManagerGrantMode,
	VaultSecretMetadataPatch,
} from "@ryuhq/core-client/vault";
import { z } from "zod";
import { UsageError } from "./types.ts";

// ── Local flag parsing ───────────────────────────────────────────────────────

/** Global value flags owned by the dispatcher; skipped (with their value) here. */
const GLOBAL_VALUE_FLAGS = new Set([
	"--agent",
	"--kind",
	"--node",
	"--template",
]);

/** Global boolean flags owned by the dispatcher; skipped here. */
const GLOBAL_BOOLEAN_FLAGS = new Set([
	"--json",
	"--force",
	"--cascade",
	"--dry-run",
	"--fix",
	"--include-secrets",
]);

const VALUE_FLAGS = new Set([
	"--address-line1",
	"--address-line2",
	"--address",
	"--allow",
	"--approvals",
	"--before",
	"--broker",
	"--cardholder",
	"--city",
	"--country",
	"--description",
	"--env",
	"--exp",
	"--expires-at",
	"--field",
	"--format",
	"--grant",
	"--image",
	"--increment",
	"--isolation",
	"--k8s-name",
	"--k8s-namespace",
	"--limit",
	"--max-uses",
	"--merchant",
	"--method",
	"--mode",
	"--mount",
	"--name",
	"--on-conflict",
	"--passphrase",
	"--path",
	"--position",
	"--postal-code",
	"--provider",
	"--reason",
	"--region",
	"--rotate-every",
	"--scope",
	"--scope-id",
	"--service",
	"--status",
	"--subject",
	"--tag",
	"--ttl",
	"--type",
]);

const BOOLEAN_FLAGS = new Set([
	"--all",
	"--approle",
	"--container",
	"--jwt",
	"--no-known-values",
	"--protected",
	"--unprotected",
	"--verify",
]);

/** Card secrets are never taken as arguments (visible in `ps` and history). */
const REFUSED_CARD_FLAGS = new Set([
	"--number",
	"--card-number",
	"--pan",
	"--cvc",
	"--cvv",
]);

export interface SecretsArgs {
	booleans: Set<string>;
	/** Tokens after `--`, verbatim (the `run` command line). */
	passthrough: string[] | null;
	positional: string[];
	values: Map<string, string[]>;
}

/** Parse the raw tokens after `secrets`. Unknown flags are usage errors so a
 *  typo can never silently write to the wrong environment. */
export function parseSecretsArgs(raw: string[]): SecretsArgs {
	const parsed: SecretsArgs = {
		booleans: new Set(),
		passthrough: null,
		positional: [],
		values: new Map(),
	};
	for (let index = 0; index < raw.length; index++) {
		const token = raw[index] ?? "";
		if (token === "--") {
			parsed.passthrough = raw.slice(index + 1);
			break;
		}
		if (token === "-" || !token.startsWith("-")) {
			parsed.positional.push(token);
			continue;
		}
		const eq = token.indexOf("=");
		const name = eq === -1 ? token : token.slice(0, eq);
		if (GLOBAL_BOOLEAN_FLAGS.has(name)) {
			continue;
		}
		if (GLOBAL_VALUE_FLAGS.has(name)) {
			index += eq === -1 ? 1 : 0;
			continue;
		}
		if (BOOLEAN_FLAGS.has(name)) {
			parsed.booleans.add(name);
			continue;
		}
		if (REFUSED_CARD_FLAGS.has(name)) {
			throw new UsageError(
				`${name} is not accepted: arguments are visible to other processes and shell history. Pipe the card number and CVC on stdin.`
			);
		}
		if (!VALUE_FLAGS.has(name)) {
			throw new UsageError(`Unknown flag ${name}. Run 'ryu-cli secrets help'.`);
		}
		let value: string | undefined;
		if (eq === -1) {
			value = raw[index + 1];
			index++;
		} else {
			value = token.slice(eq + 1);
		}
		if (value === undefined) {
			throw new UsageError(`Flag ${name} needs a value.`);
		}
		parsed.values.set(name, [...(parsed.values.get(name) ?? []), value]);
	}
	return parsed;
}

export function flag(args: SecretsArgs, name: string): string | undefined {
	const values = args.values.get(name);
	return values?.at(-1);
}

export function intFlag(args: SecretsArgs, name: string): number | undefined {
	const value = flag(args, name);
	if (value === undefined) {
		return undefined;
	}
	const parsed = Number(value);
	if (!Number.isInteger(parsed)) {
		throw new UsageError(`${name} must be an integer.`);
	}
	return parsed;
}

export function arg(args: SecretsArgs, index: number, usage: string): string {
	const value = args.positional[index];
	if (!value) {
		throw new UsageError(`Usage: ryu-cli secrets ${usage}`);
	}
	return value;
}

const vaultScopeSchema = z.enum(["user", "node", "team", "org"]);

export function coordsFrom(args: SecretsArgs): VaultCoords {
	const parsedScope = vaultScopeSchema.safeParse(
		flag(args, "--scope") ?? "user"
	);
	if (!parsedScope.success) {
		throw new UsageError("--scope must be user, node, team, or org.");
	}
	const coords: VaultCoords = { scope: parsedScope.data };
	const scopeId = flag(args, "--scope-id");
	const environment = flag(args, "--env");
	const path = flag(args, "--path");
	if (scopeId) {
		coords.scopeId = scopeId;
	}
	if (environment) {
		coords.environment = environment;
	}
	if (path) {
		coords.path = path;
	}
	return coords;
}

const DURATION = /^(\d+)\s*([smhdw]?)$/;
const DURATION_SECONDS = new Map<string, number>([
	["", 1],
	["s", 1],
	["m", 60],
	["h", 3600],
	["d", 86_400],
	["w", 604_800],
]);

/** `3600`, `90m`, `12h`, `30d`, `2w` → seconds. */
export function parseDuration(value: string): number {
	const match = DURATION.exec(value.trim());
	const amount = Number(match?.[1]);
	const unit = DURATION_SECONDS.get(match?.[2] ?? "x");
	if (!(match && unit && Number.isFinite(amount) && amount > 0)) {
		throw new UsageError(
			`Invalid duration '${value}'. Use seconds or a suffix: 90m, 12h, 30d, 2w.`
		);
	}
	return amount * unit;
}

export function rfc3339(value: string, name: string): string {
	const millis = Date.parse(value);
	if (Number.isNaN(millis)) {
		throw new UsageError(`${name} must be an RFC 3339 timestamp.`);
	}
	return new Date(millis).toISOString();
}

export function metadataFrom(
	args: SecretsArgs
): VaultSecretMetadataPatch | undefined {
	const metadata: VaultSecretMetadataPatch = {};
	const description = flag(args, "--description");
	const tags = args.values.get("--tag");
	const expiresAt = flag(args, "--expires-at");
	const rotateEvery = flag(args, "--rotate-every");
	if (description !== undefined) {
		metadata.description = description;
	}
	if (tags) {
		metadata.tags = tags;
	}
	if (expiresAt !== undefined) {
		metadata.expiresAt = rfc3339(expiresAt, "--expires-at");
	}
	if (rotateEvery !== undefined) {
		metadata.rotationPeriodSecs = parseDuration(rotateEvery);
	}
	return Object.keys(metadata).length > 0 ? metadata : undefined;
}

const pmGrantSchema = z.enum(["once", "1h", "24h", "30d"]);

export function grantFlag(
	args: SecretsArgs
): VaultPasswordManagerGrantMode | undefined {
	const value = flag(args, "--grant");
	if (value === undefined) {
		return undefined;
	}
	const parsed = pmGrantSchema.safeParse(value);
	if (!parsed.success) {
		throw new UsageError("--grant must be once, 1h, 24h, or 30d.");
	}
	return parsed.data;
}

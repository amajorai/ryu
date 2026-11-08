// Value-type redaction for AI agent sessions (`secrets-agent-guard.ts`).
//
// Redaction follows the value type: a coding agent may read `config` values,
// never `secret` or `sealed` ones. `get` prints a value only when every row it
// could be is `config`, and `export` emits only names whose every listed row
// is `config`. Both check the types before and after reading, so a value
// re-typed in between is refused instead of printed. A run the guard routes
// through the credential broker also gets the `config` values in its
// environment, because the broker carries only credentials.
//
// Everything here fails closed. The types come from the node's listing, so a
// machine token (`RYU_VAULT_TOKEN`, which cannot list), a listing that fails,
// or one that is missing its Team and Organization rows (`sharedError`)
// refuses `get`/`export` and adds nothing to a run. Messages name values and
// counts only, never a value.

import {
	listVaultSecrets,
	parseVaultJsonExport,
	revealVaultSecret,
	type VaultSecret,
	vaultValueType,
} from "@ryuhq/core-client/vault";
import { tf, tr } from "../i18n/translate.ts";
import { arg, coordsFrom, type SecretsArgs } from "./secrets-args.ts";
import { agentTarget, exportFormat, exportResult } from "./secrets-output.ts";
import { selectTagged } from "./secrets-run-env.ts";
import type { CliContext } from "./types.ts";
import { withStepUpHint } from "./vaultStepUp.ts";

/** Whether an AI agent session may read a value of this listing row's type. */
export function agentReadable(secret: VaultSecret): boolean {
	return vaultValueType(secret.metadata) === "config";
}

/**
 * The names an agent may read: those whose every listed row, in any scope,
 * environment or folder, is `config`. A name with any other row is left out,
 * so whichever row export resolution picks for it is `config`.
 */
export function agentReadableNames(secrets: VaultSecret[]): Set<string> {
	const verdict = new Map<string, boolean>();
	for (const secret of secrets) {
		verdict.set(
			secret.name,
			(verdict.get(secret.name) ?? true) && agentReadable(secret)
		);
	}
	return new Set(
		[...verdict].filter(([, readable]) => readable).map(([name]) => name)
	);
}

function normalizedPath(path: string | undefined): string {
	const trimmed = (path ?? "/").replace(/\/+$/, "");
	return trimmed.startsWith("/") ? trimmed || "/" : `/${trimmed}`;
}

/** The environment Core's reveal uses when the request names none. */
const REVEAL_DEFAULT_ENVIRONMENT = "default";

/**
 * The listing rows a `get` with these arguments could reveal. The environment
 * is pinned to the one the reveal resolves (Core's `default` when `--env` is
 * unset), so a row the listing hides there cannot be stood in for by a
 * `config` row of the same name in another environment.
 */
export function rowsForGet(
	secrets: VaultSecret[],
	name: string,
	args: SecretsArgs
): VaultSecret[] {
	const coords = coordsFrom(args);
	const path = normalizedPath(coords.path);
	const environment = coords.environment ?? REVEAL_DEFAULT_ENVIRONMENT;
	return secrets.filter(
		(secret) =>
			secret.name === name &&
			secret.scope === coords.scope &&
			secret.binding === undefined &&
			(coords.scopeId === undefined || secret.scopeId === coords.scopeId) &&
			secret.environment === environment &&
			normalizedPath(secret.path) === path
	);
}

/**
 * Every visible row on the node, or null when the listing fails or is
 * incomplete: when the control plane could not be reached, the listing holds
 * only local rows while an export can still resolve Team and Organization
 * values, so the types cannot be checked.
 */
async function listedRows(ctx: CliContext): Promise<VaultSecret[] | null> {
	try {
		const { secrets, sharedError } = await listVaultSecrets(ctx.target);
		return sharedError === null ? secrets : null;
	} catch {
		return null;
	}
}

function refuse(ctx: CliContext, message: string): number {
	ctx.io.err(`${message}\n`);
	return 1;
}

function refuseUnchecked(ctx: CliContext, marker: string): number {
	return refuse(
		ctx,
		tf(
			"Refusing to print values in an AI agent session ({marker} is set): their value types could not be checked, and only config values may be shown. A person at a terminal can add --human.",
			{ marker }
		)
	);
}

/** `get NAME` in an agent session: prints only a `config` value. */
export async function agentGet(
	ctx: CliContext,
	args: SecretsArgs,
	marker: string
): Promise<number> {
	const name = arg(args, 1, "get NAME [VERSION]");
	if (agentTarget(ctx)) {
		return refuseUnchecked(ctx, marker);
	}
	// A value re-typed to config keeps its older versions, written as secret.
	if (args.positional[2] !== undefined) {
		return refuse(
			ctx,
			tf(
				"Refusing to print an earlier version in an AI agent session ({marker} is set); only the current version of a config value may be shown.",
				{ marker }
			)
		);
	}
	const readable = async (): Promise<boolean | null> => {
		const rows = await listedRows(ctx);
		if (rows === null) {
			return null;
		}
		const matching = rowsForGet(rows, name, args);
		return matching.length > 0 && matching.every(agentReadable);
	};
	const before = await readable();
	if (before === null) {
		return refuseUnchecked(ctx, marker);
	}
	if (!before) {
		return refuse(
			ctx,
			tf(
				"Refusing to print {name} in an AI agent session ({marker} is set): it is not a config value. Let a command use it with 'ryu-cli secrets run --broker SERVICE -- CMD'. A person at a terminal can add --human.",
				{ name, marker }
			)
		);
	}
	const result = await withStepUpHint(() =>
		revealVaultSecret(ctx.target, name, coordsFrom(args))
	);
	if ((await readable()) !== true) {
		return refuseUnchecked(ctx, marker);
	}
	if (ctx.flags.json) {
		ctx.io.out(`${JSON.stringify(result, null, 2)}\n`);
	} else {
		ctx.io.out(`${result.value}\n`);
	}
	return 0;
}

/**
 * Narrow `--name` (every listed name when unset) to the agent-readable names.
 * Returns how many requested names were left out. An empty list still
 * restricts: Core exports nothing for `names: []`.
 */
function narrowToReadable(
	args: SecretsArgs,
	rows: VaultSecret[],
	readable: Set<string>
): number {
	const requested = args.values.get("--name") ?? [
		...new Set(rows.map((row) => row.name)),
	];
	const kept = requested.filter((name) => readable.has(name));
	args.values.set("--name", kept);
	return requested.length - kept.length;
}

function stillReadable(rows: VaultSecret[] | null, names: string[]): boolean {
	if (rows === null) {
		return false;
	}
	const readable = agentReadableNames(rows);
	return names.every((name) => readable.has(name));
}

/** `export` in an agent session: emits the `config` values only. */
export async function agentExport(
	ctx: CliContext,
	args: SecretsArgs,
	marker: string
): Promise<number> {
	if (agentTarget(ctx)) {
		return refuseUnchecked(ctx, marker);
	}
	const format = exportFormat(args);
	await selectTagged(ctx, args);
	const rows = await listedRows(ctx);
	if (rows === null) {
		return refuseUnchecked(ctx, marker);
	}
	const leftOut = narrowToReadable(args, rows, agentReadableNames(rows));
	const names = args.values.get("--name") ?? [];
	const result = await exportResult(ctx, args, format);
	if (!stillReadable(await listedRows(ctx), names)) {
		return refuseUnchecked(ctx, marker);
	}
	ctx.io.err(
		`${tf("AI agent session detected ({marker}): exporting config values only; {count} secret or sealed values were left out.", { marker, count: String(leftOut) })}\n`
	);
	if (ctx.flags.json) {
		ctx.io.out(`${JSON.stringify(result, null, 2)}\n`);
		return 0;
	}
	ctx.io.out(
		result.content.endsWith("\n") ? result.content : `${result.content}\n`
	);
	return 0;
}

/**
 * The `config` values for a broker run in an agent session: the broker
 * carries only credentials, so plain configuration goes into the command's
 * environment. Anything that cannot be checked adds nothing.
 */
export async function agentConfigEnvironment(
	ctx: CliContext,
	args: SecretsArgs
): Promise<Record<string, string>> {
	if (agentTarget(ctx)) {
		return {};
	}
	const rows = await listedRows(ctx);
	if (rows === null) {
		ctx.io.err(
			`${tr("Could not list value types, so no config values were added to the command's environment.")}\n`
		);
		return {};
	}
	const readable = agentReadableNames(rows);
	if (readable.size === 0) {
		return {};
	}
	const scoped: SecretsArgs = {
		...args,
		values: new Map([...args.values].map(([key, list]) => [key, [...list]])),
	};
	narrowToReadable(scoped, rows, readable);
	try {
		const values = parseVaultJsonExport(
			await exportResult(ctx, scoped, "json")
		);
		if (!stillReadable(await listedRows(ctx), Object.keys(values))) {
			ctx.io.err(
				`${tr("Value types changed during the run's setup, so no config values were added to the command's environment.")}\n`
			);
			return {};
		}
		const env: Record<string, string> = {};
		for (const [name, value] of Object.entries(values)) {
			if (readable.has(name)) {
				env[name] = value;
			}
		}
		const count = Object.keys(env).length;
		if (count > 0) {
			ctx.io.err(
				`${tf("Added {count, plural, one {# config value} other {# config values}} to the command's environment.", { count })}\n`
			);
		}
		return env;
	} catch {
		ctx.io.err(
			`${tr("Could not export the config values, so none were added to the command's environment.")}\n`
		);
		return {};
	}
}

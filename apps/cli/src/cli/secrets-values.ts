import { readFile, writeFile } from "node:fs/promises";
import {
	deleteVaultSecret,
	destroyVaultSecret,
	exportVaultSnapshot,
	importVaultSecrets,
	listVaultSecrets,
	listVaultSecretVersions,
	putVaultSecret,
	restoreVaultSecret,
	revealVaultSecret,
	rollbackVaultSecret,
	type VaultImportFormat,
	vaultAgentSecret,
	vaultValueType,
} from "@ryuhq/core-client/vault";
import { z } from "zod";
import { tf } from "../i18n/translate.ts";
import { formatTable, truncate } from "./output.ts";
import {
	arg,
	coordsFrom,
	flag,
	metadataFrom,
	type SecretsArgs,
} from "./secrets-args.ts";
import {
	agentTarget,
	describeChangeRequest,
	exportFormat,
	exportResult,
	printJson,
	reportWrite,
} from "./secrets-output.ts";
import { selectTagged } from "./secrets-run-env.ts";
import { type CliContext, UsageError } from "./types.ts";
import { withStepUpHint } from "./vaultStepUp.ts";

// ── Values ───────────────────────────────────────────────────────────────────

export async function listSecrets(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const result = await listVaultSecrets(ctx.target, {
		environment: flag(args, "--env"),
		path: flag(args, "--path"),
	});
	if (ctx.flags.json) {
		printJson(ctx, result);
		return 0;
	}
	if (result.sharedError) {
		ctx.io.err(
			`${tf("Shared values unavailable: {sharedError}", { sharedError: result.sharedError })}\n`
		);
	}
	if (result.secrets.length === 0) {
		ctx.io.out("No secrets.\n");
		return 0;
	}
	const rows = result.secrets.map((secret) => [
		secret.name,
		secret.environment,
		secret.path,
		secret.scope,
		vaultValueType(secret.metadata),
		String(secret.version),
		secret.status,
		truncate(secret.metadata.description, 40),
	]);
	ctx.io.out(
		`${formatTable(["NAME", "ENV", "PATH", "SCOPE", "TYPE", "VERSION", "STATUS", "DESCRIPTION"], rows)}\n`
	);
	return 0;
}

export async function getSecret(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const name = arg(args, 1, "get NAME [VERSION]");
	const rawVersion = args.positional[2];
	const version = rawVersion === undefined ? undefined : Number(rawVersion);
	if (version !== undefined && !(Number.isInteger(version) && version > 0)) {
		throw new UsageError("VERSION must be a positive integer.");
	}
	if (version !== undefined && agentTarget(ctx)) {
		throw new UsageError("VERSION is not supported with RYU_VAULT_TOKEN.");
	}
	const agent = agentTarget(ctx);
	let result:
		| Awaited<ReturnType<typeof vaultAgentSecret>>
		| Awaited<ReturnType<typeof revealVaultSecret>>;
	if (agent) {
		result = await vaultAgentSecret(agent, name, {
			environment: flag(args, "--env"),
			path: flag(args, "--path"),
		});
	} else {
		const coords: Parameters<typeof revealVaultSecret>[2] = coordsFrom(args);
		if (version !== undefined) {
			coords.version = version;
		}
		result = await withStepUpHint(() =>
			revealVaultSecret(ctx.target, name, coords)
		);
	}
	if (ctx.flags.json) {
		printJson(ctx, result);
	} else {
		ctx.io.out(`${result.value}\n`);
	}
	return 0;
}

async function readValue(
	ctx: CliContext,
	args: SecretsArgs
): Promise<string | undefined> {
	const given = args.positional[2];
	if (given !== undefined && given !== "-") {
		return given;
	}
	const piped = await ctx.readStdin();
	if (piped === null) {
		if (given === "-") {
			throw new UsageError(
				"'-' reads the value from stdin, but stdin is a terminal. Pipe the value in."
			);
		}
		return undefined;
	}
	// `echo value | ryu secrets set NAME` should not store the trailing newline.
	const value = piped.replace(/\r?\n$/, "");
	// An omitted VALUE with empty non-interactive stdin (CI) is a metadata-only
	// update, not an attempt to store "".
	return given === undefined && value === "" ? undefined : value;
}

/**
 * `set NAME [VALUE|-]`. `agentMarker` is the detected AI agent marker when the
 * agent guard applies: a metadata-only change to `config` is then refused,
 * because it would re-label the stored secret plaintext as readable.
 */
export async function setSecret(
	ctx: CliContext,
	args: SecretsArgs,
	agentMarker?: string
): Promise<number> {
	const name = arg(args, 1, "set NAME [VALUE|-]");
	const metadata = metadataFrom(args);
	const value = await readValue(ctx, args);
	if (
		agentMarker !== undefined &&
		value === undefined &&
		metadata?.valueType === "config"
	) {
		ctx.io.err(
			`${tf("Refusing to change {name} to config without a new value in an AI agent session ({marker} is set): the stored value may be a secret. Pass the new value in the same command. A person at a terminal can add --human.", { name, marker: agentMarker })}\n`
		);
		return 1;
	}
	if (value === "") {
		throw new UsageError(
			"Refusing to store an empty value (Core treats it as a delete). Use 'ryu-cli secrets delete'."
		);
	}
	if (value === undefined && !metadata) {
		throw new UsageError(
			"Usage: ryu-cli secrets set NAME [VALUE|-] — pass a value, '-' to read stdin, or metadata flags."
		);
	}
	const input: Parameters<typeof putVaultSecret>[2] = coordsFrom(args);
	if (value !== undefined) {
		input.value = value;
	}
	if (metadata) {
		input.metadata = metadata;
	}
	const result = await putVaultSecret(ctx.target, name, input);
	return reportWrite(
		ctx,
		result,
		(version) => `Set ${name} (version ${version}).`
	);
}

export async function deleteSecret(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const name = arg(args, 1, "delete NAME");
	const result = await deleteVaultSecret(ctx.target, name, coordsFrom(args));
	if (ctx.flags.json) {
		printJson(ctx, result);
	} else if (result.changeRequest) {
		ctx.io.out(`${describeChangeRequest(result.changeRequest)}\n`);
	} else {
		ctx.io.out(
			`${tf("Deleted {name} (restore with 'ryu-cli secrets restore {name}').", { name })}\n`
		);
	}
	return 0;
}

export async function listVersions(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const name = arg(args, 1, "versions NAME");
	const { versions } = await listVaultSecretVersions(
		ctx.target,
		name,
		coordsFrom(args)
	);
	if (ctx.flags.json) {
		printJson(ctx, versions);
		return 0;
	}
	const rows = versions.map((version) => [
		`${version.version}${version.current ? " *" : ""}`,
		String(version.createdAt ?? ""),
		version.createdBy ?? "",
		version.source,
		version.destroyed ? "destroyed" : "",
	]);
	ctx.io.out(
		`${formatTable(["VERSION", "CREATED", "BY", "SOURCE", "STATE"], rows)}\n`
	);
	return 0;
}

export async function rollback(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const name = arg(args, 1, "rollback NAME VERSION");
	const version = Number(arg(args, 2, "rollback NAME VERSION"));
	if (!Number.isInteger(version) || version < 1) {
		throw new UsageError("VERSION must be a positive integer.");
	}
	const result = await rollbackVaultSecret(ctx.target, name, {
		...coordsFrom(args),
		version,
	});
	return reportWrite(ctx, result, (current) =>
		tf("Rolled {name} back to version {version} (now version {current}).", {
			name,
			version: String(version),
			current: String(current),
		})
	);
}

export async function restore(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const name = arg(args, 1, "restore NAME");
	const result = await restoreVaultSecret(ctx.target, name, coordsFrom(args));
	return reportWrite(ctx, result, () => tf("Restored {name}.", { name }));
}

export async function exportSecrets(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	await selectTagged(ctx, args);
	const result = await exportResult(ctx, args, exportFormat(args));
	if (ctx.flags.json) {
		printJson(ctx, result);
		return 0;
	}
	ctx.io.out(
		result.content.endsWith("\n") ? result.content : `${result.content}\n`
	);
	return 0;
}

const vaultImportFormatSchema = z.enum(["dotenv", "json", "snapshot"]);

function importFormat(
	file: string,
	explicit: string | undefined
): VaultImportFormat {
	const inferred = file.endsWith(".json") ? "json" : "dotenv";
	const format = vaultImportFormatSchema.safeParse(explicit ?? inferred);
	if (!format.success) {
		throw new UsageError("--format must be dotenv, json, or snapshot.");
	}
	return format.data;
}

export async function importSecrets(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const file = arg(args, 1, "import FILE [--format dotenv|json|snapshot]");
	const format = importFormat(file, flag(args, "--format"));
	const onConflict = flag(args, "--on-conflict") ?? "skip";
	if (onConflict !== "skip" && onConflict !== "overwrite") {
		throw new UsageError("--on-conflict must be skip or overwrite.");
	}
	const passphrase = flag(args, "--passphrase") ?? ctx.env.RYU_VAULT_PASSPHRASE;
	if (format === "snapshot" && !passphrase) {
		throw new UsageError(
			"A snapshot import needs --passphrase or RYU_VAULT_PASSPHRASE."
		);
	}
	const content = await readFile(file, "utf8");
	const input: Parameters<typeof importVaultSecrets>[1] = {
		...coordsFrom(args),
		format,
		content,
		onConflict,
	};
	if (format === "snapshot" && passphrase) {
		input.passphrase = passphrase;
	}
	const { report } = await importVaultSecrets(ctx.target, input);
	if (ctx.flags.json) {
		printJson(ctx, report);
	} else {
		ctx.io.out(
			`${tf("Imported {file}: {created} created, {updated} updated, {skipped} skipped, {unchanged} unchanged.", { file, created: String(report.created), updated: String(report.updated), skipped: String(report.skipped), unchanged: String(report.unchanged) })}\n`
		);
	}
	return 0;
}

/** `destroy NAME VERSION…` or `destroy NAME --all`: permanently erase stored
 *  versions. Unlike `delete`, this cannot be undone, so destroying every
 *  version needs an explicit `--all`. */
export async function destroySecret(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const usage = "destroy NAME VERSION… | destroy NAME --all";
	const name = arg(args, 1, usage);
	const versions = args.positional.slice(2).map((raw) => {
		const version = Number(raw);
		if (!(Number.isInteger(version) && version > 0)) {
			throw new UsageError("VERSION must be a positive integer.");
		}
		return version;
	});
	const all = args.booleans.has("--all");
	if (versions.length === 0 && !all) {
		throw new UsageError(
			`Usage: ryu-cli secrets ${usage} (destroyed versions cannot be restored)`
		);
	}
	if (versions.length > 0 && all) {
		throw new UsageError("Pass VERSIONs or --all, not both.");
	}
	const input: Parameters<typeof destroyVaultSecret>[2] = coordsFrom(args);
	if (versions.length > 0) {
		input.versions = versions;
	}
	const result = await destroyVaultSecret(ctx.target, name, input);
	if (ctx.flags.json) {
		printJson(ctx, result);
	} else {
		ctx.io.out(
			`${tf("Destroyed {count} version(s) of {name}.", { count: String(result.destroyed), name })}\n`
		);
	}
	return 0;
}

/** `snapshot [--out FILE]`: a passphrase-sealed export of the readable values
 *  that `import FILE --format snapshot` restores. The passphrase comes from
 *  RYU_VAULT_PASSPHRASE or --passphrase. */
export async function snapshot(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const passphrase = flag(args, "--passphrase") ?? ctx.env.RYU_VAULT_PASSPHRASE;
	if (!passphrase) {
		throw new UsageError(
			"A snapshot needs RYU_VAULT_PASSPHRASE (or --passphrase) to seal it."
		);
	}
	const input: Parameters<typeof exportVaultSnapshot>[1] = { passphrase };
	const environment = flag(args, "--env");
	const path = flag(args, "--path");
	if (environment) {
		input.environment = environment;
	}
	if (path) {
		input.path = path;
	}
	const envelope = await withStepUpHint(() =>
		exportVaultSnapshot(ctx.target, input)
	);
	const content = `${JSON.stringify(envelope, null, 2)}\n`;
	const out = flag(args, "--out");
	if (!out) {
		ctx.io.out(content);
		return 0;
	}
	try {
		await writeFile(out, content, {
			mode: 0o600,
			flag: ctx.flags.force ? "w" : "wx",
		});
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EEXIST") {
			throw new UsageError(
				tf("{file} already exists. Pass --force to replace it.", { file: out })
			);
		}
		throw error;
	}
	ctx.io.err(
		`${tf("Wrote an encrypted snapshot to {file}. Restore it with 'ryu-cli secrets import {file} --format snapshot'.", { file: out })}\n`
	);
	return 0;
}

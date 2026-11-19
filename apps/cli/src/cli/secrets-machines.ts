// `ryu secrets machine …`: machine identities (AppRole, JWT, cert, AWS IAM,
// Kubernetes), their token settings, and AppRole secret ids. Every route
// needs `admin` on `sys/machines`. Listings carry metadata only; a secret id
// is printed once by `machine secret-id`, which the agent guard refuses.

import { readFile } from "node:fs/promises";
import {
	createVaultMachine,
	deleteVaultMachine,
	issueVaultSecretId,
	listVaultMachines,
	listVaultSecretIds,
	revokeVaultSecretId,
	setVaultMachineTokenConfig,
	updateVaultMachine,
	type VaultMachineAuth,
	type VaultMachineIdentity,
	type VaultMachineTokenConfig,
} from "@ryuhq/core-client/vault";
import { z } from "zod";
import { tf } from "../i18n/translate.ts";
import { formatTable } from "./output.ts";
import {
	arg,
	flag,
	intFlag,
	parseDuration,
	type SecretsArgs,
} from "./secrets-args.ts";
import { printJson } from "./secrets-output.ts";
import { type CliContext, UsageError } from "./types.ts";
import { yesNo } from "./yesNo.ts";

const MACHINE_USAGE =
	"Usage: ryu-cli secrets machine list | create NAME [AUTH_FILE] [--policy P]… [--ttl 15m] | update NAME [--policy P]… [--ttl D] [--disable|--enable] | token-config NAME [--max-ttl D] [--explicit-max-ttl D] [--period D] [--uses N] [--cidr C]… [--renewable|--not-renewable] | delete NAME | secret-ids NAME | secret-id NAME [--ttl D] [--uses N] [--cidr C]… | revoke-secret-id ACCESSOR";

const authFileSchema = z.looseObject({
	kind: z.enum(["approle", "jwt", "cert", "aws-iam", "kubernetes"]),
});

/** Read an auth object (`{"kind": "jwt", "issuer": …}`) from a JSON file. */
export async function readAuthFile(file: string): Promise<VaultMachineAuth> {
	let parsed: ReturnType<typeof authFileSchema.safeParse>;
	try {
		parsed = authFileSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
	} catch (error) {
		throw new UsageError(
			tf("Auth file {file} must be JSON: {reason}", {
				file,
				reason: error instanceof Error ? error.message : String(error),
			})
		);
	}
	if (!parsed.success) {
		throw new UsageError(
			tf(
				"Auth file {file} needs a kind: approle, jwt, cert, aws-iam, or kubernetes.",
				{ file }
			)
		);
	}
	// SAFETY: the kind is checked here; Core validates the kind's fields.
	return parsed.data as VaultMachineAuth;
}

function durationFlag(args: SecretsArgs, name: string): number | undefined {
	const value = flag(args, name);
	return value === undefined ? undefined : parseDuration(value);
}

function policiesFlag(args: SecretsArgs): string[] | undefined {
	return args.values.get("--policy");
}

function authSummary(machine: VaultMachineIdentity): string {
	const { auth } = machine;
	switch (auth.kind) {
		case "approle":
			return `approle ${auth.role_id}`;
		case "jwt":
			return `jwt ${auth.issuer}`;
		case "cert":
			return "cert";
		case "aws-iam":
			return `aws-iam ${auth.boundIamPrincipalArns.join(",")}`;
		case "kubernetes":
			return `kubernetes ${auth.boundServiceAccountNamespaces.join(",")}`;
		default:
			return "";
	}
}

const MACHINE_COLUMNS = ["NAME", "ID", "AUTH", "POLICIES", "TTL", "DISABLED"];

function machineRow(machine: VaultMachineIdentity): string[] {
	return [
		machine.name,
		machine.id,
		authSummary(machine),
		machine.policies.join(","),
		`${machine.tokenTtlSecs}s`,
		yesNo(machine.disabled),
	];
}

function printMachines(
	ctx: CliContext,
	rows: readonly VaultMachineIdentity[]
): void {
	ctx.io.out(`${formatTable(MACHINE_COLUMNS, rows.map(machineRow))}\n`);
}

async function list(ctx: CliContext): Promise<number> {
	const { machines } = await listVaultMachines(ctx.target);
	if (ctx.flags.json) {
		printJson(ctx, machines);
	} else {
		printMachines(ctx, machines);
	}
	return 0;
}

async function create(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const name = arg(args, 2, "machine create NAME [AUTH_FILE]");
	const file = args.positional[3];
	const auth: VaultMachineAuth = file
		? await readAuthFile(file)
		: { kind: "approle" };
	const input: Parameters<typeof createVaultMachine>[1] = { name, auth };
	const policies = policiesFlag(args);
	const ttl = durationFlag(args, "--ttl");
	if (policies) {
		input.policies = policies;
	}
	if (ttl !== undefined) {
		input.tokenTtlSecs = ttl;
	}
	const { machine } = await createVaultMachine(ctx.target, input);
	if (ctx.flags.json) {
		printJson(ctx, machine);
		return 0;
	}
	printMachines(ctx, [machine]);
	if (machine.auth.kind === "approle") {
		ctx.io.err(
			`${tf("Issue a secret id with: ryu-cli secrets machine secret-id {name}", { name: machine.name })}\n`
		);
	}
	return 0;
}

async function update(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const name = arg(args, 2, "machine update NAME");
	const patch: Parameters<typeof updateVaultMachine>[2] = {};
	const policies = policiesFlag(args);
	const ttl = durationFlag(args, "--ttl");
	if (policies) {
		patch.policies = policies;
	}
	if (ttl !== undefined) {
		patch.tokenTtlSecs = ttl;
	}
	if (args.booleans.has("--disable") || args.booleans.has("--enable")) {
		patch.disabled = args.booleans.has("--disable");
	}
	if (Object.keys(patch).length === 0) {
		throw new UsageError(MACHINE_USAGE);
	}
	const { machine } = await updateVaultMachine(ctx.target, name, patch);
	if (ctx.flags.json) {
		printJson(ctx, machine);
	} else {
		printMachines(ctx, [machine]);
	}
	return 0;
}

/** The full token config from flags; `PUT` replaces the identity's settings. */
export function tokenConfigFrom(args: SecretsArgs): VaultMachineTokenConfig {
	const config: VaultMachineTokenConfig = {};
	const maxTtl = durationFlag(args, "--max-ttl");
	const explicitMaxTtl = durationFlag(args, "--explicit-max-ttl");
	const period = durationFlag(args, "--period");
	const uses = intFlag(args, "--uses");
	const cidrs = args.values.get("--cidr");
	if (maxTtl !== undefined) {
		config.maxTtlSecs = maxTtl;
	}
	if (explicitMaxTtl !== undefined) {
		config.explicitMaxTtlSecs = explicitMaxTtl;
	}
	if (period !== undefined) {
		config.periodSecs = period;
	}
	if (uses !== undefined) {
		config.numUses = uses;
	}
	if (cidrs) {
		config.boundCidrs = cidrs;
	}
	if (
		args.booleans.has("--renewable") ||
		args.booleans.has("--not-renewable")
	) {
		config.renewable = args.booleans.has("--renewable");
	}
	return config;
}

async function tokenConfig(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const name = arg(args, 2, "machine token-config NAME");
	const { machine } = await setVaultMachineTokenConfig(
		ctx.target,
		name,
		tokenConfigFrom(args)
	);
	if (ctx.flags.json) {
		printJson(ctx, machine);
	} else {
		ctx.io.out(
			`${tf("Saved token settings for {name}.", { name: machine.name })}\n`
		);
	}
	return 0;
}

async function secretIds(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const name = arg(args, 2, "machine secret-ids NAME");
	const { secretIds: rows } = await listVaultSecretIds(ctx.target, name);
	if (ctx.flags.json) {
		printJson(ctx, rows);
		return 0;
	}
	ctx.io.out(
		`${formatTable(
			["ACCESSOR", "CREATED", "EXPIRES", "USES LEFT"],
			rows.map((row) => [
				row.accessor,
				String(row.createdAt),
				String(row.expiresAt ?? ""),
				row.usesRemaining === null ? "" : String(row.usesRemaining),
			])
		)}\n`
	);
	return 0;
}

async function issueSecretId(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const name = arg(args, 2, "machine secret-id NAME");
	const input: Parameters<typeof issueVaultSecretId>[2] = {};
	const ttl = durationFlag(args, "--ttl");
	const uses = intFlag(args, "--uses");
	const cidrs = args.values.get("--cidr");
	if (ttl !== undefined) {
		input.ttlSecs = ttl;
	}
	if (uses !== undefined) {
		input.uses = uses;
	}
	if (cidrs) {
		input.cidrList = cidrs;
	}
	const issued = await issueVaultSecretId(ctx.target, name, input);
	if (ctx.flags.json) {
		printJson(ctx, issued);
		return 0;
	}
	ctx.io.out(`${issued.secretId}\n`);
	ctx.io.err(
		`${tf("Secret id for {name} (accessor {accessor}); shown once. Log in with: ryu-cli secrets login --approle ROLE_ID SECRET_ID", { name, accessor: issued.info.accessor })}\n`
	);
	return 0;
}

export async function machines(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const action = args.positional[1] ?? "list";
	switch (action) {
		case "list":
		case "ls":
			return await list(ctx);
		case "create":
			return await create(ctx, args);
		case "update":
			return await update(ctx, args);
		case "token-config":
			return await tokenConfig(ctx, args);
		case "delete":
		case "rm": {
			const name = arg(args, 2, "machine delete NAME");
			await deleteVaultMachine(ctx.target, name);
			ctx.io.out(`${tf("Deleted machine identity {name}.", { name })}\n`);
			return 0;
		}
		case "secret-ids":
			return await secretIds(ctx, args);
		case "secret-id":
			return await issueSecretId(ctx, args);
		case "revoke-secret-id": {
			const accessor = arg(args, 2, "machine revoke-secret-id ACCESSOR");
			await revokeVaultSecretId(ctx.target, accessor);
			ctx.io.out(`${tf("Revoked secret id {accessor}.", { accessor })}\n`);
			return 0;
		}
		default:
			throw new UsageError(MACHINE_USAGE);
	}
}

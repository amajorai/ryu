// `ryu secrets dynamic …` and `ryu secrets lease …`: dynamic-secret roles and
// the leases issued from them.
//
// `dynamic issue` is the only subcommand here that prints a credential (the
// AI-agent guard refuses it). Role configuration is read from a JSON file, so
// provider credentials never appear as arguments, and Core returns roles with
// those credentials redacted. Lease listings carry metadata only.

import { readFile } from "node:fs/promises";
import {
	deleteVaultDynamicRole,
	issueVaultDynamicCredential,
	listVaultDynamicRoles,
	listVaultLeases,
	putVaultDynamicRole,
	revokeAllVaultDynamicLeases,
	type VaultDynamicCredential,
	type VaultLease,
	vaultAgentDynamicIssue,
	vaultAgentLease,
	vaultLease,
} from "@ryuhq/core-client/vault";
import { z } from "zod";
import { tf } from "../i18n/translate.ts";
import { formatTable } from "./output.ts";
import { arg, flag, parseDuration, type SecretsArgs } from "./secrets-args.ts";
import { agentTarget, printJson } from "./secrets-output.ts";
import { type CliContext, UsageError } from "./types.ts";

const DYNAMIC_USAGE =
	"Usage: ryu-cli secrets dynamic roles | put ROLE FILE | delete ROLE | issue ROLE [--ttl 1h] | revoke-all ROLE";
const LEASE_USAGE =
	"Usage: ryu-cli secrets lease list [--name ROLE] [--all] | renew ID [--increment 1h] | revoke ID";

const charsetSchema = z.enum(["alphanumeric", "hex", "base64url", "symbols"]);

const providerSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("postgres"),
		connectionUrl: z.string().min(1),
		creationStatements: z.array(z.string().min(1)).min(1),
		revocationStatements: z.array(z.string().min(1)).optional(),
		usernamePrefix: z.string().optional(),
	}),
	z.strictObject({
		kind: z.literal("aws-sts"),
		accessKeyId: z.string().min(1),
		secretAccessKey: z.string().min(1),
		region: z.string().min(1),
		roleArn: z.string().min(1),
		endpoint: z.string().optional(),
		sessionPolicy: z.string().optional(),
	}),
	z.strictObject({
		kind: z.literal("webhook"),
		url: z.string().min(1),
		signingSecret: z.string().min(1),
	}),
	z.strictObject({
		kind: z.literal("random"),
		charset: charsetSchema,
		length: z.number().int().positive(),
		field: z.string().optional(),
	}),
]);

const roleFileSchema = z.strictObject({
	provider: providerSchema,
	defaultTtl: z.string().optional(),
	maxTtl: z.string().optional(),
});

/** Parse a role file. Errors name the field, never its value. */
export function parseRoleFile(text: string, file: string) {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new UsageError(tf("{file} is not valid JSON.", { file }));
	}
	const parsed = roleFileSchema.safeParse(raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		throw new UsageError(
			tf("{file} is not a valid dynamic role: {field} is invalid.", {
				file,
				field: issue?.path.join(".") || "(root)",
			})
		);
	}
	const { provider, defaultTtl, maxTtl } = parsed.data;
	return {
		provider,
		...(defaultTtl === undefined
			? {}
			: { defaultTtlSecs: parseDuration(defaultTtl) }),
		...(maxTtl === undefined ? {} : { maxTtlSecs: parseDuration(maxTtl) }),
	};
}

function ttlFlag(args: SecretsArgs, name: string): number | undefined {
	const value = flag(args, name);
	return value === undefined ? undefined : parseDuration(value);
}

function leaseRows(leases: VaultLease[]): string[][] {
	return leases.map((lease) => [
		lease.id,
		lease.role,
		lease.provider,
		String(lease.expiresAt),
		lease.revokedAt === null ? "" : `revoked ${String(lease.revokedAt)}`,
	]);
}

const LEASE_HEADERS = ["LEASE", "ROLE", "PROVIDER", "EXPIRES", "STATE"];

async function issue(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const role = arg(args, 2, "dynamic issue ROLE [--ttl 1h]");
	const ttl = ttlFlag(args, "--ttl");
	const agent = agentTarget(ctx);
	const { credential }: { credential: VaultDynamicCredential } = agent
		? await vaultAgentDynamicIssue(agent, role, ttl)
		: await issueVaultDynamicCredential(ctx.target, role, ttl);
	if (ctx.flags.json) {
		printJson(ctx, credential);
		return 0;
	}
	for (const [field, value] of Object.entries(credential.data)) {
		ctx.io.out(`${field}=${value}\n`);
	}
	ctx.io.err(
		`${tf("Lease {id} expires at {expiresAt}. Revoke it with 'ryu-cli secrets lease revoke {id}'.", { id: credential.lease.id, expiresAt: String(credential.lease.expiresAt) })}\n`
	);
	return 0;
}

export async function dynamic(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const action = args.positional[1];
	if (action === "issue") {
		return await issue(ctx, args);
	}
	if (action === "roles" || action === "list" || action === "ls") {
		const { roles } = await listVaultDynamicRoles(ctx.target);
		if (ctx.flags.json) {
			printJson(ctx, roles);
			return 0;
		}
		const rows = roles.map((role) => [
			role.name,
			role.provider,
			`${role.defaultTtlSecs}s`,
			`${role.maxTtlSecs}s`,
		]);
		ctx.io.out(
			rows.length === 0
				? "No dynamic roles.\n"
				: `${formatTable(["ROLE", "PROVIDER", "DEFAULT TTL", "MAX TTL"], rows)}\n`
		);
		return 0;
	}
	if (action === "put" || action === "set") {
		const usage = "dynamic put ROLE FILE";
		const name = arg(args, 2, usage);
		const file = arg(args, 3, usage);
		const input = parseRoleFile(await readFile(file, "utf8"), file);
		const { role } = await putVaultDynamicRole(ctx.target, name, input);
		if (ctx.flags.json) {
			printJson(ctx, role);
		} else {
			ctx.io.out(`${tf("Saved dynamic role {name}.", { name: role.name })}\n`);
		}
		return 0;
	}
	if (action === "delete" || action === "rm") {
		const name = arg(args, 2, "dynamic delete ROLE");
		const result = await deleteVaultDynamicRole(ctx.target, name);
		if (ctx.flags.json) {
			printJson(ctx, result);
		} else {
			ctx.io.out(
				result.deleted
					? `${tf("Deleted dynamic role {name}.", { name })}\n`
					: `${tf("No dynamic role {name}.", { name })}\n`
			);
		}
		return 0;
	}
	if (action === "revoke-all") {
		const name = arg(args, 2, "dynamic revoke-all ROLE");
		const result = await revokeAllVaultDynamicLeases(ctx.target, name);
		if (ctx.flags.json) {
			printJson(ctx, result);
		} else {
			ctx.io.out(
				`${tf("Revoked {count} lease(s) of {name}.", { count: String(result.revoked), name })}\n`
			);
		}
		return 0;
	}
	throw new UsageError(DYNAMIC_USAGE);
}

async function leaseOp(
	ctx: CliContext,
	args: SecretsArgs,
	op: "renew" | "revoke"
): Promise<number> {
	const id = arg(
		args,
		2,
		op === "renew" ? "lease renew ID [--increment 1h]" : "lease revoke ID"
	);
	const increment = op === "renew" ? ttlFlag(args, "--increment") : undefined;
	const agent = agentTarget(ctx);
	const { lease } = agent
		? await vaultAgentLease(agent, id, op, increment)
		: await vaultLease(ctx.target, id, op, increment);
	if (ctx.flags.json) {
		printJson(ctx, lease);
		return 0;
	}
	ctx.io.out(
		op === "renew"
			? `${tf("Renewed lease {id} until {expiresAt}.", { id, expiresAt: String(lease.expiresAt) })}\n`
			: `${tf("Revoked lease {id}.", { id })}\n`
	);
	return 0;
}

export async function leases(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const action = args.positional[1] ?? "list";
	if (action === "renew" || action === "revoke") {
		return await leaseOp(ctx, args, action);
	}
	if (action !== "list" && action !== "ls") {
		throw new UsageError(LEASE_USAGE);
	}
	const filter: { includeRevoked?: boolean; role?: string } = {};
	const role = flag(args, "--name");
	if (role) {
		filter.role = role;
	}
	if (args.booleans.has("--all")) {
		filter.includeRevoked = true;
	}
	const result = await listVaultLeases(ctx.target, filter);
	if (ctx.flags.json) {
		printJson(ctx, result.leases);
		return 0;
	}
	ctx.io.out(
		result.leases.length === 0
			? "No leases.\n"
			: `${formatTable(LEASE_HEADERS, leaseRows(result.leases))}\n`
	);
	return 0;
}

// `ryu secrets token list|create|revoke|roles|role …`: machine-token
// administration (`admin` on `sys/machines`, and on `sys/token-roles/<name>`
// for roles). Listings show accessors and metadata only; `token create`
// prints the new token once, which the agent guard refuses.

import { readFile } from "node:fs/promises";
import {
	createVaultToken,
	deleteVaultTokenRole,
	getVaultTokenRole,
	listVaultTokenRoles,
	listVaultTokens,
	putVaultTokenRole,
	revokeVaultToken,
	revokeVaultTokenOrphan,
	type VaultTokenRequest,
	type VaultTokenRole,
	type VaultTokenRoleInput,
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

export const TOKEN_ADMIN_ACTIONS = new Set([
	"list",
	"create",
	"revoke",
	"roles",
	"role",
]);

const ROLE_USAGE =
	"Usage: ryu-cli secrets token role show NAME | role set NAME FILE | role delete NAME";

/** `token create` flags → the token request Core expects. */
export function tokenRequestFrom(args: SecretsArgs): VaultTokenRequest {
	const request: VaultTokenRequest = {};
	const seconds = (name: string) => {
		const value = flag(args, name);
		return value === undefined ? undefined : parseDuration(value);
	};
	const policies = args.values.get("--policy");
	const cidrs = args.values.get("--cidr");
	const role = flag(args, "--role");
	const ttl = seconds("--ttl");
	const explicitMaxTtl = seconds("--explicit-max-ttl");
	const period = seconds("--period");
	const uses = intFlag(args, "--uses");
	if (policies) {
		request.policies = policies;
	}
	if (cidrs) {
		request.boundCidrs = cidrs;
	}
	if (role) {
		request.role = role;
	}
	if (ttl !== undefined) {
		request.ttlSecs = ttl;
	}
	if (explicitMaxTtl !== undefined) {
		request.explicitMaxTtlSecs = explicitMaxTtl;
	}
	if (period !== undefined) {
		request.periodSecs = period;
	}
	if (uses !== undefined) {
		request.numUses = uses;
	}
	if (args.booleans.has("--orphan")) {
		request.orphan = true;
	}
	if (args.booleans.has("--not-renewable")) {
		request.renewable = false;
	}
	return request;
}

const roleFileSchema = z.looseObject({
	allowedPolicies: z.array(z.string()).optional(),
	disallowedPolicies: z.array(z.string()).optional(),
	orphan: z.boolean().optional(),
	renewable: z.boolean().optional(),
	ttlSecs: z.number().int().optional(),
	maxTtlSecs: z.number().int().optional(),
	explicitMaxTtlSecs: z.number().int().optional(),
	periodSecs: z.number().int().optional(),
	numUses: z.number().int().optional(),
	boundCidrs: z.array(z.string()).optional(),
});

async function readRoleFile(file: string): Promise<VaultTokenRoleInput> {
	let parsed: ReturnType<typeof roleFileSchema.safeParse>;
	try {
		parsed = roleFileSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
	} catch (error) {
		throw new UsageError(
			tf("Token role file {file} must be JSON: {reason}", {
				file,
				reason: error instanceof Error ? error.message : String(error),
			})
		);
	}
	if (!parsed.success) {
		throw new UsageError(
			tf("Token role file {file} has a field of the wrong type.", { file })
		);
	}
	return parsed.data;
}

function roleRow(role: VaultTokenRole): string[] {
	return [
		role.name,
		role.allowedPolicies.join(","),
		role.disallowedPolicies.join(","),
		role.ttlSecs === undefined ? "" : `${role.ttlSecs}s`,
		yesNo(role.orphan),
	];
}

const ROLE_COLUMNS = ["ROLE", "ALLOWED", "DISALLOWED", "TTL", "ORPHAN"];

async function roleCommand(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const action = args.positional[2];
	const name = args.positional[3];
	if (!(action && name)) {
		throw new UsageError(ROLE_USAGE);
	}
	if (action === "delete") {
		await deleteVaultTokenRole(ctx.target, name);
		ctx.io.out(`${tf("Deleted token role {name}.", { name })}\n`);
		return 0;
	}
	let role: VaultTokenRole;
	if (action === "show") {
		role = (await getVaultTokenRole(ctx.target, name)).role;
	} else if (action === "set") {
		const input = await readRoleFile(arg(args, 4, "token role set NAME FILE"));
		role = (await putVaultTokenRole(ctx.target, name, input)).role;
	} else {
		throw new UsageError(ROLE_USAGE);
	}
	if (ctx.flags.json) {
		printJson(ctx, role);
	} else {
		ctx.io.out(`${formatTable(ROLE_COLUMNS, [roleRow(role)])}\n`);
	}
	return 0;
}

export async function tokenAdmin(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const action = args.positional[1];
	if (action === "list") {
		const identity = flag(args, "--identity");
		const { tokens } = await listVaultTokens(
			ctx.target,
			identity ? { identity } : {}
		);
		if (ctx.flags.json) {
			printJson(ctx, tokens);
			return 0;
		}
		const rows = tokens.map((token) => [
			token.accessor,
			token.identityId,
			token.policies.join(","),
			String(token.expiresAt),
			token.role ?? "",
			yesNo(token.orphan),
		]);
		ctx.io.out(
			`${formatTable(["ACCESSOR", "IDENTITY", "POLICIES", "EXPIRES", "ROLE", "ORPHAN"], rows)}\n`
		);
		return 0;
	}
	if (action === "create") {
		const identity = arg(
			args,
			2,
			"token create IDENTITY [--policy P]… [--ttl D]"
		);
		const { token } = await createVaultToken(ctx.target, {
			...tokenRequestFrom(args),
			identity,
		});
		if (ctx.flags.json) {
			printJson(ctx, token);
			return 0;
		}
		ctx.io.out(`${token.token}\n`);
		ctx.io.err(
			`${tf("Vault token for {identityId} (accessor {accessor}) expires {expiresAt}; shown once.", { identityId: token.identityId, accessor: token.accessor, expiresAt: String(token.expiresAt) })}\n`
		);
		return 0;
	}
	if (action === "revoke") {
		const accessor = arg(args, 2, "token revoke ACCESSOR [--orphan]");
		if (args.booleans.has("--orphan")) {
			const { revoked } = await revokeVaultTokenOrphan(ctx.target, accessor);
			ctx.io.out(
				`${tf("Revoked {accessor}; its child tokens are now orphans ({leases, plural, one {# lease} other {# leases}} revoked).", { accessor, leases: revoked.leasesRevoked })}\n`
			);
			return 0;
		}
		await revokeVaultToken(ctx.target, accessor);
		ctx.io.out(
			`${tf("Revoked {accessor} and its child tokens.", { accessor })}\n`
		);
		return 0;
	}
	if (action === "roles") {
		const { roles } = await listVaultTokenRoles(ctx.target);
		if (ctx.flags.json) {
			printJson(ctx, roles);
		} else {
			ctx.io.out(`${formatTable(ROLE_COLUMNS, roles.map(roleRow))}\n`);
		}
		return 0;
	}
	return await roleCommand(ctx, args);
}

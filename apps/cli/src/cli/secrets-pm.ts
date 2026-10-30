import {
	createVaultPasswordManagerAccount,
	decideVaultPasswordManagerApproval,
	deleteVaultPasswordManagerAccount,
	listVaultPasswordManagerAccounts,
	listVaultPasswordManagerApprovals,
	listVaultPasswordManagerGrants,
	readVaultPasswordManagerRef,
	revokeVaultPasswordManagerGrant,
	setVaultPasswordManagerToken,
	testVaultPasswordManagerAccount,
	type VaultPasswordManagerAccount,
} from "@ryuhq/core-client/vault";
import { z } from "zod";
import { tf } from "../i18n/translate.ts";
import { formatTable, truncate } from "./output.ts";
import { arg, flag, grantFlag, type SecretsArgs } from "./secrets-args.ts";
import { printJson } from "./secrets-output.ts";
import { type CliContext, UsageError } from "./types.ts";

// ── Password managers ────────────────────────────────────────────────────────

const pmProviderSchema = z.enum([
	"1password-connect",
	"1password-service-account",
	"bitwarden-sm",
]);

/** Exit code of `pm read` while the caller's use awaits a human approval. */
export const PM_PENDING_EXIT = 3;

/** A provider token from piped stdin. Tokens are never accepted as
 *  arguments (they would land in shell history and the process table). */
async function readToken(ctx: CliContext): Promise<string> {
	const piped = await ctx.readStdin();
	const token = piped?.replace(/\r?\n$/, "").trim() ?? "";
	if (!token) {
		throw new UsageError(
			"Pipe the provider token on stdin (for example from your password manager's CLI); it is never accepted as an argument."
		);
	}
	return token;
}

async function pmAccountByName(
	ctx: CliContext,
	name: string
): Promise<VaultPasswordManagerAccount> {
	const { accounts } = await listVaultPasswordManagerAccounts(ctx.target);
	const account = accounts.find((candidate) => candidate.name === name);
	if (!account) {
		throw new UsageError(`No password-manager account named '${name}'.`);
	}
	return account;
}

async function pmAccounts(ctx: CliContext): Promise<number> {
	const { accounts } = await listVaultPasswordManagerAccounts(ctx.target);
	if (ctx.flags.json) {
		printJson(ctx, accounts);
		return 0;
	}
	if (accounts.length === 0) {
		ctx.io.out("No password-manager accounts.\n");
		return 0;
	}
	const rows = accounts.map((account) => [
		account.name,
		account.provider,
		account.state,
		account.address ?? "",
		truncate(account.lastError ?? "", 40),
	]);
	ctx.io.out(
		`${formatTable(["NAME", "PROVIDER", "STATE", "ADDRESS", "LAST ERROR"], rows)}\n`
	);
	return 0;
}

async function pmAdd(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const usage =
		"pm add NAME --provider 1password-connect|1password-service-account|bitwarden-sm [--address URL]";
	const name = arg(args, 2, usage);
	const provider = pmProviderSchema.safeParse(flag(args, "--provider"));
	if (!provider.success) {
		throw new UsageError(`Usage: ryu-cli secrets ${usage}`);
	}
	const address = flag(args, "--address");
	const token = await readToken(ctx);
	const { account } = await createVaultPasswordManagerAccount(ctx.target, {
		name,
		provider: provider.data,
		token,
		...(address ? { address } : {}),
	});
	if (ctx.flags.json) {
		printJson(ctx, account);
	} else {
		ctx.io.out(
			`${tf("Added {provider} account {name}. Run 'ryu-cli secrets pm test {name}' to check it.", { provider: account.provider, name: account.name })}\n`
		);
	}
	return 0;
}

async function pmTest(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const account = await pmAccountByName(ctx, arg(args, 2, "pm test NAME"));
	const result = await testVaultPasswordManagerAccount(ctx.target, account.id);
	if (ctx.flags.json) {
		printJson(ctx, result);
	} else if (result.ok) {
		ctx.io.out(`${account.name}: connected.\n`);
	} else {
		ctx.io.err(
			`${account.name}: ${result.account?.state ?? "error"}: ${result.error ?? "check failed"}\n`
		);
	}
	return result.ok ? 0 : 1;
}

async function pmReconnect(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const account = await pmAccountByName(ctx, arg(args, 2, "pm reconnect NAME"));
	const token = await readToken(ctx);
	await setVaultPasswordManagerToken(ctx.target, account.id, token);
	ctx.io.out(
		`${tf("Replaced the token for {name}.", { name: account.name })}\n`
	);
	return 0;
}

async function pmRemove(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const account = await pmAccountByName(ctx, arg(args, 2, "pm remove NAME"));
	await deleteVaultPasswordManagerAccount(ctx.target, account.id);
	ctx.io.out(
		`${tf("Removed {name}, its grants, and its pending approvals.", { name: account.name })}\n`
	);
	return 0;
}

async function pmRead(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const ref = arg(args, 2, "pm read REF [--env E]");
	const environment = flag(args, "--env");
	const result = await readVaultPasswordManagerRef(
		ctx.target,
		ref,
		environment ? { environment } : {}
	);
	if (result.pending) {
		if (ctx.flags.json) {
			printJson(ctx, result);
		}
		ctx.io.err(
			`${tf("Approval required: request {id} is pending. Approve it with 'ryu-cli secrets pm approvals approve {id}' (or in Desktop), then read again.", { id: result.approval.id })}\n`
		);
		return PM_PENDING_EXIT;
	}
	if (ctx.flags.json) {
		printJson(ctx, result);
	} else {
		ctx.io.out(`${result.value}\n`);
	}
	return 0;
}

const pmStatusSchema = z.enum(["pending", "approved", "rejected", "expired"]);

async function pmApprovals(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const action = args.positional[2] ?? "list";
	if (action === "approve" || action === "reject") {
		const id = arg(args, 3, `pm approvals ${action} ID`);
		const note = flag(args, "--reason");
		const grant = grantFlag(args);
		const result = await decideVaultPasswordManagerApproval(
			ctx.target,
			id,
			action,
			{ ...(note ? { note } : {}), ...(grant ? { grant } : {}) }
		);
		if (ctx.flags.json) {
			printJson(ctx, result);
		} else if ("grant" in result) {
			ctx.io.out(
				`${tf("Approved {id}: {subject} may use {ref} ({mode}).", { id, subject: result.grant.subject, ref: result.grant.ref, mode: result.grant.mode })}\n`
			);
		} else {
			ctx.io.out(`Rejected ${id}.\n`);
		}
		return 0;
	}
	if (action !== "list") {
		throw new UsageError(
			"Usage: ryu-cli secrets pm approvals [list [--status S] | approve ID [--grant G] | reject ID [--reason R]]"
		);
	}
	const status = pmStatusSchema.safeParse(flag(args, "--status") ?? "pending");
	if (!status.success) {
		throw new UsageError(
			"--status must be pending, approved, rejected, or expired."
		);
	}
	const { approvals } = await listVaultPasswordManagerApprovals(ctx.target, {
		status: status.data,
	});
	if (ctx.flags.json) {
		printJson(ctx, approvals);
		return 0;
	}
	if (approvals.length === 0) {
		ctx.io.out(
			`${tf("No {status} password-manager approvals.", { status: status.data })}\n`
		);
		return 0;
	}
	const rows = approvals.map((approval) => [
		approval.id,
		approval.credentialUse?.subject ?? "",
		approval.credentialUse?.ref ?? "",
		approval.requestedBy,
		String(approval.expiresAt),
	]);
	ctx.io.out(
		`${formatTable(["ID", "SUBJECT", "REF", "REQUESTED BY", "EXPIRES"], rows)}\n`
	);
	return 0;
}

async function pmGrants(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const action = args.positional[2] ?? "list";
	if (action === "revoke") {
		const id = arg(args, 3, "pm grants revoke ID");
		const { grant } = await revokeVaultPasswordManagerGrant(ctx.target, id);
		ctx.io.out(
			`${tf("Revoked {id}; {subject} must ask again.", { id: grant.id, subject: grant.subject })}\n`
		);
		return 0;
	}
	if (action !== "list") {
		throw new UsageError(
			"Usage: ryu-cli secrets pm grants [--all] | pm grants revoke ID"
		);
	}
	const { grants } = await listVaultPasswordManagerGrants(ctx.target, {
		all: args.booleans.has("--all"),
	});
	if (ctx.flags.json) {
		printJson(ctx, grants);
		return 0;
	}
	if (grants.length === 0) {
		ctx.io.out("No password-manager grants.\n");
		return 0;
	}
	const rows = grants.map((grant) => [
		grant.id,
		grant.subject,
		grant.ref,
		grant.mode,
		grant.usesRemaining === null ? "" : String(grant.usesRemaining),
		String(grant.expiresAt),
	]);
	ctx.io.out(
		`${formatTable(["ID", "SUBJECT", "REF", "MODE", "USES LEFT", "EXPIRES"], rows)}\n`
	);
	return 0;
}

const PM_USAGE =
	"Usage: ryu-cli secrets pm accounts|add|test|reconnect|remove|read|approvals|grants";

export async function passwordManagers(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	switch (args.positional[1]) {
		case "accounts":
			return await pmAccounts(ctx);
		case "add":
			return await pmAdd(ctx, args);
		case "test":
			return await pmTest(ctx, args);
		case "reconnect":
			return await pmReconnect(ctx, args);
		case "remove":
		case "rm":
			return await pmRemove(ctx, args);
		case "read":
			return await pmRead(ctx, args);
		case "approvals":
			return await pmApprovals(ctx, args);
		case "grants":
			return await pmGrants(ctx, args);
		default:
			throw new UsageError(PM_USAGE);
	}
}

import { readFile } from "node:fs/promises";
import {
	bindVaultPolicy,
	decideVaultChangeRequest,
	deleteVaultEnvironment,
	deleteVaultPolicy,
	getVaultStatus,
	listVaultAudit,
	listVaultChangeRequests,
	listVaultEnvironments,
	listVaultPolicies,
	putVaultEnvironment,
	putVaultPolicy,
	sealVault,
	unbindVaultPolicy,
	unsealVault,
	type VaultPolicyRule,
	vaultAgentRevokeSelf,
	vaultAppRoleLogin,
	vaultJwtLogin,
	verifyVaultAudit,
} from "@ryuhq/core-client/vault";
import { z } from "zod";
import { tf } from "../i18n/translate.ts";
import { formatTable, truncate } from "./output.ts";
import {
	arg,
	flag,
	intFlag,
	rfc3339,
	type SecretsArgs,
} from "./secrets-args.ts";
import {
	agentTarget,
	machineTarget,
	policyKey,
	printJson,
	sealLine,
} from "./secrets-output.ts";
import { type CliContext, UsageError } from "./types.ts";

// ── Administration ───────────────────────────────────────────────────────────

export async function environments(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const action = args.positional[1] ?? "list";
	if (action === "list") {
		const result = await listVaultEnvironments(ctx.target);
		if (ctx.flags.json) {
			printJson(ctx, result);
			return 0;
		}
		const rows = result.environments.map((env) => [
			`${env.slug}${env.slug === result.active ? " *" : ""}`,
			env.name,
			env.protected ? `yes (${env.requiredApprovals})` : "no",
		]);
		ctx.io.out(`${formatTable(["SLUG", "NAME", "PROTECTED"], rows)}\n`);
		return 0;
	}
	const slug = arg(args, 2, `env ${action} SLUG`);
	if (action === "delete") {
		await deleteVaultEnvironment(ctx.target, slug);
		ctx.io.out(`${tf("Deleted environment {slug}.", { slug })}\n`);
		return 0;
	}
	if (action !== "set") {
		throw new UsageError("Usage: ryu-cli secrets env list|set|delete");
	}
	// PUT replaces the record; start from the current one so `env set prod
	// --approvals 2` does not silently unprotect or rename it.
	const { environments: current } = await listVaultEnvironments(ctx.target);
	const existing = current.find((env) => env.slug === slug);
	const protectedFlag = args.booleans.has("--protected")
		? true
		: args.booleans.has("--unprotected")
			? false
			: undefined;
	const { environment } = await putVaultEnvironment(ctx.target, slug, {
		name: flag(args, "--name") ?? existing?.name ?? slug,
		protected: protectedFlag ?? existing?.protected ?? false,
		requiredApprovals:
			intFlag(args, "--approvals") ?? existing?.requiredApprovals ?? 1,
		position: intFlag(args, "--position") ?? existing?.position ?? 0,
	});
	if (ctx.flags.json) {
		printJson(ctx, environment);
	} else {
		ctx.io.out(
			`${tf("Saved environment {slug}.", { slug: environment.slug })}\n`
		);
	}
	return 0;
}

const vaultPolicyRuleSchema = z.looseObject({
	path: z.string(),
	capabilities: z.array(
		z.enum(["list", "use", "read", "write", "delete", "admin", "approve"])
	),
	deny: z.boolean().optional(),
}) satisfies z.ZodType<VaultPolicyRule>;
const vaultPolicyFileSchema = z.union([
	z.array(vaultPolicyRuleSchema).transform((rules) => ({ rules })),
	z.object({
		rules: z.array(vaultPolicyRuleSchema),
		description: z.string().optional().catch(undefined),
	}),
]);
type VaultPolicyFile = z.infer<typeof vaultPolicyFileSchema>;
async function readPolicyFile(file: string): Promise<VaultPolicyFile> {
	let parsed: ReturnType<typeof vaultPolicyFileSchema.safeParse>;
	try {
		parsed = vaultPolicyFileSchema.safeParse(
			JSON.parse(await readFile(file, "utf8"))
		);
	} catch (error) {
		throw new UsageError(
			`Policy file ${file} must be JSON: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	if (!parsed.success) {
		throw new UsageError(
			`Policy file ${file} must be {"rules": [...]} or a valid rules array.`
		);
	}
	return parsed.data;
}

export async function policies(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const action = args.positional[1] ?? "list";
	if (action === "list") {
		const result = await listVaultPolicies(ctx.target);
		if (ctx.flags.json) {
			printJson(ctx, result);
			return 0;
		}
		const policyRows = result.policies.map((policy) => [
			policy.name,
			String(policy.rules.length),
			truncate(policy.description, 50),
		]);
		const bindingRows = result.bindings.map((binding) => [
			binding.id,
			binding.policy,
			binding.subject,
			String(binding.expiresAt ?? ""),
		]);
		ctx.io.out(
			`${formatTable(["POLICY", "RULES", "DESCRIPTION"], policyRows)}\n\n${formatTable(["BINDING", "POLICY", "SUBJECT", "EXPIRES"], bindingRows)}\n`
		);
		return 0;
	}
	if (action === "set") {
		const name = arg(args, 2, "policy set NAME FILE");
		const body = await readPolicyFile(arg(args, 3, "policy set NAME FILE"));
		await putVaultPolicy(ctx.target, name, body);
		ctx.io.out(`${tf("Saved policy {name}.", { name })}\n`);
		return 0;
	}
	if (action === "delete") {
		const name = arg(args, 2, "policy delete NAME");
		await deleteVaultPolicy(ctx.target, name);
		ctx.io.out(`${tf("Deleted policy {name}.", { name })}\n`);
		return 0;
	}
	if (action === "bind") {
		const policy = arg(args, 2, "policy bind POLICY SUBJECT [--expires-at T]");
		const subject = arg(args, 3, "policy bind POLICY SUBJECT [--expires-at T]");
		const expiresAt = flag(args, "--expires-at");
		const input: Parameters<typeof bindVaultPolicy>[1] = { policy, subject };
		if (expiresAt) {
			input.expiresAt = rfc3339(expiresAt, "--expires-at");
		}
		const { binding } = await bindVaultPolicy(ctx.target, input);
		if (ctx.flags.json) {
			printJson(ctx, binding);
		} else {
			ctx.io.out(
				`${tf("Bound {policy} to {subject} (binding {id}).", { policy, subject, id: binding.id })}\n`
			);
		}
		return 0;
	}
	if (action === "unbind") {
		const id = arg(args, 2, "policy unbind BINDING_ID");
		await unbindVaultPolicy(ctx.target, id);
		ctx.io.out(`${tf("Removed binding {id}.", { id })}\n`);
		return 0;
	}
	throw new UsageError(
		"Usage: ryu-cli secrets policy list|set|delete|bind|unbind"
	);
}

const vaultChangeStatusSchema = z.enum([
	"pending",
	"applied",
	"rejected",
	"canceled",
]);

export async function approvals(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const action = args.positional[1] ?? "list";
	if (action === "list") {
		const status = vaultChangeStatusSchema.safeParse(
			flag(args, "--status") ?? "pending"
		);
		if (!status.success) {
			throw new UsageError(
				"--status must be pending, applied, rejected, or canceled."
			);
		}
		const { changeRequests } = await listVaultChangeRequests(
			ctx.target,
			status.data
		);
		if (ctx.flags.json) {
			printJson(ctx, changeRequests);
			return 0;
		}
		if (changeRequests.length === 0) {
			ctx.io.out(
				`${tf("No {status} change requests.", { status: String(status) })}\n`
			);
			return 0;
		}
		const rows = changeRequests.map((request) => [
			request.id,
			request.status,
			request.operation,
			policyKey(
				request.coords.environment,
				request.coords.path,
				request.coords.name
			),
			`${request.approvals.length}/${request.requiredApprovals}`,
			request.requestedBy,
		]);
		ctx.io.out(
			`${formatTable(["ID", "STATUS", "OP", "KEY", "APPROVALS", "REQUESTED BY"], rows)}\n`
		);
		return 0;
	}
	if (action !== "approve" && action !== "reject") {
		throw new UsageError(
			"Usage: ryu-cli secrets approvals list|approve ID|reject ID"
		);
	}
	const id = arg(args, 2, `approvals ${action} ID`);
	const { changeRequest } = await decideVaultChangeRequest(
		ctx.target,
		id,
		action,
		flag(args, "--reason")
	);
	if (ctx.flags.json) {
		printJson(ctx, changeRequest);
	} else {
		ctx.io.out(
			`${tf("Change request {id} is now {status}.", { id, status: changeRequest.status })}\n`
		);
	}
	return 0;
}

export async function audit(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	if (args.booleans.has("--verify")) {
		const { report } = await verifyVaultAudit(ctx.target);
		if (ctx.flags.json) {
			printJson(ctx, report);
		} else if (report.ok) {
			ctx.io.out(
				`${tf("Audit chain intact ({rows} rows).", { rows: String(report.rows) })}\n`
			);
		} else {
			ctx.io.out(
				`${tf("Audit chain BROKEN at seq {seq} ({rows} rows checked).", { seq: String(report.firstBadSeq ?? "?"), rows: String(report.rows) })}\n`
			);
		}
		return report.ok ? 0 : 1;
	}
	const result = await listVaultAudit(ctx.target, {
		limit: intFlag(args, "--limit"),
		before: intFlag(args, "--before"),
		name: flag(args, "--name"),
		environment: flag(args, "--env"),
	});
	if (ctx.flags.json) {
		printJson(ctx, result);
		return 0;
	}
	const rows = result.events.map((event) => [
		String(event.seq),
		event.at,
		`${event.actor.kind}${event.actor.id ? `:${event.actor.id}` : ""}`,
		event.action,
		event.outcome,
		event.name
			? policyKey(event.environment ?? "?", event.path ?? "/", event.name)
			: "",
	]);
	ctx.io.out(
		`${formatTable(["SEQ", "AT", "ACTOR", "ACTION", "OUTCOME", "KEY"], rows)}\n`
	);
	if (result.nextBefore !== null && result.events.length > 0) {
		ctx.io.out(
			`${tf("More: ryu-cli secrets audit --before {nextBefore}", { nextBefore: String(result.nextBefore) })}\n`
		);
	}
	return 0;
}

export async function sealCommand(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const action = args.positional[0];
	if (action === "status") {
		const status = await getVaultStatus(ctx.target);
		if (ctx.flags.json) {
			printJson(ctx, status);
		} else {
			ctx.io.out(
				`${sealLine(status.seal)}\n${tf("Active environment: {activeEnvironment}", { activeEnvironment: status.activeEnvironment })}\n${tf("Shared values: {source}", { source: status.sharedRemote ? "control plane" : "local" })}\n`
			);
		}
		return 0;
	}
	const { seal } =
		action === "seal"
			? await sealVault(ctx.target)
			: await unsealVault(ctx.target, args.positional[1]);
	if (ctx.flags.json) {
		printJson(ctx, seal);
	} else {
		ctx.io.out(`${sealLine(seal)}\n`);
	}
	return 0;
}

// ── Machine login ────────────────────────────────────────────────────────────

export async function login(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const target = machineTarget(ctx);
	let result: Awaited<ReturnType<typeof vaultAppRoleLogin>>;
	if (args.booleans.has("--approle")) {
		result = await vaultAppRoleLogin(target, {
			roleId: arg(args, 1, "login --approle ROLE_ID SECRET_ID"),
			secretId: arg(args, 2, "login --approle ROLE_ID SECRET_ID"),
		});
	} else if (args.booleans.has("--jwt")) {
		result = await vaultJwtLogin(target, {
			identity: arg(args, 1, "login --jwt IDENTITY JWT"),
			jwt: arg(args, 2, "login --jwt IDENTITY JWT"),
		});
	} else {
		throw new UsageError(
			"Usage: ryu-cli secrets login --approle ROLE_ID SECRET_ID | --jwt IDENTITY JWT"
		);
	}
	if (ctx.flags.json) {
		printJson(ctx, result.token);
	} else {
		ctx.io.out(`${result.token.token}\n`);
		ctx.io.err(
			`${tf("Vault token for {identityId} expires {expiresAt}. Export it as RYU_VAULT_TOKEN.", { identityId: result.token.identityId, expiresAt: String(result.token.expiresAt) })}\n`
		);
		ctx.io.err(
			`${tf("Vault/OpenBao CLIs work too (Ryu serves the /v1 API): export VAULT_ADDR={address} VAULT_TOKEN=<this token>", { address: ctx.target.url.replace(/\/+$/, "") })}\n`
		);
	}
	return 0;
}

export async function logout(ctx: CliContext): Promise<number> {
	const agent = agentTarget(ctx);
	if (!agent) {
		throw new UsageError("RYU_VAULT_TOKEN is not set; nothing to revoke.");
	}
	await vaultAgentRevokeSelf(agent);
	ctx.io.out("Revoked RYU_VAULT_TOKEN.\n");
	return 0;
}

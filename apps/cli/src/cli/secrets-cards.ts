import {
	decideVaultCardApproval,
	listVaultCardApprovals,
	type VaultCardApprovalStatus,
	type VaultCardApproveInput,
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

// ── Payment card approvals ───────────────────────────────────────────────────

const cardApprovalStatusSchema = z.enum([
	"pending",
	"approved",
	"rejected",
	"expired",
	"consumed",
	"revoked",
]);
const cardApprovalModeSchema = z.enum(["once", "grant"]);
const cardGrantSubjectSchema = z.enum(["session", "agent"]);

const CARD_APPROVALS_USAGE =
	"Usage: ryu-cli secrets cards approvals [list [--status S] [--env E] | approve ID [--mode once|grant] [--subject session|agent] [--ttl 15m] [--max-uses N] | reject ID | revoke ID]";

function cardApproveInput(args: SecretsArgs): VaultCardApproveInput {
	const input: VaultCardApproveInput = {};
	const mode = flag(args, "--mode");
	if (mode !== undefined) {
		const parsed = cardApprovalModeSchema.safeParse(mode);
		if (!parsed.success) {
			throw new UsageError("--mode must be once or grant.");
		}
		input.mode = parsed.data;
	}
	const subject = flag(args, "--subject");
	if (subject !== undefined) {
		const parsed = cardGrantSubjectSchema.safeParse(subject);
		if (!parsed.success) {
			throw new UsageError("--subject must be session or agent.");
		}
		input.subject = parsed.data;
	}
	const ttl = flag(args, "--ttl");
	if (ttl !== undefined) {
		input.ttlSecs = parseDuration(ttl);
	}
	const maxUses = intFlag(args, "--max-uses");
	if (maxUses !== undefined) {
		input.maxUses = maxUses;
	}
	const note = flag(args, "--reason");
	if (note) {
		input.note = note;
	}
	return input;
}

async function cardApprovalsList(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const status = cardApprovalStatusSchema.safeParse(
		flag(args, "--status") ?? "pending"
	);
	if (!status.success) {
		throw new UsageError(
			"--status must be pending, approved, rejected, expired, consumed, or revoked."
		);
	}
	const filter: { environment?: string; status: VaultCardApprovalStatus } = {
		status: status.data,
	};
	const environment = flag(args, "--env");
	if (environment) {
		filter.environment = environment;
	}
	const { approvals } = await listVaultCardApprovals(ctx.target, filter);
	if (ctx.flags.json) {
		printJson(ctx, approvals);
		return 0;
	}
	if (approvals.length === 0) {
		ctx.io.out(
			`${tf("No {status} card approvals.", { status: status.data })}\n`
		);
		return 0;
	}
	const rows = approvals.map((approval) => [
		approval.id,
		approval.key,
		`${approval.brand ?? "card"} ${approval.last4 ?? ""}`.trim(),
		approval.channel,
		approval.merchantHost || (approval.field ? `field ${approval.field}` : "-"),
		approval.requester,
		approval.status,
	]);
	ctx.io.out(
		`${formatTable(["ID", "CARD", "BRAND", "VIA", "MERCHANT", "REQUESTER", "STATUS"], rows)}\n`
	);
	return 0;
}

export async function cards(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	if (args.positional[1] !== "approvals") {
		throw new UsageError(CARD_APPROVALS_USAGE);
	}
	const action = args.positional[2];
	if (action === undefined || action === "list") {
		return await cardApprovalsList(ctx, args);
	}
	if (action !== "approve" && action !== "reject" && action !== "revoke") {
		throw new UsageError(CARD_APPROVALS_USAGE);
	}
	const id = arg(args, 3, `cards approvals ${action} ID`);
	const input: VaultCardApproveInput =
		action === "approve" ? cardApproveInput(args) : {};
	const note = flag(args, "--reason");
	if (action !== "approve" && note) {
		input.note = note;
	}
	const { approval } = await decideVaultCardApproval(
		ctx.target,
		id,
		action,
		input
	);
	if (ctx.flags.json) {
		printJson(ctx, approval);
		return 0;
	}
	const verb = {
		approve: "Approved",
		reject: "Rejected",
		revoke: "Revoked",
	}[action];
	const scope =
		action === "approve" && approval.mode === "grant"
			? ` (grant for ${approval.grantSubject ?? "the requester"} at ${approval.merchantHost}${approval.maxUses ? `, ${approval.maxUses} uses` : ""})`
			: "";
	ctx.io.out(
		`${tf("{verb} card approval {id}{scope}.", { verb, id, scope })}\n`
	);
	return 0;
}

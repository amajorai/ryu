// `ryu secrets control-group …`: reveals that a policy gates behind named
// approvers. `get` on a gated value opens a request and prints how to redeem
// it; approvers `authorize` it; the requester `redeem`s the single-use token
// for the value, which the agent guard refuses.

import {
	authorizeVaultControlGroup,
	getVaultControlGroup,
	listVaultControlGroups,
	redeemVaultControlGroup,
	type VaultControlGroup,
} from "@ryuhq/core-client/vault";
import { tf, tr } from "../i18n/translate.ts";
import { formatTable } from "./output.ts";
import { arg, type SecretsArgs } from "./secrets-args.ts";
import { printJson } from "./secrets-output.ts";
import { type CliContext, UsageError } from "./types.ts";

/** Exit code while a control-group request still needs approvals. */
export const CONTROL_GROUP_PENDING_EXIT = 3;

const USAGE =
	"Usage: ryu-cli secrets control-group list | show ID | authorize ID | redeem ID TOKEN";

function progress(group: VaultControlGroup): string {
	return group.factors
		.map((factor) => {
			const given = new Set(
				group.approvals
					.filter((approval) => approval.factor === factor.name)
					.map((approval) => approval.approver)
			).size;
			return `${factor.name} ${Math.min(given, factor.approvals)}/${factor.approvals}`;
		})
		.join(", ");
}

function groupRow(group: VaultControlGroup): string[] {
	return [
		group.id,
		group.status,
		group.policyKey,
		progress(group),
		group.requester,
		String(group.expiresAt),
	];
}

const COLUMNS = ["ID", "STATUS", "KEY", "APPROVALS", "REQUESTED BY", "EXPIRES"];

function printGroup(ctx: CliContext, group: VaultControlGroup): void {
	ctx.io.out(`${formatTable(COLUMNS, [groupRow(group)])}\n`);
}

/** Tell the requester how to finish a reveal that opened a control group. */
export function reportOpenedControlGroup(
	ctx: CliContext,
	group: VaultControlGroup,
	token: string
): number {
	if (ctx.flags.json) {
		printJson(ctx, { status: "control_group", controlGroup: group, token });
		return CONTROL_GROUP_PENDING_EXIT;
	}
	ctx.io.err(
		`${tf("Approval required: {key} is gated by control group {id} ({progress}). An approver runs: ryu-cli secrets control-group authorize {id}", { key: group.policyKey, id: group.id, progress: progress(group) })}\n`
	);
	ctx.io.err(
		`${tf("Then redeem it once: ryu-cli secrets control-group redeem {id} {token}", { id: group.id, token })}\n`
	);
	return CONTROL_GROUP_PENDING_EXIT;
}

export async function controlGroups(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const action = args.positional[1] ?? "list";
	if (action === "list") {
		const { controlGroups: groups } = await listVaultControlGroups(ctx.target);
		if (ctx.flags.json) {
			printJson(ctx, groups);
		} else if (groups.length === 0) {
			ctx.io.out(`${tr("No control-group requests.")}\n`);
		} else {
			ctx.io.out(`${formatTable(COLUMNS, groups.map(groupRow))}\n`);
		}
		return 0;
	}
	const id = arg(args, 2, `control-group ${action} ID`);
	if (action === "show" || action === "authorize") {
		const { controlGroup } =
			action === "show"
				? await getVaultControlGroup(ctx.target, id)
				: await authorizeVaultControlGroup(ctx.target, id);
		if (ctx.flags.json) {
			printJson(ctx, controlGroup);
		} else {
			printGroup(ctx, controlGroup);
		}
		return 0;
	}
	if (action === "redeem") {
		const token = arg(args, 3, "control-group redeem ID TOKEN");
		const { value } = await redeemVaultControlGroup(ctx.target, id, token);
		if (ctx.flags.json) {
			printJson(ctx, { value });
		} else {
			ctx.io.out(`${value}\n`);
		}
		return 0;
	}
	throw new UsageError(USAGE);
}

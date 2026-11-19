// `ryu secrets broker review`: walk the pending agent proposals one at a
// time and approve, reject (with an optional reason), or skip each, like the
// Agent Vault `review` command. It needs a person at an interactive
// terminal: without one (`promptLine` answers null) it stops. Approving here
// sends no credential values; a proposal that asks for values is approved
// with `broker proposals approve ID` or in Desktop, which can collect them.

import {
	decideVaultBrokerProposal,
	listVaultBrokerProposals,
	type VaultBrokerProposal,
} from "@ryuhq/core-client/vault";
import { tf, tr } from "../i18n/translate.ts";
import type { CliContext } from "./types.ts";

type Choice = "approve" | "reject" | "skip" | "quit";

/** The choice an answer names, or null when it names none. */
export function parseChoice(answer: string): Choice | null {
	switch (answer.trim().toLowerCase()) {
		case "a":
		case "approve":
			return "approve";
		case "r":
		case "reject":
			return "reject";
		case "s":
		case "skip":
		case "":
			return "skip";
		case "q":
		case "quit":
			return "quit";
		default:
			return null;
	}
}

function describe(proposal: VaultBrokerProposal): string {
	const lines = [
		tf("Proposal {id} from {requester} ({environment}), expires {expires}", {
			environment: proposal.environment,
			expires: String(proposal.expiresAt),
			id: proposal.id,
			requester: proposal.requestedBy,
		}),
		`  ${proposal.message}`,
	];
	for (const service of proposal.services) {
		lines.push(`  + ${JSON.stringify(service)}`);
	}
	for (const credential of proposal.credentials) {
		lines.push(`  ? ${JSON.stringify(credential)}`);
	}
	if (proposal.credentialUse) {
		lines.push(`  ~ ${JSON.stringify(proposal.credentialUse)}`);
	}
	return `${lines.join("\n")}\n`;
}

/** Prompts until it gets a known choice; null when no terminal answers. */
async function ask(ctx: CliContext): Promise<Choice | null> {
	for (;;) {
		const answer = await ctx.promptLine(
			tr("[a]pprove, [r]eject, [s]kip, or [q]uit? ")
		);
		if (answer === null) {
			return null;
		}
		const choice = parseChoice(answer);
		if (choice) {
			return choice;
		}
	}
}

export async function brokerReview(ctx: CliContext): Promise<number> {
	const { proposals } = await listVaultBrokerProposals(ctx.target, {
		status: "pending",
	});
	if (proposals.length === 0) {
		ctx.io.out(`${tr("No pending proposals to review.")}\n`);
		return 0;
	}
	const tally = { approved: 0, rejected: 0, skipped: 0 };
	for (const [index, proposal] of proposals.entries()) {
		ctx.io.out(`\n[${index + 1}/${proposals.length}] ${describe(proposal)}`);
		const choice = await ask(ctx);
		if (choice === null) {
			ctx.io.err(
				`${tr("broker review needs a person at an interactive terminal; stopping.")}\n`
			);
			return 1;
		}
		if (choice === "quit") {
			break;
		}
		if (choice === "skip") {
			tally.skipped += 1;
			continue;
		}
		if (choice === "approve") {
			await decideVaultBrokerProposal(ctx.target, proposal.id, "approve");
			tally.approved += 1;
			ctx.io.out(`${tf("Approved proposal {id}.", { id: proposal.id })}\n`);
			continue;
		}
		const reason = (await ctx.promptLine(tr("Reason (optional): ")))?.trim();
		await decideVaultBrokerProposal(
			ctx.target,
			proposal.id,
			"reject",
			reason ? { note: reason } : {}
		);
		tally.rejected += 1;
		ctx.io.out(`${tf("Rejected proposal {id}.", { id: proposal.id })}\n`);
	}
	ctx.io.out(
		`${tf("Reviewed: {approved} approved, {rejected} rejected, {skipped} skipped.", tally)}\n`
	);
	return 0;
}

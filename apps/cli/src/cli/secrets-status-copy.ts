// Whole sentences for Vault change-request and broker-proposal states. A raw
// status id (`pending`, `applied`) spliced into a translated template stays
// English in every language, so each state gets its own catalog sentence and
// only a status Core adds later falls back to the generic template.

import type {
	VaultBrokerProposal,
	VaultChangeStatus,
} from "@ryuhq/core-client/vault";
import { tf, tr } from "../i18n/translate.ts";

/** The line `secrets approvals list --status <status>` prints when empty. */
export function noChangeRequestsText(status: VaultChangeStatus): string {
	switch (status) {
		case "pending":
			return tr("No pending change requests.");
		case "applied":
			return tr("No applied change requests.");
		case "rejected":
			return tr("No rejected change requests.");
		case "canceled":
			return tr("No canceled change requests.");
		default:
			return tf("No {status} change requests.", { status: String(status) });
	}
}

/** The line printed after approving or rejecting a change request. */
export function changeRequestNowText(
	id: string,
	status: VaultChangeStatus
): string {
	switch (status) {
		case "pending":
			return tf("Change request {id} is still pending.", { id });
		case "applied":
			return tf("Change request {id} is now applied.", { id });
		case "rejected":
			return tf("Change request {id} is now rejected.", { id });
		case "canceled":
			return tf("Change request {id} is now canceled.", { id });
		default:
			return tf("Change request {id} is now {status}.", {
				id,
				status: String(status),
			});
	}
}

/** The first line `secrets broker proposal <id>` prints for a proposal. */
export function proposalStatusText(
	proposal: Pick<VaultBrokerProposal, "environment" | "id" | "status">
): string {
	const { environment, id } = proposal;
	switch (proposal.status) {
		case "pending":
			return tf("Proposal {id} is pending (environment {environment}).", {
				environment,
				id,
			});
		case "approved":
			return tf("Proposal {id} was approved (environment {environment}).", {
				environment,
				id,
			});
		case "rejected":
			return tf("Proposal {id} was rejected (environment {environment}).", {
				environment,
				id,
			});
		case "expired":
			return tf("Proposal {id} has expired (environment {environment}).", {
				environment,
				id,
			});
		default:
			return tf("Proposal {id} is {status} (environment {environment}).", {
				environment,
				id,
				status: String(proposal.status),
			});
	}
}

/** The line `secrets broker proposals --status <status>` prints when empty. */
export function noProposalsText(status: VaultBrokerProposal["status"]): string {
	switch (status) {
		case "pending":
			return tr("No pending proposals.");
		case "approved":
			return tr("No approved proposals.");
		case "rejected":
			return tr("No rejected proposals.");
		case "expired":
			return tr("No expired proposals.");
		default:
			return tf("No {status} proposals.", { status: String(status) });
	}
}

/** Where `secrets seal status` says shared values come from. */
export function sharedValuesSourceText(sharedRemote: boolean): string {
	return sharedRemote
		? tr("Shared values: control plane")
		: tr("Shared values: local");
}

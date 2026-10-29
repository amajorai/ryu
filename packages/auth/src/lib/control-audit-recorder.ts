import { defineRequestState, hasRequestState } from "@better-auth/core/context";
import { ControlAuditEvent } from "@ryu/db/models/control-audit.model";

/**
 * The control-audit seam for the organization, member, invitation and team
 * mutations Better Auth owns.
 *
 * WHY A REGISTRY AND NOT AN IMPORT. The org audit writer is
 * `recordControlAudit` in `@ryu/api/lib/control-audit`: it writes the audit row
 * and, when the org streams to a SIEM, its outbox row in the same transaction.
 * `@ryu/api` depends on `@ryu/auth`, so it cannot be imported here. Writing
 * `ControlAuditEvent` directly from this package left role changes, removals,
 * invitations and org deletion out of the customer's SIEM stream even though
 * they appeared in the org's audit log. `apps/server` registers the API writer
 * at boot, next to the other seams (same single-slot, last-wins shape as
 * `referral-grant-hook.ts`).
 */

/** One org-scoped audit row. Ids and short codes only, never request bodies. */
export interface ControlAuditRecord {
	action: string;
	actorId: string | null;
	actorType: "user" | "system";
	details: Record<string, string | number | boolean | null>;
	organizationId: string;
	target: string;
	targetId: string | null;
}

/** The implementation `apps/server` registers. */
export type ControlAuditRecorder = (
	record: ControlAuditRecord
) => Promise<void>;

let recorder: ControlAuditRecorder | null = null;

/** Install the org audit writer. Called once, from `apps/server` boot. */
export function registerControlAuditRecorder(
	implementation: ControlAuditRecorder
): void {
	recorder = implementation;
}

/**
 * Append one org control-audit row through the registered writer, so it
 * reaches the org's SIEM stream like every other control mutation.
 *
 * Without a registration (`@ryu/auth` loaded alone by a backfill script or a
 * test, where no `@ryu/api` exists) the row is still written to the audit
 * collection; there is no SIEM worker in those processes to stream it.
 *
 * Rejects when the write fails. Callers run after Better Auth has completed
 * the mutation and must catch, so an audit outage never fails it.
 */
export async function recordOrganizationControlAudit(
	record: ControlAuditRecord
): Promise<void> {
	const implementation = recorder;
	if (implementation) {
		await implementation(record);
		return;
	}
	await ControlAuditEvent.create(record);
}

/**
 * The role a member held before `/organization/update-member-role`, by member
 * id. Better Auth passes it only to `afterUpdateMemberRole`; the global after
 * hook that writes the audit row reads it from here, so the row records who
 * was moved from which role to which.
 */
const memberRolesBeforeUpdate = defineRequestState(
	() => new Map<string, string>()
);

/** Called from `afterUpdateMemberRole` with Better Auth's `previousRole`. */
export async function rememberMemberRoleBeforeUpdate(
	memberId: string,
	previousRole: string
): Promise<void> {
	if (await hasRequestState()) {
		(await memberRolesBeforeUpdate.get()).set(memberId, previousRole);
	}
}

async function takeMemberRoleBeforeUpdate(
	memberId: string | undefined
): Promise<string | null> {
	if (!(memberId && (await hasRequestState()))) {
		return null;
	}
	const before = await memberRolesBeforeUpdate.get();
	const previousRole = before.get(memberId) ?? null;
	before.delete(memberId);
	return previousRole;
}

/**
 * The redacted details of one Better Auth org mutation's audit row: the
 * method and outcome, plus the role a membership change granted and, for a
 * role update, the role it replaced. Roles are org role keys, never PII.
 */
export async function organizationAuditDetails(input: {
	memberId: string | undefined;
	method: string;
	path: string;
	role: string | undefined;
}): Promise<Record<string, string | null>> {
	const details = { method: input.method, status: "success" };
	if (input.path === "/organization/update-member-role") {
		return {
			...details,
			newRole: input.role ?? null,
			previousRole: await takeMemberRoleBeforeUpdate(input.memberId),
		};
	}
	if (
		input.path === "/organization/invite-member" ||
		input.path === "/organization/add-member"
	) {
		return { ...details, role: input.role ?? null };
	}
	return details;
}

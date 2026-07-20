import { randomUUID } from "node:crypto";
import { Member } from "@ryu/db/models/control-plane.model";

/**
 * The single organization-plugin endpoint this module needs. `auth.api` is
 * typed via deep inference that collapses when the betterAuth options have any
 * pre-existing type error, so we narrow to just `createOrganization` at the call
 * site (the org plugin guarantees it at runtime) rather than depending on the
 * full inferred surface.
 */
export interface OrganizationApi {
	createOrganization: (args: {
		body: {
			name: string;
			slug: string;
			userId: string;
			keepCurrentActiveOrganization?: boolean;
		};
	}) => Promise<unknown>;
}

/**
 * Idempotently gives a user a personal organization. Returns `created: false`
 * without writing when the user already has any membership, so this is safe to
 * call from the sign-up hook (which may fire more than once) and to re-run from
 * the backfill script after a partial failure.
 *
 * Server-side path: passes `userId` with no session headers, which the org
 * plugin uses to create the org on that user's behalf and assign them the
 * configured `creatorRole` ("owner") plus the backing `member` row — the
 * control plane's single source of truth for membership.
 *
 * Org naming is intentionally generic ("Personal") with a random, collision-free
 * slug so a freshly-signed-up user always lands in a valid org context.
 */
export async function ensurePersonalOrganization(
	userId: string,
	api: OrganizationApi
): Promise<{ created: boolean }> {
	const existing = await Member.findOne({ userId }).lean();
	if (existing) {
		return { created: false };
	}

	const slug = `personal-${randomUUID()}`;
	await api.createOrganization({
		body: {
			name: "Personal",
			slug,
			userId,
			// No session is involved on this server-side path, so don't try to mutate
			// an active organization on a (non-existent) session.
			keepCurrentActiveOrganization: true,
		},
	});

	return { created: true };
}

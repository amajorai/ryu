/**
 * Whether `userId` belongs to any organization whose access policy requires
 * two-factor authentication (`OrgSecuritySettings.requireMfa`).
 *
 * The factor-provisioning guard in `mfa-enrollment-plugin.ts` reads it: a
 * member of such an organization may add or reveal a sign-in factor only from
 * a session that already proved one, or a mailbox-only session could enroll
 * its own passkey and then sign in with it to satisfy the policy. Throws on a
 * storage error; the caller fails closed.
 *
 * The models are loaded on first use so suites that build a Better Auth
 * instance without a database never open a Mongo connection.
 */
export async function userInMfaRequiredOrganization(
	userId: string
): Promise<boolean> {
	const [{ Member }, { OrgSecuritySettings }] = await Promise.all([
		import("@ryu/db/models/control-plane.model"),
		import("@ryu/db/models/org-admin.model"),
	]);
	const memberships = await Member.find({ userId })
		.select({ organizationId: 1 })
		.lean<Array<{ organizationId?: unknown }>>();
	const organizationIds = memberships
		.map((membership) => String(membership.organizationId ?? ""))
		.filter(Boolean);
	if (organizationIds.length === 0) {
		return false;
	}
	return Boolean(
		await OrgSecuritySettings.exists({
			_id: { $in: organizationIds },
			requireMfa: true,
		})
	);
}

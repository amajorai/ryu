import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { type ApiTarget, request } from "@ryuhq/core-client/client";
import { listMentionTargetUsers } from "@ryuhq/core-client/notifications";
import { fetchApps } from "@ryuhq/core-client/plugins";
import { z } from "zod";

export interface SelectedHumanMention {
	id: string;
	label: string;
}

export interface ActiveAccountIdentity {
	email: string | null;
	name: string | null;
	userId: string;
}

const APPROVALS_APP_ID = "@ryu/approvals";
const jwtUserClaimsSchema = z.object({
	id: z.json().optional(),
	sub: z.json().optional(),
});
const userIdSchema = z.string().trim().min(1);
const accountIdentitySchema = z.object({
	userId: z.string().optional().catch(undefined),
	name: userIdSchema.nullable().catch(null),
	email: userIdSchema.nullable().catch(null),
});
const activeAccountSchema = z.object({
	activeUserId: z.string().trim().catch(""),
	accounts: z
		.array(accountIdentitySchema.nullable().catch(null))
		.optional()
		.catch(undefined),
});

/** Decode only to hide self-mentions; Core still verifies JWTs and recipients. */
function userIdFromJwt(token: string | null | undefined): string | null {
	if (!token) {
		return null;
	}
	const payload = token.split(".")[1];
	if (!payload) {
		return null;
	}
	try {
		const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
		const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
		const claims = jwtUserClaimsSchema.parse(JSON.parse(atob(padded)));
		const userId = userIdSchema.safeParse(claims.id ?? claims.sub);
		return userId.success ? userId.data : null;
	} catch {
		return null;
	}
}

/** Keep the CLI composer on the same Inbox-gated, Core-scoped directory as Desktop. */
export { listMentionTargetUsers };

/** Read Core's active local account for self-mention filtering and sender display. */
export async function fetchActiveAccountIdentity(
	target: ApiTarget
): Promise<ActiveAccountIdentity | null> {
	const delegatedUserId = userIdFromJwt(target.userJwt);
	try {
		const wire = activeAccountSchema.parse(
			await request(target, "/api/auth/accounts", {}, appResponseValueSchema)
		);
		const activeUserId = wire.activeUserId;
		const userId = delegatedUserId ?? activeUserId;
		if (!(userId && Array.isArray(wire.accounts))) {
			return delegatedUserId
				? { userId: delegatedUserId, name: null, email: null }
				: null;
		}
		const account = wire.accounts.find(
			(candidate) => candidate?.userId === userId
		);
		if (!account) {
			return delegatedUserId
				? { userId: delegatedUserId, name: null, email: null }
				: null;
		}
		return { email: account.email, name: account.name, userId };
	} catch {
		return delegatedUserId
			? { userId: delegatedUserId, name: null, email: null }
			: null;
	}
}

export interface HumanNotificationSelection {
	content: string;
	currentUserId: string | null;
	selected: readonly SelectedHumanMention[];
}
export interface MentionNotificationRequest {
	content: string;
	mentions: readonly SelectedHumanMention[];
	senderName: string;
	target: ApiTarget;
}
export interface MentionNotificationResult {
	failedNames: string[];
}

/** Match Desktop's visible-token check, de-duplication, and self-exclusion. */
export function selectHumanNotificationTargets({
	content,
	currentUserId,
	selected,
}: HumanNotificationSelection): SelectedHumanMention[] {
	const seen = new Set<string>();
	const targets: SelectedHumanMention[] = [];
	for (const mention of selected) {
		if (
			mention.id === currentUserId ||
			seen.has(mention.id) ||
			!content.includes(`@${mention.label}`)
		) {
			continue;
		}
		seen.add(mention.id);
		targets.push(mention);
	}
	return targets;
}

/** Send through Core's existing Inbox host bridge, which revalidates each recipient. */
export async function notifyMentionedUsers({
	content,
	mentions,
	senderName,
	target,
}: MentionNotificationRequest): Promise<MentionNotificationResult> {
	if (mentions.length === 0 || !content.trim()) {
		return { failedNames: [] };
	}

	const title = `${senderName} mentioned you`.slice(0, 120);
	const body = `${senderName} mentioned you in chat:\n${content.trim()}`.slice(
		0,
		1800
	);
	const results = await Promise.allSettled(
		mentions.map((mention) =>
			request(
				target,
				`/api/plugins/${encodeURIComponent(APPROVALS_APP_ID)}/host`,
				{
					method: "POST",
					body: {
						args: {
							body,
							target_user_id: mention.id,
							title,
						},
						method: "notifications.send",
					},
				},
				appResponseValueSchema
			)
		)
	);
	return {
		failedNames: results.flatMap((result, index) =>
			result.status === "rejected" && mentions[index]
				? [mentions[index].label]
				: []
		),
	};
}

/** Keep notifications behind the owning app's current lifecycle gate. */
export async function inboxEnabled(target: ApiTarget): Promise<boolean> {
	const apps = await fetchApps(target);
	return apps.some((app) => app.id === APPROVALS_APP_ID && app.enabled);
}

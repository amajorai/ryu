import type { AvatarUrls } from "@ryu/auth/lib/avatar";
import { z } from "zod";
import {
	type SubscriptionStatus,
	subscriptionStatusResponseSchema,
} from "./subscription-status-contracts.ts";
// API client for settings-related operations

import type {
	CreateOAuthAppInput,
	OAuthApp,
	OwnedOAuthApp,
} from "@ryu/auth/oauth-contract";

export type {
	CreateOAuthAppInput,
	OAuthApp,
	OwnedOAuthApp,
} from "@ryu/auth/oauth-contract";

let _apiBase: string | null = null;

let _getToken: (() => string | null) | null = null;

export function configureSettingsApi(opts: {
	getToken: () => string | null;
	baseUrl?: string;
}) {
	if (opts.baseUrl) {
		const url = new URL(opts.baseUrl);
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash
		) {
			throw new Error("Invalid settings API origin");
		}
		_apiBase = url.origin;
	}
	_getToken = opts.getToken;
}

/**
 * Session DTO for API responses.
 * Defined locally to exclude sensitive fields like `token` from the Mongoose model.
 * This represents the API contract, not the database schema.
 */
export interface Session {
	createdAt: Date;
	expiresAt: Date;
	id: string;
	ipAddress?: string;
	/** Authenticated session identity; list order is newest first. */
	isCurrent: boolean;
	userAgent?: string;
	userId: string;
}

export interface OwnerAvatarResponse {
	logo: string;
	success: true;
	urls: AvatarUrls;
}

export interface AvatarResponse {
	avatarId: string;
	avatarUrls: {
		small: string;
		medium: string;
		large: string;
		xlarge: string;
	};
	compressedSize: number;
	compressionRatio: string;
	message: string;
	originalSize: number;
	success: boolean;
}

/**
 * One reason a merge is refused, from the server's fixed vocabulary.
 *
 * Only `subject: "target"` blockers — facts about the signed-in account — ever
 * reach a client before both sides have confirmed. Refusals about the OTHER
 * account are mailed to that address instead, so the merge form can't be used to
 * probe whether a stranger has a subscription. See `docs/account-merge.md` §6.
 */
export interface AccountMergeBlocker {
	code: string;
	message: string;
	subject?: "target" | "source";
}

export interface AccountMergeStatus {
	hasActive: boolean;
	merge?: {
		id: string;
		/** `target` = the account that survives; `source` = the one being absorbed. */
		role: "target" | "source";
		/** The OTHER address in the merge — never both, so this can't be used to read one back. */
		otherEmail: string;
		status:
			| "pending"
			| "source_confirmed"
			| "target_confirmed"
			| "ready"
			| "failed";
		sourceConfirmedAt?: Date | null;
		targetConfirmedAt?: Date | null;
		createdAt: Date;
		expiresAt: Date;
		lastError?: string | null;
	};
}

/**
 * Whether the SIGNED-IN account is in a state where it can absorb another one.
 * Says nothing about the address being typed — deliberately; see
 * {@link AccountMergeBlocker}. `summary.workspaces` counts the caller's own
 * workspaces.
 */
export interface AccountMergePreflight {
	blockers: AccountMergeBlocker[];
	mergeable: boolean;
	summary?: { workspaces: number };
}

/** Why the signed-in account can't be deleted yet, and what deleting it removes. */
export interface AccountDeletionPreflight {
	blockers: Array<{ code: string; message: string }>;
	deletable: boolean;
	/** A confirmation email is waiting to be used. */
	pending: boolean;
	summary: {
		/** Prepaid credit in workspaces deleted with the account (micro-USD). */
		forfeitedCreditMicroUsd: number;
		/** Workspaces where this account is the only member. */
		workspacesDeleted: number;
		/** Shared workspaces the account leaves. */
		workspacesLeft: number;
	};
}

export interface EmailChangeStatus {
	emailChange?: {
		id: string;
		newEmail: string;
		oldEmail: string;
		status: "pending" | "old_confirmed" | "new_confirmed";
		statusMessage: string;
		createdAt: Date;
		expiresAt: Date;
		oldEmailConfirmedAt?: Date;
		newEmailConfirmedAt?: Date;
	};
	hasActive: boolean;
}

export interface PasswordStatus {
	authMethod: string;
	hasPassword: boolean;
	provider: string | null;
}

export interface Subscription {
	cancelAtPeriodEnd?: boolean;
	currentPeriodEnd?: string;
	id: string;
	interval?: string;
	status: string;
}

export type { SubscriptionStatus } from "./subscription-status-contracts.ts";

export interface Invoice {
	amount: number;
	createdAt: string;
	currency: string;
	id: string;
	productId: string;
	status: string;
}

export interface ReferralProgram {
	provider: "ryu";
	referralCode: string | null;
	referralLink: string | null;
	reward: {
		referred: string;
		referrer: string;
	};
	status: "active";
}

/**
 * Where one referred friend has got to. `activated` is the in-flight state — the
 * friend qualified and the reward is being minted — and is deliberately distinct
 * from `pending`, which is still waiting on them. `denied` is terminal.
 */
export type CreditReferralState = "activated" | "denied" | "paid" | "pending";

export interface CreditReferralReferee {
	/** Face value of the reward, in MICRO-USD. Null until the reward is paid. */
	amountMicroUsd: number | null;
	deniedReason: string | null;
	id: string;
	joinedAt: string;
	/** The friend, masked — a share link is public, so the address is not ours. */
	label: string;
	paidAt: string | null;
	state: CreditReferralState;
}

/**
 * The CREDIT half of the referral program — Ryu credits from the donated pool,
 * paid once a referred friend becomes a paying customer. Every amount here is
 * MICRO-USD (1_000_000 = $1), NOT the minor units the cash commission side uses.
 */
export interface CreditReferralDashboard {
	cap: {
		capMicroUsd: number;
		/** Lifetime credits earned (micro-USD). Monotonic — never a balance. */
		earnedMicroUsd: number;
		paidCount: number;
		/** Null when uncapped; a `0` ceiling means no limit, not no headroom. */
		remainingMicroUsd: number | null;
		uncapped: boolean;
	};
	referrals: CreditReferralReferee[];
	/** Null on either side when that campaign is closed or unusable. */
	reward: {
		refereeMicroUsd: number | null;
		referrerMicroUsd: number | null;
	};
}

export type OnboardingStatus = "none" | "pending" | "active" | "restricted";

export interface CommissionRule {
	durationMonths: number | null;
	fundedBy: "platform" | "seller";
	recurring: boolean;
	// percent value is in BASIS POINTS (2000 = 20%); flat value is MINOR UNITS (cents).
	type: "percent" | "flat";
	value: number;
}

export interface AffiliateStats {
	approvedMinor: number;
	currency: string;
	paidMinor: number;
	pendingMinor: number;
	reversedMinor: number;
}

export interface CommissionView {
	commissionAmountMinor: number;
	createdAt: string;
	currency: string;
	grossAmountMinor: number;
	id: string;
	occurredAt: string;
	payoutId: string;
	referredUserId: string;
	referrerUserId: string;
	sourceRef: string;
	sourceType: string;
	status: string;
	subscriptionId: string;
}

export interface PayoutStatus {
	onboardingStatus: OnboardingStatus;
	payoutOrgId: string | null;
	payoutsEnabled: boolean;
	stripeConnectAccountId: string | null;
}

export interface AffiliateDashboard {
	defaultCommission: CommissionRule | null;
	enabled: boolean;
	payout: {
		stripeConnectAccountId: string | null;
		payoutsEnabled: boolean;
		onboardingStatus: OnboardingStatus;
	};
	payoutOrgId: string | null;
	provider: "ryu";
	recentCommissions: CommissionView[];
	referralCode: string | null;
	referralLink: string | null;
	stats: AffiliateStats;
}

function runtimeProcess(): typeof process | undefined {
	try {
		return process;
	} catch (error) {
		if (error instanceof ReferenceError) {
			return undefined;
		}
		throw error;
	}
}

function apiBase(): string {
	if (_apiBase) {
		return _apiBase;
	}
	const webBase =
		runtimeProcess() === undefined
			? undefined
			: process.env.NEXT_PUBLIC_SERVER_URL;
	if (webBase) {
		const url = new URL(webBase);
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash
		) {
			throw new Error("Invalid settings API origin");
		}
		return url.origin;
	}
	if (globalThis.window !== undefined) {
		return window.location.origin;
	}
	throw new Error("Settings API origin is not configured");
}
const ApiErrorSchema = z.object({ error: z.string().optional() });

function responseError(
	payload: z.input<typeof ApiErrorSchema>,
	fallback: string
): string {
	const parsed = ApiErrorSchema.safeParse(payload);
	return parsed.success ? (parsed.data.error ?? fallback) : fallback;
}

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
	const token = _getToken?.();
	const headers = new Headers({ "Content-Type": "application/json" });
	if (token) {
		headers.set("Authorization", `Bearer ${token}`);
	}
	new Headers(options?.headers).forEach((value, key) =>
		headers.set(key, value)
	);
	const response = await fetch(`${apiBase()}${path}`, {
		...options,
		credentials: "include",
		headers,
	});

	if (!response.ok) {
		const error = await response
			.json()
			.catch(() => ({ error: "Unknown error" }));
		throw new Error(responseError(error, `HTTP ${response.status}`));
	}

	return response.json();
}

/**
 * Upload an avatar to any owner-scoped endpoint. The user, org, and team routes
 * all take the same multipart shape (`avatar` field) and the same auth (bearer
 * when present, cookies otherwise), so they share one implementation.
 */
async function postAvatar(
	path: string,
	file: File
): Promise<OwnerAvatarResponse> {
	const formData = new FormData();
	formData.append("avatar", file);
	const token = _getToken?.();

	const response = await fetch(`${apiBase()}${path}`, {
		method: "POST",
		body: formData,
		credentials: "include",
		headers: token ? { Authorization: `Bearer ${token}` } : undefined,
	});

	if (!response.ok) {
		const error = await response
			.json()
			.catch(() => ({ error: "Upload failed" }));
		throw new Error(error.error ?? "Upload failed");
	}
	return response.json();
}

export const settingsApi = {
	/** Org + team logos. Server-side these are owner/admin only. */
	organizations: {
		uploadAvatar(
			organizationId: string,
			file: File
		): Promise<OwnerAvatarResponse> {
			return postAvatar(`/api/orgs/${organizationId}/avatar`, file);
		},
		uploadTeamAvatar(
			organizationId: string,
			teamId: string,
			file: File
		): Promise<OwnerAvatarResponse> {
			return postAvatar(
				`/api/orgs/${organizationId}/teams/${teamId}/avatar`,
				file
			);
		},
	},
	profile: {
		async uploadAvatar(file: File): Promise<AvatarResponse> {
			const formData = new FormData();
			formData.append("avatar", file);
			const token = _getToken?.();

			const response = await fetch(`${apiBase()}/api/profile/avatar`, {
				method: "POST",
				body: formData,
				credentials: "include",
				headers: token ? { Authorization: `Bearer ${token}` } : undefined,
			});

			if (!response.ok) {
				const error = await response
					.json()
					.catch(() => ({ error: "Upload failed" }));
				throw new Error(responseError(error, "Failed to upload avatar"));
			}

			return response.json();
		},

		async deleteAvatar(): Promise<void> {
			await fetchApi("/api/profile/avatar", { method: "DELETE" });
		},

		async updateName(name: string): Promise<void> {
			await fetchApi("/api/profile/name", {
				method: "PUT",
				body: JSON.stringify({ name }),
			});
		},
	},

	user: {
		async initiateEmailChange(newEmail: string): Promise<void> {
			await fetchApi("/api/user/initiate-email-change", {
				method: "POST",
				body: JSON.stringify({ newEmail }),
			});
		},

		async confirmEmailChangeOld(token: string): Promise<void> {
			await fetchApi(`/api/user/confirm-email-change-old?token=${token}`);
		},

		async confirmEmailChangeNew(token: string): Promise<void> {
			await fetchApi(`/api/user/confirm-email-change-new?token=${token}`);
		},

		async cancelEmailChange(): Promise<void> {
			await fetchApi("/api/user/cancel-email-change", { method: "POST" });
		},

		getEmailChangeStatus(): Promise<EmailChangeStatus> {
			return fetchApi("/api/user/email-change-status");
		},

		getPasswordStatus(): Promise<PasswordStatus> {
			return fetchApi("/api/user/password-status");
		},

		/**
		 * Account merge (see `docs/account-merge.md`). The signed-in account is
		 * always the one that SURVIVES; `email` names the account being absorbed.
		 *
		 * `initiate` is step-up gated server-side, so a 403 carrying
		 * `STEP_UP_REQUIRED` here means "prompt for the second factor and retry",
		 * not "you can't do this".
		 *
		 * `checkMerge` answers about the CALLER'S account only. It takes the address
		 * so the server can reject the "merge yourself into yourself" case, and for
		 * nothing else — a mergeable address, a blocked one and an unregistered one
		 * all get the same reply.
		 */
		checkMerge(email: string): Promise<AccountMergePreflight> {
			return fetchApi(
				`/api/user/merge/preflight?email=${encodeURIComponent(email)}`
			);
		},

		async initiateMerge(email: string): Promise<void> {
			await fetchApi("/api/user/merge/initiate", {
				method: "POST",
				body: JSON.stringify({ email }),
			});
		},

		async confirmMerge(token: string): Promise<void> {
			await fetchApi("/api/user/merge/confirm", {
				method: "POST",
				body: JSON.stringify({ token }),
			});
		},

		getMergeStatus(): Promise<AccountMergeStatus> {
			return fetchApi("/api/user/merge/status");
		},

		async cancelMerge(): Promise<void> {
			await fetchApi("/api/user/merge/cancel", { method: "POST" });
		},

		/**
		 * Account deletion (see `docs/account-deletion.md`). `requestDeletion` is
		 * step-up gated (`account.security`) and mails a confirmation link;
		 * nothing is removed until that link is used.
		 */
		getDeletionPreflight(): Promise<AccountDeletionPreflight> {
			return fetchApi("/api/user/delete-account/preflight");
		},

		async requestDeletion(): Promise<void> {
			await fetchApi("/api/user/delete-account/request", { method: "POST" });
		},

		async cancelDeletion(): Promise<void> {
			await fetchApi("/api/user/delete-account/cancel", { method: "POST" });
		},

		async setPassword(newPassword: string): Promise<void> {
			await fetchApi("/api/user/set-password", {
				method: "POST",
				body: JSON.stringify({ newPassword }),
			});
		},
	},

	billing: {
		getInvoices(): Promise<{ invoices: Invoice[] }> {
			return fetchApi("/api/billing/invoices");
		},

		getSubscriptionStatus(): Promise<SubscriptionStatus> {
			return fetchApi("/api/billing/subscription-status").then(
				subscriptionStatusResponseSchema.parse
			);
		},

		createLifetimeCheckout(organizationId?: string): Promise<{ url: string }> {
			return fetchApi("/api/billing/checkout/lifetime", {
				body: JSON.stringify(organizationId ? { organizationId } : {}),
				headers: {
					"content-type": "application/json",
					"Idempotency-Key": crypto.randomUUID(),
				},
				method: "POST",
			});
		},

		getPortalUrl(): Promise<{ url: string }> {
			return fetchApi("/api/billing/portal");
		},
	},

	subscription: {
		// The server derives the email from the authenticated session.
		get(): Promise<{ subscribed: boolean }> {
			return fetchApi("/api/subscription");
		},

		async toggle(action: "subscribe" | "unsubscribe"): Promise<void> {
			await fetchApi("/api/subscription", {
				method: "POST",
				body: JSON.stringify({ action }),
			});
		},
	},

	referrals: {
		get(): Promise<ReferralProgram> {
			return fetchApi("/api/referrals");
		},

		/** The credit half of the program — see {@link CreditReferralDashboard}. */
		credits(): Promise<CreditReferralDashboard> {
			return fetchApi("/api/referrals/credits");
		},
	},

	affiliate: {
		get(): Promise<AffiliateDashboard> {
			return fetchApi("/api/affiliate");
		},

		enable(): Promise<{ enabled: true }> {
			return fetchApi("/api/affiliate/enable", { method: "POST" });
		},

		setDefaultCommission(
			rule: CommissionRule | null
		): Promise<{ defaultCommission: CommissionRule | null }> {
			return fetchApi("/api/affiliate/settings", {
				method: "PUT",
				body: JSON.stringify({ defaultCommission: rule }),
			});
		},

		onboard(body?: {
			returnUrl?: string;
			refreshUrl?: string;
		}): Promise<{ url: string; accountId: string; payoutOrgId: string }> {
			return fetchApi("/api/affiliate/onboard", {
				method: "POST",
				body: JSON.stringify(body ?? {}),
			});
		},

		status(): Promise<PayoutStatus> {
			return fetchApi("/api/affiliate/status");
		},

		payout(): Promise<{ payouts: unknown[] }> {
			return fetchApi("/api/affiliate/payout", { method: "POST" });
		},
	},

	sessions: {
		list(): Promise<{ sessions: Session[] }> {
			return fetchApi("/api/sessions");
		},

		async revoke(sessionId: string): Promise<void> {
			await fetchApi(`/api/sessions/${sessionId}`, { method: "DELETE" });
		},

		async revokeAllOthers(): Promise<void> {
			await fetchApi("/api/sessions", { method: "DELETE" });
		},
	},

	oauthApps: {
		list(): Promise<{ apps: OAuthApp[] }> {
			return fetchApi("/api/oauth-apps");
		},

		async revoke(clientId: string): Promise<void> {
			await fetchApi(`/api/oauth-apps/${encodeURIComponent(clientId)}`, {
				method: "DELETE",
			});
		},

		owned: {
			list(): Promise<{ apps: OwnedOAuthApp[] }> {
				return fetchApi("/api/oauth-apps/owned");
			},

			create(input: CreateOAuthAppInput): Promise<{ app: OwnedOAuthApp }> {
				return fetchApi("/api/oauth-apps/owned", {
					body: JSON.stringify(input),
					method: "POST",
				});
			},

			async delete(clientId: string): Promise<void> {
				await fetchApi(
					`/api/oauth-apps/owned/${encodeURIComponent(clientId)}`,
					{ method: "DELETE" }
				);
			},

			rotateSecret(clientId: string): Promise<{ app: OwnedOAuthApp }> {
				return fetchApi(
					`/api/oauth-apps/owned/${encodeURIComponent(clientId)}/rotate-secret`,
					{ method: "POST" }
				);
			},
		},
	},

	supportAccess: {
		status(): Promise<SupportAccessStatus> {
			return fetchApi("/api/support-access");
		},

		grant(input: {
			scopes: string[];
			note?: string;
			durationMinutes?: number;
		}): Promise<{ grant: SupportAccessGrant }> {
			return fetchApi("/api/support-access/grant", {
				method: "POST",
				body: JSON.stringify(input),
			});
		},

		revoke(): Promise<{ success: boolean; endedSessions: number }> {
			return fetchApi("/api/support-access/revoke", { method: "POST" });
		},

		audit(): Promise<{ audit: SupportAccessAuditEntry[] }> {
			return fetchApi("/api/support-access/audit");
		},
	},
};

export interface SupportAccessGrant {
	activeSession: boolean;
	createdAt: string;
	expiresAt: string;
	id: string;
	note: string | null;
	revokedAt: string | null;
	scopes: string[];
	status: string;
}

export interface SupportAccessStatus {
	grant: SupportAccessGrant | null;
	maxDurationMinutes: number;
}

export interface SupportAccessAuditEntry {
	actorEmail: string;
	endedAt: string | null;
	endedReason: string | null;
	id: string;
	reason: string;
	scopes: string[];
	startedAt: string;
}

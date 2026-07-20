// API client for settings-related operations

let _getToken: (() => string | null) | null = null;

export function configureSettingsApi(opts: { getToken: () => string | null }) {
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
	userAgent?: string;
	userId: string;
}

export interface OAuthApp {
	clientId: string;
	clientName: string;
	grantedAt: Date;
	icon: string | null;
	scopes: string;
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

export interface SubscriptionStatus {
	lifetime?: {
		purchasedAt: string;
		updatesExpiresAt: string;
		expired: boolean;
	} | null;
	subscription: Subscription | null;
}

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

const API_BASE =
	typeof window === "undefined"
		? "http://localhost:3000"
		: ((typeof import.meta === "undefined"
				? undefined
				: (import.meta as { env?: Record<string, string> }).env
						?.VITE_APP_BACKEND_URL) ??
			(typeof process === "undefined"
				? undefined
				: process.env.NEXT_PUBLIC_SERVER_URL) ??
			"http://localhost:3000");

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
	const token = _getToken?.();
	const response = await fetch(`${API_BASE}${path}`, {
		...options,
		credentials: "include",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...options?.headers,
		},
	});

	if (!response.ok) {
		const error = await response
			.json()
			.catch(() => ({ error: "Unknown error" }));
		throw new Error(
			(error as { error?: string }).error ?? `HTTP ${response.status}`
		);
	}

	return response.json();
}

/**
 * Upload an avatar to any owner-scoped endpoint. The user, org, and team routes
 * all take the same multipart shape (`avatar` field) and the same auth (bearer
 * when present, cookies otherwise), so they share one implementation.
 */
async function postAvatar(path: string, file: File): Promise<AvatarResponse> {
	const formData = new FormData();
	formData.append("avatar", file);
	const token = _getToken?.();

	const response = await fetch(`${API_BASE}${path}`, {
		method: "POST",
		body: formData,
		credentials: "include",
		...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
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
		uploadAvatar(organizationId: string, file: File): Promise<AvatarResponse> {
			return postAvatar(`/api/orgs/${organizationId}/avatar`, file);
		},
		uploadTeamAvatar(
			organizationId: string,
			teamId: string,
			file: File
		): Promise<AvatarResponse> {
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

			const response = await fetch(`${API_BASE}/api/profile/avatar`, {
				method: "POST",
				body: formData,
				credentials: "include",
				...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
			});

			if (!response.ok) {
				const error = await response
					.json()
					.catch(() => ({ error: "Upload failed" }));
				throw new Error(
					(error as { error?: string }).error ?? "Failed to upload avatar"
				);
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
		async initiateEmailChange(
			currentPassword: string,
			newEmail: string
		): Promise<void> {
			await fetchApi("/api/user/initiate-email-change", {
				method: "POST",
				body: JSON.stringify({ currentPassword, newEmail }),
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

		async setPassword(
			newPassword: string,
			currentPassword?: string
		): Promise<void> {
			await fetchApi("/api/user/set-password", {
				method: "POST",
				body: JSON.stringify({ newPassword, currentPassword }),
			});
		},
	},

	billing: {
		getInvoices(): Promise<{ invoices: Invoice[] }> {
			return fetchApi("/api/billing/invoices");
		},

		getSubscriptionStatus(): Promise<SubscriptionStatus> {
			return fetchApi("/api/billing/subscription-status");
		},

		createLifetimeCheckout(): Promise<{ url: string }> {
			return fetchApi("/api/billing/checkout/lifetime", { method: "POST" });
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

import type { ReactNode } from "react";
import type { LinkedAccountProvider } from "./linked-account-providers.ts";

export type ProfileTab =
	| "profile"
	| "stats"
	| "account"
	| "referrals"
	| "notifications"
	| "connections"
	| "sessions"
	| "authorized-apps"
	| "support-access"
	| "emails";

export interface LinkedAccount {
	accountId: string;
	providerId: string;
}

/** Lifetime summary the Stats header renders (from GET /me/profile). */
export interface ProfileStatsSummary {
	image?: string | null;
	joinedAt?: string;
	level: number;
	name?: string | null;
	plan?: string | null;
	pointsBalance: number;
	streak: { current: number; longest: number };
	totals: {
		inputTokens: number;
		outputTokens: number;
		requestCount: number;
		sessionCount: number;
		agentSeconds: number;
		costMicroUsd: number;
	};
	xp: number;
}

export interface RankedProfileStat {
	count: number;
	id: string;
}

export interface ProfileStatsInsights {
	activeDays: number;
	averageRequestsPerActiveDay: number;
	averageTokensPerActiveDay: number;
	favoriteModel: string | null;
	peakDay: { day: string; tokens: number } | null;
	peakHourUtc: string | null;
	topModels: RankedProfileStat[];
	topPlugins: RankedProfileStat[];
	topSkills: RankedProfileStat[];
	transport: {
		acp: number;
		gateway: number;
		openAiCompat: number;
		other: number;
	};
}

/** A single unlockable feature (from the GET /me/unlocks catalog). */
export interface ProfileFeatureUnlock {
	autoUnlockAtLevel?: number;
	description: string;
	icon?: string;
	key: string;
	pointsCost?: number;
	requiresPlan?: string[];
	tier: "default" | "progressive" | "paid";
	title: string;
}

export interface ProfileStatsPanelProps {
	/** Streak-active days from GET /me/usage/daily (newer servers only); a day
	 * listed here with no requests renders at the lowest heatmap level. */
	activeDays?: string[];
	/** Unlock catalog from GET /me/unlocks. */
	catalog?: ProfileFeatureUnlock[];
	errorMessage?: string | null;
	/** Per-feature lifetime counters from GET /me/stats. */
	featureTotals?: {
		chat: number;
		island: number;
		agentSeconds: number;
		predictAccepted: number;
	};
	insights?: ProfileStatsInsights;
	isLoading?: boolean;
	onUnlockFeature?: (key: string) => void;
	/** Spendable balance (mirrors summary.pointsBalance; kept separate so a
	 * successful spend can update it without refetching the whole summary). */
	pointsBalance?: number;
	/** Header summary; null while loading. */
	summary?: ProfileStatsSummary | null;
	unlockedKeys?: string[];
	/** The feature key currently being spent on, for a per-card spinner. */
	unlockingKey?: string | null;
	/** Heatmap data from GET /me/usage/daily. */
	usage?: Array<{ active?: boolean; day: string; count: number }>;
	/** Deep link to the caller's public Ryu Wrapped share page. */
	wrappedHref?: string;
}

export interface ProfileSettingsProps {
	/** Active tab; the live page mirrors this to the URL query. */
	activeTab?: ProfileTab;
	/** Account tab. The live page resolves this from usePasswordStatus. */
	authMethod?: string | null;
	authorizedAppsSlot?: ReactNode;
	/** App-local avatar upload widget (data-mutating, injected by the live page). */
	avatarSlot?: ReactNode;
	/** App-local change-email / change-password dialogs (injected by the live page). */
	changeEmailSlot?: ReactNode;
	changePasswordSlot?: ReactNode;
	connectingProvider?: LinkedAccountProvider | null;
	email?: string;
	emailChangeStatusSlot?: ReactNode;
	/** Emails tab: the archive of official emails Ryu sent this account. */
	emailsSlot?: ReactNode;
	/** Connections tab. */
	googleConnected?: boolean;
	isLoadingSubscription?: boolean;
	isPasswordStatusLoading?: boolean;
	isProfilePublic?: boolean;
	isSaving?: boolean;
	isSavingProfileVisibility?: boolean;
	isSavingUsername?: boolean;
	/** Notifications tab. */
	isSubscribed?: boolean;
	linkedAccounts?: LinkedAccount[];
	/**
	 * App-local "merge another account" dialog and its pending-request banner
	 * (injected by the live page), mirroring the change-email pair above. Sits in
	 * the account tab next to the email row because it is the same concern: which
	 * addresses get you into this account.
	 */
	mergeAccountsSlot?: ReactNode;
	mergeStatusSlot?: ReactNode;
	/** Profile tab. */
	name?: string;
	/**
	 * `tabs` (default) renders the page header and the tab pills. `none` renders
	 * only the active tab's body, for a host that supplies its own navigation
	 * (the web settings sidebar).
	 */
	navigation?: "none" | "tabs";
	onConnectAccount?: (providerId: LinkedAccountProvider) => void;
	onConnectGoogle?: () => void;
	onDeleteAccount?: () => void;
	onNameChange?: (name: string) => void;
	onProfilePublicToggle?: (checked: boolean) => void;
	onSaveName?: () => void;
	onSaveUsername?: () => void;
	onSubscriptionToggle?: (checked: boolean) => void;
	onTabChange?: (tab: string) => void;
	onUnlinkAccount?: (account: LinkedAccount) => void;
	onUnlinkGoogle?: () => void;
	onUsernameChange?: (username: string) => void;
	/** App-local Better-Auth tabs (injected by the live page). */
	passkeysSlot?: ReactNode;
	publicProfileHref?: string;
	publicProfileSlot?: ReactNode;
	referralsSlot?: ReactNode;
	/** Optional account-security reminder shown below the page header. */
	securityBannerSlot?: ReactNode;
	sessionsSlot?: ReactNode;
	/** Stats tab (web): the live page injects a data-fetching
	 * <ProfileStatsPanel>. Omitted by surfaces that don't ship stats. */
	statsSlot?: ReactNode;
	/** Support-access tab (#545), injected by the live page. */
	supportAccessSlot?: ReactNode;
	/** Server-event email and platform Inbox preferences. */
	transactionalNotificationsSlot?: ReactNode;
	twoFactorEnabled?: boolean;
	twoFactorSlot?: ReactNode;
	username?: string;
}

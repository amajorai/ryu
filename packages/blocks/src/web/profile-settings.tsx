"use client";

import { Badge } from "@ryu/ui/components/badge";
import { Button, buttonVariants } from "@ryu/ui/components/button";
import { Card, CardContent } from "@ryu/ui/components/card";
import {
	ContributionsGraph,
	StatCard,
} from "@ryu/ui/components/contributions-graph";
import { Input } from "@ryu/ui/components/input";
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemSeparator,
	ItemTitle,
} from "@ryu/ui/components/item";
import { Label } from "@ryu/ui/components/label";
import PageHeader from "@ryu/ui/components/page-header";
import {
	ActivityArea,
	FeatureMixBar,
	RankedList,
	TransportDonut,
} from "@ryu/ui/components/profile-charts";
import { Spinner } from "@ryu/ui/components/spinner";
import { Switch } from "@ryu/ui/components/switch";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@ryu/ui/components/tabs";
import {
	formatCurrency,
	formatCount as formatSharedCount,
} from "@ryu/ui/lib/number-format.ts";
import {
	Activity,
	Bot,
	CalendarDays,
	Check,
	Coins,
	Cpu,
	Gauge,
	Github,
	Globe2,
	Lock,
	Network,
	Plug,
	Sparkles,
	Trophy,
	Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import {
	ACCOUNT_LINKING_PROVIDERS,
	type LinkedAccountProvider,
} from "./linked-account-providers.ts";
import { DISCORD_SVGL, SvglIcon } from "./svgl-icon.tsx";

export type { LinkedAccountProvider } from "./linked-account-providers.ts";
export { ACCOUNT_LINKING_PROVIDERS } from "./linked-account-providers.ts";

const noop = () => {
	// presentational default; the live app injects real handlers
};

const GOOGLE_LOGO = (
	<svg aria-hidden="true" className="size-5" viewBox="0 0 24 24">
		<path
			d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
			fill="#4285F4"
		/>
		<path
			d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
			fill="#34A853"
		/>
		<path
			d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
			fill="#FBBC05"
		/>
		<path
			d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
			fill="#EA4335"
		/>
	</svg>
);

export type ProfileTab =
	| "profile"
	| "stats"
	| "account"
	| "referrals"
	| "notifications"
	| "connections"
	| "sessions"
	| "authorized-apps"
	| "support-access";

export interface LinkedAccount {
	accountId: string;
	providerId: string;
}

function LinkedAccountIcon({
	providerId,
}: {
	providerId: LinkedAccountProvider;
}) {
	if (providerId === "google") {
		return GOOGLE_LOGO;
	}
	if (providerId === "github") {
		return <Github aria-hidden="true" className="size-5" />;
	}
	return <SvglIcon size={20} spec={DISCORD_SVGL} />;
}

const SECONDS_PER_HOUR = 3600;

const joinedDateFormatter = new Intl.DateTimeFormat("en-US", {
	month: "long",
	year: "numeric",
});

const formatCompact = (value: number): string =>
	formatSharedCount(value) ?? "—";

const formatCost = (microUsd: number): string => {
	const dollars = microUsd / 1_000_000;
	if (dollars < 0.01 && dollars > 0) {
		return "<$0.01";
	}
	return formatCurrency(dollars, "USD", {
		maximumFractionDigits: dollars >= 10 ? 0 : 2,
	});
};

const formatHourUtc = (hour: string | null | undefined): string =>
	hour ? `${hour}:00 UTC` : "Not enough data";

const formatJoined = (joinedAt?: string): string | null => {
	if (!joinedAt) {
		return null;
	}
	const parsed = new Date(joinedAt);
	if (Number.isNaN(parsed.getTime())) {
		return null;
	}
	return joinedDateFormatter.format(parsed);
};

const tierBadgeVariant = (
	tier: ProfileFeatureUnlock["tier"]
): "default" | "secondary" | "outline" => {
	if (tier === "paid") {
		return "default";
	}
	if (tier === "progressive") {
		return "secondary";
	}
	return "outline";
};

const tierLabel = (tier: ProfileFeatureUnlock["tier"]): string => {
	if (tier === "paid") {
		return "Paid";
	}
	if (tier === "progressive") {
		return "Points";
	}
	return "Included";
};

/** Lifetime summary the Stats header renders (from GET /me/profile). */
export interface ProfileStatsSummary {
	image?: string | null;
	joinedAt?: string;
	level: number;
	name?: string;
	plan?: string;
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
	usage?: Array<{ day: string; count: number }>;
	/** Deep link to the caller's public Ryu Wrapped share page. */
	wrappedHref?: string;
}

function HeroStat({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex flex-col gap-1 rounded-4xl bg-card p-3 text-card-foreground shadow-sm">
			<span className="truncate font-heading font-semibold text-foreground text-lg tabular-nums">
				{value}
			</span>
			<span className="truncate text-muted-foreground text-xs">{label}</span>
		</div>
	);
}

function InsightRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-center justify-between gap-4 text-sm">
			<span className="text-muted-foreground">{label}</span>
			<span className="truncate font-medium text-foreground">{value}</span>
		</div>
	);
}

function UnlockCard({
	feature,
	isUnlocked,
	pointsBalance,
	isUnlocking,
	onUnlock,
}: {
	feature: ProfileFeatureUnlock;
	isUnlocked: boolean;
	pointsBalance: number;
	isUnlocking: boolean;
	onUnlock?: (key: string) => void;
}) {
	const cost = feature.pointsCost ?? 0;
	const canAfford = pointsBalance >= cost;
	const isProgressive = feature.tier === "progressive";

	return (
		<div className="flex flex-col gap-2 rounded-4xl bg-card p-4 text-card-foreground shadow-sm">
			<div className="flex items-start justify-between gap-2">
				<p className="font-medium text-sm">{feature.title}</p>
				<Badge variant={tierBadgeVariant(feature.tier)}>
					{tierLabel(feature.tier)}
				</Badge>
			</div>
			<p className="text-muted-foreground text-xs">{feature.description}</p>
			<div className="mt-auto pt-2">
				{isUnlocked ? (
					<span className="inline-flex items-center gap-1 font-medium text-primary text-xs">
						<Check className="size-3" />
						Unlocked
					</span>
				) : null}

				{!isUnlocked && isProgressive ? (
					<Button
						disabled={!canAfford}
						loading={isUnlocking}
						onClick={() => onUnlock?.(feature.key)}
						size="sm"
						variant={canAfford ? "default" : "outline"}
					>
						{isUnlocking ? (
							"Unlocking…"
						) : (
							<>
								<Coins className="size-3" />
								{canAfford
									? `Unlock · ${formatCompact(cost)} pts`
									: `Need ${formatCompact(cost)} pts`}
							</>
						)}
					</Button>
				) : null}

				{!isUnlocked && feature.tier === "paid" ? (
					<span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
						<Lock className="size-3" />
						{feature.requiresPlan?.length
							? `Included with ${feature.requiresPlan.join(", ")}`
							: "Included with a paid plan"}
					</span>
				) : null}
			</div>
		</div>
	);
}

/**
 * Presentational Stats panel: profile header, contributions heatmap, lifetime
 * stat cards and the points-unlock grid, plus the Ryu Wrapped share CTA. Pure —
 * the live page (apps/web) fetches `/me/*` and passes resolved data + the
 * point-spend callback; the storyboard can render it with static data.
 */
export function ProfileStatsPanel({
	summary = null,
	usage = [],
	featureTotals,
	insights,
	catalog = [],
	unlockedKeys = [],
	pointsBalance,
	unlockingKey = null,
	onUnlockFeature,
	wrappedHref,
	isLoading = false,
	errorMessage = null,
}: ProfileStatsPanelProps) {
	if (errorMessage) {
		return (
			<Card>
				<CardContent className="py-8 text-center text-muted-foreground text-sm">
					{errorMessage}
				</CardContent>
			</Card>
		);
	}

	if (isLoading && !summary) {
		return (
			<Card>
				<CardContent className="flex items-center justify-center py-12">
					<Spinner className="size-5" />
				</CardContent>
			</Card>
		);
	}

	const totals = summary?.totals;
	const totalTokens = (totals?.inputTokens ?? 0) + (totals?.outputTokens ?? 0);
	const agentHours = (totals?.agentSeconds ?? 0) / SECONDS_PER_HOUR;
	const joined = formatJoined(summary?.joinedAt);
	const balance = pointsBalance ?? summary?.pointsBalance ?? 0;
	const unlocked = new Set(unlockedKeys);

	return (
		<div className="space-y-6">
			<section className="flex flex-col items-center gap-3 pt-2 text-center">
				{summary?.image ? (
					<img
						alt={summary?.name ?? "Profile"}
						className="size-20 rounded-full object-cover ring-1 ring-border"
						src={summary.image}
					/>
				) : (
					<div className="flex size-20 items-center justify-center rounded-full bg-muted font-semibold text-2xl">
						{(summary?.name ?? "You").slice(0, 2).toUpperCase()}
					</div>
				)}
				<div>
					<h2 className="font-semibold text-2xl tracking-normal">
						{summary?.name ?? "Your activity"}
					</h2>
					<div className="mt-1 flex flex-wrap items-center justify-center gap-2 text-muted-foreground text-sm">
						<span>{summary?.plan ?? "Free"}</span>
						{joined ? <span>Joined {joined}</span> : null}
						<span>Level {summary?.level ?? 0}</span>
					</div>
				</div>
			</section>

			<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
				<HeroStat label="Lifetime tokens" value={formatCompact(totalTokens)} />
				<HeroStat
					label="Total spend"
					value={formatCost(totals?.costMicroUsd ?? 0)}
				/>
				<HeroStat label="Agent hours" value={agentHours.toFixed(1)} />
				<HeroStat
					label="Active days"
					value={formatCompact(insights?.activeDays ?? 0)}
				/>
				<HeroStat
					label="Current streak"
					value={`${summary?.streak.current ?? 0} days`}
				/>
				<HeroStat
					label="Longest streak"
					value={`${summary?.streak.longest ?? 0} days`}
				/>
			</div>

			<Card>
				<CardContent>
					<ContributionsGraph data={usage} title="Token activity" />
				</CardContent>
			</Card>

			<div className="grid gap-3 lg:grid-cols-3">
				<Card>
					<CardContent>
						<div className="mb-2 flex items-center gap-2 font-medium text-sm">
							<Activity className="size-4" />
							Recent activity
						</div>
						<ActivityArea data={usage} days={30} formatCount={formatCompact} />
					</CardContent>
				</Card>
				<Card>
					<CardContent>
						<div className="mb-2 flex items-center gap-2 font-medium text-sm">
							<Network className="size-4" />
							Where your usage comes from
						</div>
						<TransportDonut
							formatCount={formatCompact}
							transport={
								insights?.transport ?? {
									acp: 0,
									gateway: 0,
									openAiCompat: 0,
									other: 0,
								}
							}
						/>
					</CardContent>
				</Card>
				<Card>
					<CardContent>
						<div className="mb-2 flex items-center gap-2 font-medium text-sm">
							<Cpu className="size-4" />
							Usage by feature
						</div>
						<FeatureMixBar
							featureTotals={
								featureTotals ?? {
									agentSeconds: 0,
									chat: 0,
									island: 0,
									predictAccepted: 0,
								}
							}
						/>
					</CardContent>
				</Card>
			</div>

			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				<StatCard
					icon={<Zap className="size-4" />}
					sub="avg / active day"
					title="Daily tokens"
					value={formatCompact(insights?.averageTokensPerActiveDay ?? 0)}
				/>
				<StatCard
					icon={<Trophy className="size-4" />}
					sub={insights?.peakDay?.day ?? "none yet"}
					title="Peak day"
					value={formatCompact(insights?.peakDay?.tokens ?? 0)}
				/>
				<StatCard
					icon={<Gauge className="size-4" />}
					sub="best effort"
					title="Peak hour"
					value={formatHourUtc(insights?.peakHourUtc)}
				/>
				<StatCard
					icon={<Bot className="size-4" />}
					sub="request count"
					title="Favourite model"
					value={insights?.favoriteModel ?? "Not enough data"}
				/>
				<StatCard
					icon={<Activity className="size-4" />}
					title="Sessions"
					value={formatCompact(totals?.sessionCount ?? 0)}
				/>
				<StatCard
					icon={<Coins className="size-4" />}
					sub="lifetime"
					title="Requests"
					value={formatCompact(totals?.requestCount ?? 0)}
				/>
			</div>

			<div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
				<div className="rounded-4xl bg-card p-4 shadow-sm">
					<div className="mb-3 flex items-center gap-2 font-medium text-sm">
						<CalendarDays className="size-4" />
						Activity insights
					</div>
					<div className="space-y-2">
						<InsightRow
							label="Requests"
							value={formatCompact(totals?.requestCount ?? 0)}
						/>
						<InsightRow
							label="Avg requests / active day"
							value={formatCompact(insights?.averageRequestsPerActiveDay ?? 0)}
						/>
						<InsightRow
							label="Gateway-observed runs"
							value={formatCompact(insights?.transport.gateway ?? 0)}
						/>
						<InsightRow
							label="ACP app-observed runs"
							value={formatCompact(insights?.transport.acp ?? 0)}
						/>
						<InsightRow
							label="Island interactions"
							value={formatCompact(featureTotals?.island ?? 0)}
						/>
					</div>
				</div>
				<RankedList
					empty="No model usage recorded yet."
					formatCount={formatCompact}
					icon={<Bot className="size-4" />}
					items={insights?.topModels ?? []}
					title="Most used models"
				/>
			</div>

			<div className="grid gap-4 lg:grid-cols-2">
				<RankedList
					empty="No skill usage recorded yet."
					formatCount={formatCompact}
					icon={<Sparkles className="size-4" />}
					items={insights?.topSkills ?? []}
					title="Most used skills"
				/>
				<RankedList
					empty="No plugin usage recorded yet."
					formatCount={formatCompact}
					icon={<Plug className="size-4" />}
					items={insights?.topPlugins ?? []}
					title="Most used plugins"
				/>
			</div>

			{catalog.length > 0 ? (
				<section className="space-y-3">
					<div className="flex items-center justify-between">
						<h3 className="font-medium text-sm">Unlocks</h3>
						<span className="text-muted-foreground text-xs">
							{formatCompact(balance)} points available
						</span>
					</div>
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
						{catalog.map((feature) => (
							<UnlockCard
								feature={feature}
								isUnlocked={unlocked.has(feature.key)}
								isUnlocking={unlockingKey === feature.key}
								key={feature.key}
								onUnlock={onUnlockFeature}
								pointsBalance={balance}
							/>
						))}
					</div>
				</section>
			) : null}

			{wrappedHref ? (
				<Card className="border-primary/30 bg-primary/5">
					<CardContent className="flex flex-wrap items-center justify-between gap-4">
						<div className="space-y-1">
							<p className="font-medium">Share your Ryu Wrapped</p>
							<p className="text-muted-foreground text-sm">
								A shareable snapshot of your year with Ryu.
							</p>
						</div>
						<a
							className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-4xl bg-primary px-3 font-medium text-primary-foreground text-sm transition-all hover:bg-primary/80"
							href={wrappedHref}
						>
							<Sparkles className="size-4" />
							View my Wrapped
						</a>
					</CardContent>
				</Card>
			) : null}
		</div>
	);
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
	referralsSlot?: ReactNode;
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

/**
 * The real account-settings page body, presentational. The live page
 * (apps/web/src/app/profile/page.tsx) owns every authClient hook and the
 * data-mutating dialogs; it passes resolved data + callbacks and fills the
 * slot props with its app-local widgets. The storyboard renders it with static
 * data and stub slots, one tab per panel via `activeTab`.
 */
export default function ProfileSettings({
	activeTab = "profile",
	onTabChange = noop,
	name = "",
	onNameChange = noop,
	email = "",
	isSaving = false,
	isSavingProfileVisibility = false,
	isSavingUsername = false,
	onSaveName = noop,
	username = "",
	onUsernameChange = noop,
	onSaveUsername = noop,
	isProfilePublic = true,
	onProfilePublicToggle = noop,
	publicProfileHref,
	avatarSlot,
	authMethod = "password",
	isPasswordStatusLoading = false,
	twoFactorEnabled = false,
	changeEmailSlot,
	emailChangeStatusSlot,
	mergeAccountsSlot,
	mergeStatusSlot,
	changePasswordSlot,
	twoFactorSlot,
	onDeleteAccount = noop,
	referralsSlot,
	isSubscribed = true,
	isLoadingSubscription = false,
	onSubscriptionToggle = noop,
	transactionalNotificationsSlot,
	googleConnected = false,
	connectingProvider = null,
	onConnectGoogle = noop,
	onConnectAccount,
	linkedAccounts,
	onUnlinkAccount,
	onUnlinkGoogle = noop,
	sessionsSlot,
	passkeysSlot,
	statsSlot,
	authorizedAppsSlot,
	supportAccessSlot,
}: ProfileSettingsProps) {
	const connections =
		linkedAccounts ??
		(googleConnected ? [{ accountId: "google", providerId: "google" }] : []);
	const unlinkAccount = (account: LinkedAccount) => {
		if (onUnlinkAccount) {
			onUnlinkAccount(account);
			return;
		}
		onUnlinkGoogle();
	};
	const connectAccount = (providerId: LinkedAccountProvider) => {
		if (onConnectAccount) {
			onConnectAccount(providerId);
			return;
		}
		if (providerId === "google") {
			onConnectGoogle();
		}
	};

	return (
		<div className="container mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-4 py-8">
			<PageHeader
				subtitle="Update your profile and manage your account"
				title="Account Settings"
			/>

			<Tabs onValueChange={onTabChange} value={activeTab}>
				<TabsList variant="pills-lg">
					<TabsTrigger value="profile">Profile</TabsTrigger>
					{statsSlot ? <TabsTrigger value="stats">Stats</TabsTrigger> : null}
					<TabsTrigger value="account">Account</TabsTrigger>
					<TabsTrigger value="referrals">Referrals</TabsTrigger>
					<TabsTrigger value="notifications">Notifications</TabsTrigger>
					<TabsTrigger value="connections">Connections</TabsTrigger>
					<TabsTrigger value="sessions">Sessions &amp; devices</TabsTrigger>
					<TabsTrigger value="authorized-apps">OAuth apps</TabsTrigger>
					<TabsTrigger value="support-access">Support Access</TabsTrigger>
				</TabsList>

				<TabsContent className="mt-6 space-y-6" value="profile">
					<Card>
						<CardContent className="space-y-6">
							<div className="flex flex-col items-center gap-4">
								{avatarSlot}
								<div className="text-center text-muted-foreground text-sm">
									Upload a profile picture. Supports JPEG, PNG, and WebP
									formats. Maximum file size is 10MB.
								</div>
							</div>

							<div className="grid gap-4 md:grid-cols-2">
								<div className="space-y-2">
									<Label htmlFor="profile-name">Full Name</Label>
									<Input
										id="profile-name"
										onChange={(e) => onNameChange(e.target.value)}
										placeholder="Your name"
										value={name}
									/>
								</div>

								<div className="space-y-2">
									<Label htmlFor="profile-email">Email Address</Label>
									<Input
										disabled
										id="profile-email"
										placeholder="Your email"
										value={email}
									/>
								</div>
							</div>

							<div className="flex justify-end">
								<Button loading={isSaving} onClick={onSaveName}>
									{isSaving ? "Saving…" : "Save Profile"}
								</Button>
							</div>

							<ItemSeparator />

							<div className="grid gap-4 md:grid-cols-[1fr_auto]">
								<div className="space-y-2">
									<Label htmlFor="profile-username">Username</Label>
									<Input
										id="profile-username"
										onChange={(e) => onUsernameChange(e.target.value)}
										placeholder="your_handle"
										value={username}
									/>
									<p className="text-muted-foreground text-xs">
										Claim a public handle for your Ryu profile.
									</p>
								</div>
								<div className="flex items-end">
									<Button
										loading={isSavingUsername}
										onClick={onSaveUsername}
										variant="outline"
									>
										{isSavingUsername ? "Claiming…" : "Claim Username"}
									</Button>
								</div>
							</div>
						</CardContent>
					</Card>
					<Card>
						<CardContent>
							<div className="flex items-start justify-between gap-4">
								<div className="flex gap-3">
									<div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted">
										{isProfilePublic ? (
											<Globe2 className="size-4" />
										) : (
											<Lock className="size-4" />
										)}
									</div>
									<div className="space-y-1">
										<p className="font-medium">Public profile</p>
										<p className="text-muted-foreground text-sm">
											Show your public stats page. New profiles are public by
											default.
										</p>
										{publicProfileHref && isProfilePublic ? (
											<a
												className="inline-flex text-primary text-sm hover:underline"
												href={publicProfileHref}
											>
												View public profile
											</a>
										) : null}
									</div>
								</div>
								<Switch
									checked={isProfilePublic}
									disabled={isSavingProfileVisibility}
									onCheckedChange={onProfilePublicToggle}
								/>
							</div>
						</CardContent>
					</Card>
					<Card>
						<CardContent className="space-y-3">
							<div className="space-y-1">
								<p className="font-medium">Train on my data</p>
								<p className="text-muted-foreground text-sm leading-relaxed">
									We never use your chats, files, or activity to train Ryu
									models. Core and Gateway are open source, so you can inspect
									them. A model provider, app, or plugin only processes content
									when you choose to use it, under that service&apos;s own terms
									and privacy policy.
								</p>
							</div>
							<div className="flex flex-wrap items-center gap-3">
								<a
									className={buttonVariants({ size: "sm", variant: "outline" })}
									href="https://github.com/amajorai/ryu"
									rel="noopener noreferrer"
									target="_blank"
								>
									<Github className="size-4" />
									GitHub
								</a>
								<div className="flex gap-3 text-muted-foreground text-xs">
									<a
										className="hover:text-foreground hover:underline"
										href="/privacy"
									>
										Privacy
									</a>
									<a
										className="hover:text-foreground hover:underline"
										href="/terms"
									>
										Terms
									</a>
								</div>
							</div>
						</CardContent>
					</Card>
				</TabsContent>

				<TabsContent className="mt-6 space-y-6" value="stats">
					{statsSlot}
				</TabsContent>

				<TabsContent className="mt-6 space-y-6" value="account">
					<Card className="p-0">
						<CardContent className="p-0 py-2">
							<ItemGroup className="gap-0">
								<Item>
									<ItemContent>
										<ItemTitle>Email Address</ItemTitle>
										<ItemDescription>{email}</ItemDescription>
									</ItemContent>
									<ItemActions>
										{changeEmailSlot ?? <Button>Change Email</Button>}
									</ItemActions>
								</Item>

								{emailChangeStatusSlot}

								{mergeAccountsSlot ? (
									<>
										<ItemSeparator />
										<Item>
											<ItemContent>
												<ItemTitle>Merge another account</ItemTitle>
												<ItemDescription>
													Signed up twice? Fold the other account&apos;s
													workspaces, credit and history into this one. Both
													inboxes have to confirm, and it can&apos;t be undone.
												</ItemDescription>
											</ItemContent>
											<ItemActions>{mergeAccountsSlot}</ItemActions>
										</Item>
										{mergeStatusSlot}
									</>
								) : null}

								<ItemSeparator />

								<Item>
									<ItemContent>
										<ItemTitle>Password</ItemTitle>
										<ItemDescription>
											{authMethod === "password"
												? "Update your account password"
												: "Set a password to enable password-based login"}
										</ItemDescription>
									</ItemContent>
									<ItemActions>
										{changePasswordSlot ?? (
											<Button disabled={isPasswordStatusLoading}>
												{isPasswordStatusLoading
													? "Loading…"
													: authMethod === "password"
														? "Change Password"
														: "Set Password"}
											</Button>
										)}
									</ItemActions>
								</Item>

								{passkeysSlot ? (
									<>
										<ItemSeparator />
										<Item>
											<ItemContent>
												<ItemTitle>Passkeys</ItemTitle>
												<ItemDescription>
													Sign in with your device or a security key instead of
													a password.
												</ItemDescription>
											</ItemContent>
											<ItemActions>{passkeysSlot}</ItemActions>
										</Item>
									</>
								) : null}

								<ItemSeparator />

								<Item>
									<ItemContent>
										<ItemTitle>Two-Factor Authentication</ItemTitle>
										<ItemDescription>
											{twoFactorEnabled
												? "Two-factor authentication is enabled"
												: "Add an extra layer of security to your account"}
										</ItemDescription>
									</ItemContent>
									<ItemActions>
										{twoFactorSlot ?? (
											<Button>
												{twoFactorEnabled ? "Manage 2FA" : "Enable 2FA"}
											</Button>
										)}
									</ItemActions>
								</Item>

								<ItemSeparator />

								<Item>
									<ItemContent>
										<ItemTitle className="text-destructive">
											Delete Account
										</ItemTitle>
										<ItemDescription>
											Permanently delete your account and all data
										</ItemDescription>
									</ItemContent>
									<ItemActions>
										<Button onClick={onDeleteAccount} variant="destructive">
											Delete Account
										</Button>
									</ItemActions>
								</Item>
							</ItemGroup>
						</CardContent>
					</Card>
				</TabsContent>

				<TabsContent className="mt-6 space-y-6" value="referrals">
					{referralsSlot}
				</TabsContent>

				<TabsContent className="mt-6 space-y-6" value="notifications">
					<Card>
						<CardContent className="space-y-6">
							<div className="flex items-center justify-between">
								<div className="space-y-0.5">
									<p className="font-medium">Marketing Emails</p>
									<p className="text-muted-foreground text-sm">
										Receive updates about product releases, new features, and
										company news
									</p>
								</div>
								<Switch
									checked={isSubscribed}
									disabled={isLoadingSubscription}
									onCheckedChange={onSubscriptionToggle}
								/>
							</div>
						</CardContent>
					</Card>
					{transactionalNotificationsSlot}
				</TabsContent>

				<TabsContent className="mt-6 space-y-6" value="connections">
					<Card>
						<CardContent className="space-y-4">
							<div>
								<p className="font-medium">Connected accounts</p>
								<p className="text-muted-foreground text-sm">
									Link individual social identities to this Ryu account. These
									are separate from organization and agent connections.
								</p>
							</div>
							<div className="divide-y overflow-hidden rounded-lg border">
								{ACCOUNT_LINKING_PROVIDERS.map((provider) => {
									const account = connections.find(
										(candidate) => candidate.providerId === provider.id
									);
									const isConnecting = connectingProvider === provider.id;
									return (
										<div
											className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
											data-testid={`linked-account-${provider.id}`}
											key={provider.id}
										>
											<div className="flex min-w-0 items-center gap-3">
												<div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
													<LinkedAccountIcon providerId={provider.id} />
												</div>
												<div className="min-w-0">
													<p className="truncate font-medium text-sm">
														{provider.label}
													</p>
													<p className="truncate text-muted-foreground text-xs">
														{account ? "Connected" : provider.description}
													</p>
												</div>
											</div>
											{account ? (
												<Button
													disabled={connectingProvider !== null}
													onClick={() => unlinkAccount(account)}
													size="sm"
													variant="outline"
												>
													Unlink
												</Button>
											) : (
												<Button
													disabled={connectingProvider !== null}
													loading={isConnecting}
													onClick={() => connectAccount(provider.id)}
													size="sm"
													variant="outline"
												>
													{isConnecting ? "Opening…" : "Connect"}
												</Button>
											)}
										</div>
									);
								})}
							</div>
							<p className="rounded-md bg-muted/50 px-3 py-2 text-muted-foreground text-xs">
								The login page keeps Google as its only social option. Telegram
								Login is organization/channel-level, so it does not belong in
								this user-account list.
							</p>
						</CardContent>
					</Card>
				</TabsContent>

				<TabsContent className="mt-6 space-y-6" value="sessions">
					{sessionsSlot}
				</TabsContent>

				<TabsContent className="mt-6 space-y-6" value="authorized-apps">
					{authorizedAppsSlot}
				</TabsContent>

				<TabsContent className="mt-6 space-y-6" value="support-access">
					{supportAccessSlot}
				</TabsContent>
			</Tabs>
		</div>
	);
}

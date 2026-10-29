"use client";

import { Badge } from "@ryu/ui/components/badge";
import { Button, buttonVariants } from "@ryu/ui/components/button";
import {
	ContributionsGraph,
	StatCard,
	withActiveDays,
} from "@ryu/ui/components/contributions-graph";
import { Input } from "@ryu/ui/components/input";
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
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import {
	formatCurrency,
	formatCount as formatSharedCount,
} from "@ryu/ui/lib/number-format.ts";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { USAGE_STREAK_HINT } from "@ryu/ui/lib/usage-streak.ts";
import { cn } from "@ryu/ui/lib/utils";
import {
	Activity,
	Bot,
	Check,
	Coins,
	Cpu,
	Gauge,
	Github,
	Info,
	Lock,
	Network,
	Plug,
	Sparkles,
	Trophy,
	Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "../desktop/settings-items.tsx";
import {
	ACCOUNT_LINKING_PROVIDERS,
	type LinkedAccountProvider,
} from "./linked-account-providers.ts";
import styles from "./profile-settings.module.css";
import { DISCORD_SVGL, SvglIcon } from "./svgl-icon.tsx";

export type { LinkedAccountProvider } from "./linked-account-providers.ts";
export { ACCOUNT_LINKING_PROVIDERS } from "./linked-account-providers.ts";

const noop = () => {
	// presentational default; the live app injects real handlers
};

const GOOGLE_LOGO = (
	<svg aria-hidden="true" className="size-5" viewBox="0 0 24 24">
		<path
			className={styles.googleBlue}
			d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
		/>
		<path
			className={styles.googleGreen}
			d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
		/>
		<path
			className={styles.googleYellow}
			d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
		/>
		<path
			className={styles.googleRed}
			d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
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
	| "support-access"
	| "emails";

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

/** Muted secondary line under a settings row title, kept inside the row's card. */
function RowHint({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<p className={cn("text-muted-foreground text-xs leading-snug", className)}>
			{children}
		</p>
	);
}

// Stat tiles and ranked lists share the settings card surface (muted fill, no
// border or shadow) instead of the elevated profile-card look.
const STAT_TILE_CLASS = "rounded-lg bg-muted/40 shadow-none";
const RANKED_LIST_SURFACE_CLASS =
	"[&>div]:rounded-lg [&>div]:border-0 [&>div]:bg-muted/40";

function HeroStat({
	hint,
	label,
	value,
}: {
	/** Optional explanation of the number, shown as a tooltip on an info
	 *  trigger and read by screen readers as part of the stat. */
	hint?: string;
	label: string;
	value: string;
}) {
	return (
		<SettingsCard className="flex flex-col gap-1">
			<span className="truncate font-heading font-medium text-foreground text-lg tabular-nums">
				{value}
			</span>
			<span className="flex min-w-0 items-center gap-1 text-muted-foreground text-xs">
				<span className="truncate" title={label}>
					{label}
				</span>
				{hint ? (
					// The web app has no root tooltip provider, so each hint
					// brings its own (as `StatusBadge` does).
					<TooltipProvider delay={0}>
						<Tooltip>
							<TooltipTrigger
								render={
									<button
										aria-label={`About ${label.toLowerCase()}: ${hint}`}
										className="shrink-0 rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
										type="button"
									/>
								}
							>
								<Info aria-hidden="true" className="size-3" />
							</TooltipTrigger>
							<TooltipContent>{hint}</TooltipContent>
						</Tooltip>
					</TooltipProvider>
				) : null}
			</span>
		</SettingsCard>
	);
}

function ChartCard({
	children,
	icon,
	title,
}: {
	children: ReactNode;
	icon: ReactNode;
	title: string;
}) {
	return (
		<SettingsCard>
			<div className="mb-2 flex items-center gap-2 font-medium text-sm">
				{icon}
				{title}
			</div>
			{children}
		</SettingsCard>
	);
}

function UnlockAction({
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

	if (isUnlocked) {
		return (
			<span className="inline-flex items-center gap-1 font-medium text-primary text-xs">
				<Check className="size-3" />
				Unlocked
			</span>
		);
	}

	if (feature.tier === "progressive") {
		return (
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
		);
	}

	if (feature.tier === "paid") {
		return (
			<span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
				<Lock className="size-3" />
				{feature.requiresPlan?.length
					? `Included with ${feature.requiresPlan.join(", ")}`
					: "Included with a paid plan"}
			</span>
		);
	}

	return null;
}

/**
 * Presentational Stats panel: profile header, contributions heatmap, lifetime
 * stat tiles and the points-unlock list, plus the Ryu Wrapped share row. Pure —
 * the live page (apps/web) fetches `/me/*` and passes resolved data + the
 * point-spend callback; the storyboard can render it with static data.
 */
export function ProfileStatsPanel({
	activeDays,
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
			<SettingsCard>
				<p className="py-4 text-center text-sm text-status-destructive">
					{errorMessage}
				</p>
			</SettingsCard>
		);
	}

	if (isLoading && !summary) {
		return (
			<SettingsCard className="flex items-center justify-center py-10">
				<Spinner className="size-5" />
			</SettingsCard>
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
			<SettingsCard className="flex items-center gap-4">
				{safeMediaUrl(summary?.image) ? (
					<img
						alt={summary?.name ?? "Profile"}
						className="size-14 shrink-0 rounded-full object-cover ring-1 ring-border"
						src={safeMediaUrl(summary?.image) ?? undefined}
					/>
				) : (
					<div className="flex size-14 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-lg">
						{(summary?.name ?? "You").slice(0, 2).toUpperCase()}
					</div>
				)}
				<div className="min-w-0">
					<h2 className="truncate font-medium text-base">
						{summary?.name ?? "Your activity"}
					</h2>
					<div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground text-xs">
						<span>{summary?.plan ?? "Free"}</span>
						{joined ? <span>Joined {joined}</span> : null}
						<span>Level {summary?.level ?? 0}</span>
					</div>
				</div>
			</SettingsCard>

			<SettingsSection title="Lifetime">
				<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
					<HeroStat
						label="Lifetime tokens"
						value={formatCompact(totalTokens)}
					/>
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
						hint={USAGE_STREAK_HINT}
						label="Current streak"
						value={`${summary?.streak.current ?? 0} days`}
					/>
					<HeroStat
						hint={USAGE_STREAK_HINT}
						label="Longest streak"
						value={`${summary?.streak.longest ?? 0} days`}
					/>
				</div>
			</SettingsSection>

			<SettingsCard>
				{/* Each cell is that day's request count, not tokens; a
				    streak-active day with no requests shows at the lowest level. */}
				<ContributionsGraph
					data={withActiveDays(usage, activeDays)}
					title="Daily activity"
				/>
			</SettingsCard>

			<div className="grid gap-3 lg:grid-cols-3">
				<ChartCard
					icon={<Activity className="size-4" />}
					title="Recent activity"
				>
					<ActivityArea data={usage} days={30} formatCount={formatCompact} />
				</ChartCard>
				<ChartCard
					icon={<Network className="size-4" />}
					title="Where your usage comes from"
				>
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
				</ChartCard>
				<ChartCard icon={<Cpu className="size-4" />} title="Usage by feature">
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
				</ChartCard>
			</div>

			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				<StatCard
					className={STAT_TILE_CLASS}
					icon={<Zap className="size-4" />}
					sub="avg / active day"
					title="Daily tokens"
					value={formatCompact(insights?.averageTokensPerActiveDay ?? 0)}
				/>
				<StatCard
					className={STAT_TILE_CLASS}
					icon={<Trophy className="size-4" />}
					sub={insights?.peakDay?.day ?? "none yet"}
					title="Peak day"
					value={formatCompact(insights?.peakDay?.tokens ?? 0)}
				/>
				<StatCard
					className={STAT_TILE_CLASS}
					icon={<Gauge className="size-4" />}
					sub="best effort"
					title="Peak hour"
					value={formatHourUtc(insights?.peakHourUtc)}
				/>
				<StatCard
					className={STAT_TILE_CLASS}
					icon={<Bot className="size-4" />}
					sub="request count"
					title="Favourite model"
					value={insights?.favoriteModel ?? "Not enough data"}
				/>
				<StatCard
					className={STAT_TILE_CLASS}
					icon={<Activity className="size-4" />}
					title="Sessions"
					value={formatCompact(totals?.sessionCount ?? 0)}
				/>
				<StatCard
					className={STAT_TILE_CLASS}
					icon={<Coins className="size-4" />}
					sub="lifetime"
					title="Requests"
					value={formatCompact(totals?.requestCount ?? 0)}
				/>
			</div>

			<div className="grid gap-4 lg:grid-cols-2">
				<SettingsSection title="Activity insights">
					<SettingsGroup>
						<SettingsItem
							actions={
								<span className="font-medium text-sm tabular-nums">
									{formatCompact(totals?.requestCount ?? 0)}
								</span>
							}
							title="Requests"
						/>
						<SettingsItem
							actions={
								<span className="font-medium text-sm tabular-nums">
									{formatCompact(insights?.averageRequestsPerActiveDay ?? 0)}
								</span>
							}
							title="Avg requests / usage day"
						/>
						<SettingsItem
							actions={
								<span className="font-medium text-sm tabular-nums">
									{formatCompact(insights?.transport.gateway ?? 0)}
								</span>
							}
							title="Gateway-observed runs"
						/>
						<SettingsItem
							actions={
								<span className="font-medium text-sm tabular-nums">
									{formatCompact(insights?.transport.acp ?? 0)}
								</span>
							}
							title="ACP app-observed runs"
						/>
						<SettingsItem
							actions={
								<span className="font-medium text-sm tabular-nums">
									{formatCompact(featureTotals?.island ?? 0)}
								</span>
							}
							title="Island interactions"
						/>
					</SettingsGroup>
				</SettingsSection>
				<div className={RANKED_LIST_SURFACE_CLASS}>
					<RankedList
						empty="No model usage recorded yet."
						formatCount={formatCompact}
						icon={<Bot className="size-4" />}
						items={insights?.topModels ?? []}
						title="Most used models"
					/>
				</div>
			</div>

			<div className={`grid gap-4 lg:grid-cols-2 ${RANKED_LIST_SURFACE_CLASS}`}>
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
				<SettingsSection
					headerAction={
						<span className="text-muted-foreground text-xs">
							{formatCompact(balance)} points available
						</span>
					}
					title="Unlocks"
				>
					<SettingsGroup>
						{catalog.map((feature) => (
							<SettingsItem
								actions={
									<div className="flex items-center gap-2">
										<UnlockAction
											feature={feature}
											isUnlocked={unlocked.has(feature.key)}
											isUnlocking={unlockingKey === feature.key}
											onUnlock={onUnlockFeature}
											pointsBalance={balance}
										/>
										<Badge variant={tierBadgeVariant(feature.tier)}>
											{tierLabel(feature.tier)}
										</Badge>
									</div>
								}
								key={feature.key}
								title={feature.title}
							>
								<RowHint>{feature.description}</RowHint>
							</SettingsItem>
						))}
					</SettingsGroup>
				</SettingsSection>
			) : null}

			{wrappedHref ? (
				<SettingsGroup>
					<SettingsItem
						actions={
							<a className={buttonVariants({ size: "sm" })} href={wrappedHref}>
								<Sparkles className="size-4" />
								View my Wrapped
							</a>
						}
						description="A shareable snapshot of your year with Ryu."
						title="Share your Ryu Wrapped"
					/>
				</SettingsGroup>
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

// Inline text fields in a settings row: compact height, a fixed width that
// leaves the row title room on a phone-width column.
const ROW_INPUT_CLASS = "h-8 w-36 sm:w-56";

interface ProfileTabPanelProps {
	avatarSlot?: ReactNode;
	email: string;
	isProfilePublic: boolean;
	isSaving: boolean;
	isSavingProfileVisibility: boolean;
	isSavingUsername: boolean;
	name: string;
	onNameChange: (name: string) => void;
	onProfilePublicToggle: (checked: boolean) => void;
	onSaveName: () => void;
	onSaveUsername: () => void;
	onUsernameChange: (username: string) => void;
	publicProfileHref?: string;
	publicProfileSlot?: ReactNode;
	username: string;
}

function ProfileTabPanel({
	avatarSlot,
	email,
	isProfilePublic,
	isSaving,
	isSavingProfileVisibility,
	isSavingUsername,
	name,
	onNameChange,
	onProfilePublicToggle,
	onSaveName,
	onSaveUsername,
	onUsernameChange,
	publicProfileHref,
	publicProfileSlot,
	username,
}: ProfileTabPanelProps) {
	return (
		<>
			{avatarSlot ? (
				<SettingsSection
					caption="Upload a profile picture. Supports JPEG, PNG, and WebP formats. Maximum file size is 10MB."
					title="Profile photo"
				>
					<SettingsCard className="flex justify-center py-5">
						{avatarSlot}
					</SettingsCard>
				</SettingsSection>
			) : null}

			<SettingsSection title="Personal info">
				<SettingsGroup>
					<SettingsItem
						actions={
							<div className="flex items-center gap-2">
								<Input
									aria-label="Full name"
									className={ROW_INPUT_CLASS}
									id="profile-name"
									onChange={(e) => onNameChange(e.target.value)}
									placeholder="Your name"
									value={name}
								/>
								<Button loading={isSaving} onClick={onSaveName} size="sm">
									{isSaving ? "Saving…" : "Save profile"}
								</Button>
							</div>
						}
						title="Full name"
					/>
					<SettingsItem
						actions={
							<div>
								<Input
									aria-label="Email address"
									className={ROW_INPUT_CLASS}
									disabled
									id="profile-email"
									placeholder="Your email"
									value={email}
								/>
							</div>
						}
						title="Email address"
					/>
					<SettingsItem
						actions={
							<div className="flex items-center gap-2">
								<Input
									aria-label="Username"
									className={ROW_INPUT_CLASS}
									id="profile-username"
									onChange={(e) => onUsernameChange(e.target.value)}
									placeholder="your_handle"
									value={username}
								/>
								<Button
									loading={isSavingUsername}
									onClick={onSaveUsername}
									size="sm"
									variant="outline"
								>
									{isSavingUsername ? "Claiming…" : "Claim username"}
								</Button>
							</div>
						}
						description="Claim a public handle for your Ryu profile."
						title="Username"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection title="Sharing">
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								aria-label="Public profile"
								checked={isProfilePublic}
								disabled={isSavingProfileVisibility}
								onCheckedChange={onProfilePublicToggle}
							/>
						}
						description="Show your public stats page. New profiles are public by default."
						title="Public profile"
					>
						{publicProfileHref && isProfilePublic ? (
							<a
								className="inline-flex text-primary text-xs hover:underline"
								href={publicProfileHref}
							>
								View public profile
							</a>
						) : null}
					</SettingsItem>
				</SettingsGroup>
			</SettingsSection>

			{publicProfileSlot}

			<SettingsSection title="Your data">
				<SettingsGroup>
					<SettingsItem
						actions={<span className="text-muted-foreground text-sm">Off</span>}
						description="We never use your chats, files, or activity to train Ryu models. Core and Gateway are open source, so you can inspect them. A model provider, app, or plugin only processes content when you choose to use it, under that service's own terms and privacy policy."
						title="Train on my data"
					>
						<div className="flex flex-wrap items-center gap-3 pt-1">
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
					</SettingsItem>
				</SettingsGroup>
			</SettingsSection>
		</>
	);
}

interface AccountTabPanelProps {
	authMethod: string | null;
	changeEmailSlot?: ReactNode;
	changePasswordSlot?: ReactNode;
	email: string;
	emailChangeStatusSlot?: ReactNode;
	isPasswordStatusLoading: boolean;
	mergeAccountsSlot?: ReactNode;
	mergeStatusSlot?: ReactNode;
	onDeleteAccount?: () => void;
	passkeysSlot?: ReactNode;
	twoFactorEnabled: boolean;
	twoFactorSlot?: ReactNode;
}

function passwordButtonLabel(
	isPasswordStatusLoading: boolean,
	authMethod: string | null
): string {
	if (isPasswordStatusLoading) {
		return "Loading…";
	}
	return authMethod === "password" ? "Change password" : "Set password";
}

function AccountTabPanel({
	authMethod,
	changeEmailSlot,
	changePasswordSlot,
	email,
	emailChangeStatusSlot,
	isPasswordStatusLoading,
	mergeAccountsSlot,
	mergeStatusSlot,
	onDeleteAccount,
	passkeysSlot,
	twoFactorEnabled,
	twoFactorSlot,
}: AccountTabPanelProps) {
	return (
		<>
			<SettingsSection title="Email">
				<SettingsGroup>
					<SettingsItem
						actions={
							changeEmailSlot ?? (
								<Button size="sm" variant="outline">
									Change email
								</Button>
							)
						}
						title="Email address"
					>
						<RowHint className="truncate">{email}</RowHint>
					</SettingsItem>
				</SettingsGroup>
				{emailChangeStatusSlot}
			</SettingsSection>

			<SettingsSection title="Sign-in">
				<SettingsGroup>
					<SettingsItem
						actions={
							changePasswordSlot ?? (
								<Button
									disabled={isPasswordStatusLoading}
									size="sm"
									variant="outline"
								>
									{passwordButtonLabel(isPasswordStatusLoading, authMethod)}
								</Button>
							)
						}
						title="Password"
					>
						<RowHint>
							{authMethod === "password"
								? "Update your account password"
								: "Set a password to enable password-based login"}
						</RowHint>
					</SettingsItem>
					{passkeysSlot ? (
						<SettingsItem actions={passkeysSlot} title="Passkeys">
							<RowHint>
								Sign in with your device or a security key instead of a
								password.
							</RowHint>
						</SettingsItem>
					) : null}
					<SettingsItem
						actions={
							twoFactorSlot ?? (
								<Button size="sm" variant="outline">
									{twoFactorEnabled ? "Manage 2FA" : "Enable 2FA"}
								</Button>
							)
						}
						title="Two-factor authentication"
					>
						<RowHint>
							{twoFactorEnabled
								? "Two-factor authentication is enabled"
								: "Add an extra layer of security to your account"}
						</RowHint>
					</SettingsItem>
				</SettingsGroup>
			</SettingsSection>

			{mergeAccountsSlot ? (
				<SettingsSection>
					<SettingsGroup>
						<SettingsItem
							actions={mergeAccountsSlot}
							description="Signed up twice? Fold the other account's workspaces, credit and history into this one. Both inboxes have to confirm, and it can't be undone."
							title="Merge another account"
						/>
					</SettingsGroup>
					{mergeStatusSlot}
				</SettingsSection>
			) : null}

			{onDeleteAccount ? (
				<SettingsSection>
					<SettingsGroup>
						<SettingsItem
							actions={
								<Button
									onClick={onDeleteAccount}
									size="sm"
									variant="destructive"
								>
									Delete account
								</Button>
							}
							description="Permanently delete your account and all data"
							title={
								<span className="text-status-destructive">Delete account</span>
							}
						/>
					</SettingsGroup>
				</SettingsSection>
			) : null}
		</>
	);
}

function ConnectionsTabPanel({
	connectAccount,
	connectingProvider,
	connections,
	unlinkAccount,
}: {
	connectAccount: (providerId: LinkedAccountProvider) => void;
	connectingProvider: LinkedAccountProvider | null;
	connections: LinkedAccount[];
	unlinkAccount: (account: LinkedAccount) => void;
}) {
	return (
		<SettingsSection
			caption="Link individual social identities to this Ryu account. These are separate from organization and agent connections. The login page keeps Google as its only social option. Telegram Login is organization/channel-level, so it does not belong in this user-account list."
			title="Connected accounts"
		>
			<SettingsGroup>
				{ACCOUNT_LINKING_PROVIDERS.map((provider) => {
					const account = connections.find(
						(candidate) => candidate.providerId === provider.id
					);
					const isConnecting = connectingProvider === provider.id;
					return (
						<div
							data-testid={`linked-account-${provider.id}`}
							key={provider.id}
						>
							<SettingsItem
								actions={
									account ? (
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
									)
								}
								title={
									<>
										<span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-background">
											<LinkedAccountIcon providerId={provider.id} />
										</span>
										{provider.label}
									</>
								}
							>
								<RowHint className="truncate pl-9">
									{account ? "Connected" : provider.description}
								</RowHint>
							</SettingsItem>
						</div>
					);
				})}
			</SettingsGroup>
		</SettingsSection>
	);
}

/**
 * The real account-settings page body, presentational. The live page
 * (apps/web/src/app/settings/page.tsx) owns every authClient hook and the
 * data-mutating dialogs; it passes resolved data + callbacks and fills the
 * slot props with its app-local widgets. The storyboard renders it with static
 * data and stub slots, one tab per panel via `activeTab`.
 *
 * Every tab body is built from the shared settings primitives
 * (`SettingsSection` / `SettingsGroup` / `SettingsItem` / `SettingsCard`), so
 * the web settings page reads like the desktop app's Settings panes in both
 * navigation modes.
 */
export default function ProfileSettings({
	activeTab = "profile",
	navigation = "tabs",
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
	publicProfileSlot,
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
	onDeleteAccount,
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
	emailsSlot,
	securityBannerSlot,
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

	// The pills sit above the tab bodies; a host's own heading does not.
	const tabContentClass = navigation === "tabs" ? "mt-6" : undefined;

	return (
		<div
			className={
				navigation === "tabs"
					? "container mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-4 py-8"
					: "flex flex-col gap-6"
			}
		>
			{navigation === "tabs" ? (
				<PageHeader
					subtitle="Update your profile and manage your account"
					title="Account settings"
				/>
			) : null}
			{securityBannerSlot}

			<Tabs onValueChange={onTabChange} value={activeTab}>
				{navigation === "tabs" ? (
					<TabsList sticky variant="pills-lg">
						<TabsTrigger value="profile">Profile</TabsTrigger>
						{statsSlot ? <TabsTrigger value="stats">Stats</TabsTrigger> : null}
						<TabsTrigger value="account">Account</TabsTrigger>
						<TabsTrigger value="referrals">Referrals</TabsTrigger>
						<TabsTrigger value="notifications">Notifications</TabsTrigger>
						<TabsTrigger value="connections">Connections</TabsTrigger>
						<TabsTrigger value="sessions">Sessions &amp; devices</TabsTrigger>
						<TabsTrigger value="authorized-apps">OAuth apps</TabsTrigger>
						<TabsTrigger value="support-access">Support access</TabsTrigger>
						{emailsSlot ? (
							<TabsTrigger value="emails">Emails</TabsTrigger>
						) : null}
					</TabsList>
				) : null}

				<TabsContent
					className={tabContentClass}
					spacing="comfortable"
					value="profile"
				>
					<ProfileTabPanel
						avatarSlot={avatarSlot}
						email={email}
						isProfilePublic={isProfilePublic}
						isSaving={isSaving}
						isSavingProfileVisibility={isSavingProfileVisibility}
						isSavingUsername={isSavingUsername}
						name={name}
						onNameChange={onNameChange}
						onProfilePublicToggle={onProfilePublicToggle}
						onSaveName={onSaveName}
						onSaveUsername={onSaveUsername}
						onUsernameChange={onUsernameChange}
						publicProfileHref={publicProfileHref}
						publicProfileSlot={publicProfileSlot}
						username={username}
					/>
				</TabsContent>

				<TabsContent
					className={tabContentClass}
					spacing="comfortable"
					value="stats"
				>
					{statsSlot}
				</TabsContent>

				<TabsContent
					className={tabContentClass}
					spacing="comfortable"
					value="account"
				>
					<AccountTabPanel
						authMethod={authMethod}
						changeEmailSlot={changeEmailSlot}
						changePasswordSlot={changePasswordSlot}
						email={email}
						emailChangeStatusSlot={emailChangeStatusSlot}
						isPasswordStatusLoading={isPasswordStatusLoading}
						mergeAccountsSlot={mergeAccountsSlot}
						mergeStatusSlot={mergeStatusSlot}
						onDeleteAccount={onDeleteAccount}
						passkeysSlot={passkeysSlot}
						twoFactorEnabled={twoFactorEnabled}
						twoFactorSlot={twoFactorSlot}
					/>
				</TabsContent>

				<TabsContent
					className={tabContentClass}
					spacing="comfortable"
					value="referrals"
				>
					{referralsSlot}
				</TabsContent>

				<TabsContent
					className={tabContentClass}
					spacing="comfortable"
					value="notifications"
				>
					<SettingsSection title="Product updates">
						<SettingsGroup>
							<SettingsItem
								actions={
									<Switch
										aria-label="Marketing Emails"
										checked={isSubscribed}
										disabled={isLoadingSubscription}
										onCheckedChange={onSubscriptionToggle}
									/>
								}
								description="Receive updates about product releases, new features, and company news"
								title="Marketing Emails"
							/>
						</SettingsGroup>
					</SettingsSection>
					{transactionalNotificationsSlot}
				</TabsContent>

				<TabsContent
					className={tabContentClass}
					spacing="comfortable"
					value="connections"
				>
					<ConnectionsTabPanel
						connectAccount={connectAccount}
						connectingProvider={connectingProvider}
						connections={connections}
						unlinkAccount={unlinkAccount}
					/>
				</TabsContent>

				<TabsContent
					className={tabContentClass}
					spacing="comfortable"
					value="sessions"
				>
					{sessionsSlot}
				</TabsContent>

				<TabsContent
					className={tabContentClass}
					spacing="comfortable"
					value="authorized-apps"
				>
					{authorizedAppsSlot}
				</TabsContent>

				<TabsContent
					className={tabContentClass}
					spacing="comfortable"
					value="support-access"
				>
					{supportAccessSlot}
				</TabsContent>

				{emailsSlot ? (
					<TabsContent
						className={tabContentClass}
						spacing="comfortable"
						value="emails"
					>
						{emailsSlot}
					</TabsContent>
				) : null}
			</Tabs>
		</div>
	);
}

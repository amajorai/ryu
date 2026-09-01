// The "Stats" settings tab — a personal dashboard for the signed-in account.
// Reads the profile/stats control plane (apps/desktop/src/lib/api/profile.ts):
// a header (avatar/name + level/streak), a GitHub-style contributions heatmap
// fed by daily usage, a grid of lifetime stat cards, and the unlockable-feature
// catalog. The "Share your Ryu Wrapped" button opens the public web share card
// (FRONTEND_URL/wrapped/:userId) in the user's browser.

import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Avatar, AvatarFallback, AvatarImage } from "@ryu/ui/components/avatar";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	ContributionsGraph,
	StatCard,
} from "@ryu/ui/components/contributions-graph";
import { EmployeeBadge } from "@ryu/ui/components/employee-badge";
import {
	ActivityArea,
	FeatureMixBar,
	RankedList,
	TransportDonut,
} from "@ryu/ui/components/profile-charts";
import { Spinner } from "@ryu/ui/components/spinner";
import {
	formatCurrency,
	formatNumber as formatSharedNumber,
} from "@ryu/ui/lib/number-format.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format, subDays } from "date-fns";
import {
	Activity,
	Bot,
	CalendarDays,
	Cpu,
	CreditCard,
	Gauge,
	Plug,
	Sparkles,
	Trophy,
	Zap,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useMemo, useState } from "react";
import { sileo } from "sileo";
import { useSession } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import {
	type AgentProfile as AgentProfileStats,
	fetchProfileMe,
	fetchProfileStats,
	fetchProfileUnlocks,
	fetchTeamAgents,
	fetchUsageDaily,
	type UnlockCatalogEntry,
	unlockFeature,
	wrappedUrl,
} from "@/src/lib/api/profile.ts";
import { AgentProfile } from "./AgentProfile.tsx";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

const SECONDS_PER_HOUR = 3600;
const HEATMAP_DAYS = 364;
const DATE_FORMAT = "yyyy-MM-dd";

const formatNumber = (value: number): string => formatSharedNumber(value);
const formatCost = (microUsd: number): string => {
	const dollars = microUsd / 1_000_000;
	if (dollars > 0 && dollars < 0.01) {
		return "<$0.01";
	}
	return formatCurrency(dollars, "USD", {
		maximumFractionDigits: dollars >= 10 ? 0 : 2,
	});
};

const WHITESPACE = /\s+/;

function useInitials(name: string | undefined): string {
	return useMemo(() => {
		if (!name) {
			return "?";
		}
		const parts = name.trim().split(WHITESPACE);
		return parts
			.slice(0, 2)
			.map((part) => part.charAt(0).toUpperCase())
			.join("");
	}, [name]);
}

/** Zeroed stats for a rostered agent that has no recorded usage yet. */
function emptyAgentStats(agentId: string): AgentProfileStats {
	return {
		agentId,
		hiredAt: "",
		lastActiveDay: "",
		level: 0,
		xp: 0,
		streak: { current: 0, longest: 0 },
		totals: {
			agentSeconds: 0,
			costMicroUsd: 0,
			inputTokens: 0,
			outputTokens: 0,
			requestCount: 0,
			sessionCount: 0,
		},
	};
}

export function StatsTab() {
	const queryClient = useQueryClient();
	const { data: sessionData } = useSession();
	const user = sessionData?.user;

	const { from, to } = useMemo(() => {
		const now = new Date();
		return {
			from: format(subDays(now, HEATMAP_DAYS), DATE_FORMAT),
			to: format(now, DATE_FORMAT),
		};
	}, []);

	const profileQuery = useQuery({
		queryKey: ["profile", "me"],
		queryFn: fetchProfileMe,
	});
	const usageQuery = useQuery({
		queryKey: ["profile", "usage-daily", from, to],
		queryFn: () => fetchUsageDaily(from, to),
	});
	const statsQuery = useQuery({
		queryKey: ["profile", "stats"],
		queryFn: fetchProfileStats,
	});
	const unlocksQuery = useQuery({
		queryKey: ["profile", "unlocks"],
		queryFn: fetchProfileUnlocks,
	});

	const unlockMutation = useMutation({
		mutationFn: unlockFeature,
		onSuccess: (result) => {
			queryClient.invalidateQueries({ queryKey: ["profile", "unlocks"] });
			queryClient.invalidateQueries({ queryKey: ["profile", "me"] });
			sileo.success({
				title: "Feature unlocked",
				description: `${formatNumber(result.pointsBalance)} points remaining`,
			});
		},
		onError: (error) =>
			sileo.error({
				title: error instanceof Error ? error.message : "Failed to unlock",
			}),
	});

	const initials = useInitials(user?.name ?? profileQuery.data?.name);

	if (profileQuery.isLoading) {
		return (
			<div className="flex items-center justify-center py-8">
				<Spinner className="size-5" />
			</div>
		);
	}

	const profile = profileQuery.data;
	const stats = statsQuery.data;
	const unlocks = unlocksQuery.data;
	const usageDays = usageQuery.data?.days ?? [];
	const heatmapData = usageDays.map((entry) => ({
		day: entry.day,
		count: entry.count,
	}));
	const pointsBalance = profile?.pointsBalance ?? 0;
	const userId = profile?.userId ?? user?.id ?? null;
	const displayName = user?.name ?? profile?.name ?? "You";
	const avatarUrl = user?.image ?? profile?.image ?? undefined;

	const totalTokens =
		(profile?.totals.inputTokens ?? 0) + (profile?.totals.outputTokens ?? 0);
	const agentHours = (profile?.totals.agentSeconds ?? 0) / SECONDS_PER_HOUR;
	const insights = stats?.insights;

	const handleShareWrapped = () => {
		if (!userId) {
			return;
		}
		openExternal(wrappedUrl(userId));
	};

	// The Unlocks grid has three states: a hard load failure (surface it with a
	// Retry so the section never spins forever), the initial load, and the loaded
	// catalog. Without the error branch a failed /me/unlocks request left the
	// spinner up indefinitely.
	const renderUnlocks = () => {
		if (unlocksQuery.isError) {
			return (
				<div className="flex flex-col items-center gap-3 px-3 py-6 text-center">
					<p className="text-muted-foreground text-sm">
						We couldn't load your unlockable features. Check your connection and
						try again.
					</p>
					<Button
						onClick={() => unlocksQuery.refetch()}
						size="sm"
						variant="ghost"
					>
						Retry
					</Button>
				</div>
			);
		}
		if (!unlocks) {
			return (
				<div className="flex items-center justify-center py-6">
					<Spinner className="size-5" />
				</div>
			);
		}
		return (
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				{unlocks.catalog.map((entry) => (
					<UnlockCard
						entry={entry}
						isPending={
							unlockMutation.isPending && unlockMutation.variables === entry.key
						}
						isUnlocked={unlocks.unlocked.includes(entry.key)}
						key={entry.key}
						onUnlock={() => unlockMutation.mutate(entry.key)}
						pointsBalance={pointsBalance}
					/>
				))}
			</div>
		);
	};

	return (
		<div className="space-y-6">
			<SettingsSection title="Overview">
				<SettingsCard className="flex items-center gap-4">
					<Avatar className="size-14">
						{avatarUrl ? (
							<AvatarImage alt={displayName} src={avatarUrl} />
						) : null}
						<AvatarFallback>{initials}</AvatarFallback>
					</Avatar>
					<div className="flex flex-1 flex-col gap-1">
						<span className="font-semibold text-base">{displayName}</span>
						{profile ? (
							<span className="text-muted-foreground text-xs">
								Joined {format(new Date(profile.joinedAt), "MMM d, yyyy")}
							</span>
						) : null}
						<div className="mt-1 flex flex-wrap items-center gap-2">
							<Badge variant="secondary">Level {profile?.level ?? 0}</Badge>
							<Badge variant="outline">
								{profile?.streak.current ?? 0} day streak
							</Badge>
							<Badge variant="outline">
								{formatNumber(pointsBalance)} points
							</Badge>
						</div>
					</div>
					<Button
						disabled={!userId}
						onClick={handleShareWrapped}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={ArrowUpRight01Icon} />
						Share your Ryu Wrapped
					</Button>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection
				caption="Your activity over the last year."
				title="Activity"
			>
				<SettingsCard>
					<ContributionsGraph data={heatmapData} title="Daily usage" />
				</SettingsCard>
				<SettingsCard>
					<span className="font-medium text-sm">Last 30 days</span>
					<ActivityArea data={usageDays} days={30} formatCount={formatNumber} />
				</SettingsCard>
			</SettingsSection>

			<SettingsSection title="Lifetime">
				<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
					<StatCard
						icon={<Zap className="size-4" />}
						sub="input + output"
						title="Total tokens"
						value={formatNumber(totalTokens)}
					/>
					<StatCard
						icon={<Cpu className="size-4" />}
						sub="agent runtime"
						title="Agent hours"
						value={agentHours.toFixed(1)}
					/>
					<StatCard
						icon={<CreditCard className="size-4" />}
						title="Total spend"
						value={formatCost(profile?.totals.costMicroUsd ?? 0)}
					/>
					<StatCard
						icon={<Activity className="size-4" />}
						title="Requests"
						value={formatNumber(profile?.totals.requestCount ?? 0)}
					/>
				</div>

				<div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
					<SettingsCard>
						<span className="font-medium text-sm">
							Where your usage comes from
						</span>
						<TransportDonut
							formatCount={formatNumber}
							transport={
								stats?.insights.transport ?? {
									acp: 0,
									gateway: 0,
									openAiCompat: 0,
									other: 0,
								}
							}
						/>
					</SettingsCard>
					<SettingsCard>
						<span className="font-medium text-sm">Usage by feature</span>
						<FeatureMixBar
							featureTotals={
								stats?.byFeatureTotals ?? {
									agentSeconds: 0,
									chat: 0,
									island: 0,
									predictAccepted: 0,
								}
							}
						/>
					</SettingsCard>
				</div>

				<div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
					<StatCard
						icon={<CalendarDays className="size-4" />}
						title="Active days"
						value={formatNumber(insights?.activeDays ?? 0)}
					/>
					<StatCard
						icon={<Trophy className="size-4" />}
						sub={insights?.peakDay?.day ?? "none yet"}
						title="Peak day"
						value={formatNumber(insights?.peakDay?.tokens ?? 0)}
					/>
					<StatCard
						icon={<Gauge className="size-4" />}
						sub="best effort"
						title="Peak hour"
						value={
							insights?.peakHourUtc ? `${insights.peakHourUtc}:00 UTC` : "—"
						}
					/>
					<StatCard
						icon={<Bot className="size-4" />}
						title="Favourite model"
						value={insights?.favoriteModel ?? "—"}
					/>
				</div>
			</SettingsSection>

			<SettingsSection title="Most used">
				<div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
					<RankedList
						empty="No model usage recorded yet."
						formatCount={formatNumber}
						icon={<Bot className="size-4" />}
						items={insights?.topModels ?? []}
						title="Models"
					/>
					<RankedList
						empty="No skill usage recorded yet."
						formatCount={formatNumber}
						icon={<Sparkles className="size-4" />}
						items={insights?.topSkills ?? []}
						title="Skills"
					/>
					<RankedList
						empty="No plugin usage recorded yet."
						formatCount={formatNumber}
						icon={<Plug className="size-4" />}
						items={insights?.topPlugins ?? []}
						title="Plugins"
					/>
				</div>
			</SettingsSection>

			<TeamSection />

			<SettingsSection
				caption="Spend points to unlock features. Some unlock automatically as you level up, others come with your plan."
				title="Unlocks"
			>
				{renderUnlocks()}
			</SettingsSection>
		</div>
	);
}

/**
 * The "Your Team" roster: the agents-as-employees grid. Merges the Core roster
 * (identity) with the control-plane per-agent stats (usage), and drills into a
 * single agent's profile on click. Self-contained so the parent StatsTab stays
 * simple.
 */
function TeamSection() {
	const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
	const { agents: roster, loading: rosterLoading } = useAgents();
	const teamQuery = useQuery({
		queryKey: ["profile", "team-agents"],
		queryFn: fetchTeamAgents,
	});

	const statsByAgentId = new Map(
		(teamQuery.data?.agents ?? []).map((entry) => [entry.agentId, entry])
	);
	const selectedAgent = selectedAgentId
		? roster.find((agent) => agent.id === selectedAgentId)
		: undefined;

	if (selectedAgent) {
		return (
			<AgentProfile
				agent={selectedAgent}
				key={selectedAgent.id}
				onBack={() => setSelectedAgentId(null)}
			/>
		);
	}

	return (
		<SettingsSection
			caption="Every agent you employ, with its ID badge and usage. Select one to see its full profile."
			title="Your team"
		>
			{rosterLoading ? (
				<div className="flex items-center justify-center py-6">
					<Spinner className="size-5" />
				</div>
			) : (
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{roster.map((agent) => (
						<TeamBadge
							agent={agent}
							key={agent.id}
							onSelect={() => setSelectedAgentId(agent.id)}
							stats={statsByAgentId.get(agent.id) ?? emptyAgentStats(agent.id)}
						/>
					))}
				</div>
			)}
		</SettingsSection>
	);
}

interface TeamBadgeProps {
	agent: AgentSummary;
	onSelect: () => void;
	stats: AgentProfileStats;
}

function TeamBadge({ agent, onSelect, stats }: TeamBadgeProps) {
	const { resolvedTheme } = useTheme();
	const totalTokens = stats.totals.inputTokens + stats.totals.outputTokens;
	return (
		<EmployeeBadge
			employeeId={agent.id}
			hiredAt={stats.hiredAt || undefined}
			level={stats.level}
			// The metal ring's `auto` follows the OS, which can disagree with the
			// app's own toggle — feed it the theme actually on screen.
			metalTheme={resolvedTheme === "light" ? "light" : "dark"}
			name={agent.name}
			onClick={onSelect}
			role={agent.description ?? undefined}
			stats={[
				{ label: "Tokens", value: formatNumber(totalTokens) },
				{ label: "Requests", value: formatNumber(stats.totals.requestCount) },
				{ label: "Streak", value: `${stats.streak.current}d` },
			]}
		/>
	);
}

interface UnlockCardProps {
	entry: UnlockCatalogEntry;
	isPending: boolean;
	isUnlocked: boolean;
	onUnlock: () => void;
	pointsBalance: number;
}

function UnlockCard({
	entry,
	isPending,
	isUnlocked,
	onUnlock,
	pointsBalance,
}: UnlockCardProps) {
	const requiresPlan = (entry.requiresPlan?.length ?? 0) > 0;
	const cost = entry.pointsCost ?? 0;
	const affordable = cost > 0 && pointsBalance >= cost;

	const renderAction = () => {
		if (isUnlocked) {
			return <Badge variant="secondary">Unlocked</Badge>;
		}
		if (entry.tier === "paid" && requiresPlan) {
			return (
				<Badge variant="outline">
					Requires {entry.requiresPlan?.join(", ")}
				</Badge>
			);
		}
		if (entry.tier === "progressive" && entry.autoUnlockAtLevel) {
			return (
				<Badge variant="outline">
					Unlocks at level {entry.autoUnlockAtLevel}
				</Badge>
			);
		}
		if (cost > 0) {
			return (
				<Button
					disabled={!affordable || isPending}
					onClick={onUnlock}
					size="sm"
				>
					{isPending ? "Unlocking…" : `Unlock · ${formatNumber(cost)} pts`}
				</Button>
			);
		}
		return null;
	};

	return (
		<SettingsCard className="flex items-start justify-between gap-3">
			<div className="flex flex-col gap-1">
				<span className="font-medium text-sm">{entry.title}</span>
				<span className="text-muted-foreground text-xs">
					{entry.description}
				</span>
			</div>
			<div className="shrink-0">{renderAction()}</div>
		</SettingsCard>
	);
}

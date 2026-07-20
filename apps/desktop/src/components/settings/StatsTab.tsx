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
import { Spinner } from "@ryu/ui/components/spinner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format, subDays } from "date-fns";
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

const numberFormatter = new Intl.NumberFormat("en-US");
const formatNumber = (value: number): string => numberFormatter.format(value);
const formatCost = (microUsd: number): string => {
	const dollars = microUsd / 1_000_000;
	if (dollars > 0 && dollars < 0.01) {
		return "<$0.01";
	}
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: dollars >= 10 ? 0 : 2,
	}).format(dollars);
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
	const observedRuns =
		(insights?.transport.gateway ?? 0) +
		(insights?.transport.acp ?? 0) +
		(insights?.transport.openAiCompat ?? 0) +
		(insights?.transport.other ?? 0);

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
						variant="outline"
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
						variant="outline"
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
			</SettingsSection>

			<SettingsSection title="Lifetime stats">
				<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
					<StatCard title="Total tokens" value={formatNumber(totalTokens)} />
					<StatCard title="Agent hours" value={agentHours.toFixed(1)} />
					<StatCard
						title="Total spend"
						value={formatCost(profile?.totals.costMicroUsd ?? 0)}
					/>
					<StatCard
						title="Requests"
						value={formatNumber(profile?.totals.requestCount ?? 0)}
					/>
					<StatCard
						title="Active days"
						value={formatNumber(insights?.activeDays ?? 0)}
					/>
					<StatCard
						title="Peak day"
						value={formatNumber(insights?.peakDay?.tokens ?? 0)}
					/>
					<StatCard
						title="Peak hour"
						value={
							insights?.peakHourUtc ? `${insights.peakHourUtc}:00 UTC` : "—"
						}
					/>
					<StatCard
						title="Favourite model"
						value={insights?.favoriteModel ?? "—"}
					/>
					<StatCard
						title="Observed ACP runs"
						value={formatNumber(insights?.transport.acp ?? 0)}
					/>
					<StatCard title="Observed runs" value={formatNumber(observedRuns)} />
					<StatCard
						title="Island interactions"
						value={formatNumber(stats?.byFeatureTotals.island ?? 0)}
					/>
					<StatCard
						title="Predictions accepted"
						value={formatNumber(stats?.byFeatureTotals.predictAccepted ?? 0)}
					/>
				</div>
			</SettingsSection>

			<SettingsSection title="Most used">
				<div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
					<LeaderboardCard
						empty="No model usage recorded yet."
						items={insights?.topModels ?? []}
						title="Models"
					/>
					<LeaderboardCard
						empty="No skill usage recorded yet."
						items={insights?.topSkills ?? []}
						title="Skills"
					/>
					<LeaderboardCard
						empty="No plugin usage recorded yet."
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
				agentId={selectedAgent.id}
				description={selectedAgent.description}
				key={selectedAgent.id}
				name={selectedAgent.name}
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
	const totalTokens = stats.totals.inputTokens + stats.totals.outputTokens;
	return (
		<EmployeeBadge
			employeeId={agent.id}
			hiredAt={stats.hiredAt || undefined}
			level={stats.level}
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

function LeaderboardCard({
	empty,
	items,
	title,
}: {
	empty: string;
	items: Array<{ count: number; id: string }>;
	title: string;
}) {
	return (
		<SettingsCard className="flex flex-col gap-3">
			<span className="font-medium text-sm">{title}</span>
			{items.length > 0 ? (
				<div className="space-y-2">
					{items.map((item) => (
						<div
							className="flex items-center justify-between gap-3 text-sm"
							key={item.id}
						>
							<span className="truncate font-medium">{item.id}</span>
							<span className="shrink-0 text-muted-foreground">
								{formatNumber(item.count)} runs
							</span>
						</div>
					))}
				</div>
			) : (
				<span className="text-muted-foreground text-sm">{empty}</span>
			)}
		</SettingsCard>
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

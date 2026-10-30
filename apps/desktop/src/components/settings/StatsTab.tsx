// The "Stats" settings tab — a personal dashboard for the signed-in account.
// Reads the profile/stats control plane (apps/desktop/src/lib/api/profile.ts):
// a header (avatar/name + level/streak), a GitHub-style contributions heatmap
// fed by daily usage, a grid of lifetime stat cards, and the unlockable-feature
// catalog. The "Share your Ryu Wrapped" button opens the public web share card
// (FRONTEND_URL/wrapped/:userId) in the user's browser; "Share as clip" exports
// the heatmap as a looping video or GIF (`@ryu/ui` share-clips).

import {
	ArrowUpRight01Icon,
	VideoReplayIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { withActiveDays } from "@ryu/ui/components/contributions-graph.tsx";
import type { HeatmapClipData } from "@ryu/ui/components/share-clips/heatmap-clip.ts";
import { HeatmapClipDialog } from "@ryu/ui/components/share-clips/heatmap-clip-dialog.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { USAGE_STREAK_HINT } from "@ryu/ui/lib/usage-streak.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format, subDays } from "date-fns";
import { useTheme } from "next-themes";
import { useMemo, useState } from "react";
import { sileo } from "sileo";
import { useSession } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import {
	fetchProfileMe,
	fetchProfileStats,
	fetchProfileUnlocks,
	fetchUsageDaily,
	unlockFeature,
	wrappedUrl,
} from "@/src/lib/api/profile.ts";
import { formatNumber } from "./StatsTab-format.ts";
import { TeamSection } from "./StatsTab-team-section.tsx";
import { UnlockCard } from "./StatsTab-unlock-card.tsx";
import { StatsUsageSections } from "./StatsTab-usage-sections.tsx";
import { SettingsSection } from "./shared/settings-items.tsx";

const SECONDS_PER_HOUR = 3600;
const HEATMAP_DAYS = 364;
const DATE_FORMAT = "yyyy-MM-dd";

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

export function StatsTab() {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const { resolvedTheme } = useTheme();
	const [clipOpen, setClipOpen] = useState(false);
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
				description: tl("{points} points remaining", {
					points: formatNumber(result.pointsBalance),
				}),
			});
		},
		onError: (error) =>
			sileo.error({
				title: error instanceof Error ? error.message : "Failed to unlock",
			}),
	});

	const initials = useInitials(user?.name ?? profileQuery.data?.name);

	if (profileQuery.isLoading) {
		return <SkeletonRows />;
	}

	const profile = profileQuery.data;
	// A failed background refetch keeps the last good profile: only a profile
	// that never loaded replaces the dashboard with the error card.
	const profileFailed = profileQuery.isError && !profile;
	const stats = statsQuery.data;
	const unlocks = unlocksQuery.data;
	const usageDays = usageQuery.data?.days ?? [];
	// Days that are streak-active with no requests show at the lowest level.
	const heatmapData = withActiveDays(usageDays, usageQuery.data?.activeDays);
	const pointsBalance = profile?.pointsBalance ?? 0;
	const userId = profile?.userId ?? user?.id ?? null;
	const displayName = user?.name ?? profile?.name ?? "You";
	const avatarUrl = user?.image ?? profile?.image ?? undefined;

	const totalTokens =
		(profile?.totals.inputTokens ?? 0) + (profile?.totals.outputTokens ?? 0);
	const agentHours = (profile?.totals.agentSeconds ?? 0) / SECONDS_PER_HOUR;
	const insights = stats?.insights;

	const clipData: HeatmapClipData = {
		activeDays: insights?.activeDays ?? 0,
		days: heatmapData,
		endDay: to,
		favoriteModel: insights?.favoriteModel ?? null,
		level: profile?.level ?? 0,
		name: displayName,
		peakDay: insights?.peakDay ?? null,
		streakCurrent: profile?.streak.current ?? 0,
		streakLongest: profile?.streak.longest ?? 0,
		totalTokens,
	};

	const handleShareWrapped = () => {
		if (!userId) {
			return;
		}
		// A native refusal (no default browser, no bridge outside the desktop
		// shell) must not escape as an unhandled rejection, same as the other
		// settings links.
		void Promise.resolve(openExternal(wrappedUrl(userId))).catch(
			() => undefined
		);
	};

	// The Unlocks grid has three states: a hard load failure (surface it with a
	// Retry so the section never spins forever), the initial load, and the loaded
	// catalog. Without the error branch a failed /me/unlocks request left the
	// spinner up indefinitely.
	const renderUnlocks = () => {
		if (unlocksQuery.isError) {
			return (
				<div className="flex min-h-12 items-center justify-between gap-6 py-3">
					<p className="text-muted-foreground text-sm">
						We couldn't load your unlockable features.
					</p>
					<Button
						className="shrink-0"
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
			return <SkeletonRows />;
		}
		return (
			<div className="flex flex-col">
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
		<div>
			<SettingsSection
				headerAction={
					<span className="flex flex-wrap items-center justify-end gap-1">
						<Button
							disabled={!userId}
							onClick={handleShareWrapped}
							size="sm"
							variant="ghost-muted"
						>
							<HugeiconsIcon icon={ArrowUpRight01Icon} size={16} />
							Share your Ryu Wrapped
						</Button>
						<Button
							disabled={!userId}
							onClick={() => setClipOpen(true)}
							size="sm"
							variant="ghost-muted"
						>
							<HugeiconsIcon icon={VideoReplayIcon} size={16} />
							Share as clip
						</Button>
					</span>
				}
				title="Overview"
			>
				{/* One flat row: who, then a single muted line of standing. Level,
				    streak and points are plain text; none of them is an alert. */}
				<div className="flex min-h-12 items-center gap-3 py-3">
					<Avatar className="size-10">
						{avatarUrl ? (
							<AvatarImage alt={displayName} src={avatarUrl} />
						) : null}
						<AvatarFallback>{initials}</AvatarFallback>
					</Avatar>
					<div className="flex min-w-0 flex-1 flex-col gap-0.5">
						<span className="truncate font-medium text-sm">{displayName}</span>
						<span className="flex flex-wrap items-center gap-x-1.5 text-detail text-muted-foreground">
							{profile ? (
								<>
									<span>
										{tl("Joined {date}", {
											date: format(new Date(profile.joinedAt), "MMM d, yyyy"),
										})}
									</span>
									<span aria-hidden="true">·</span>
								</>
							) : null}
							<span>
								{tl("Level {level}", { level: String(profile?.level ?? 0) })}
							</span>
							<span aria-hidden="true">·</span>
							{/* A streak day is any UTC day the account used Ryu, agent
							    runs included, so the hint explains that rather than
							    leaving "streak" to be read as chat-only. */}
							<Tooltip>
								<TooltipTrigger
									render={
										<button
											className="rounded-lg tabular-nums outline-hidden hover:text-foreground focus-visible:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-solid focus-visible:outline-offset-2"
											type="button"
										/>
									}
								>
									{profile && profile.streak.longest > 0
										? tl("{current} day streak · best {longest}", {
												current: String(profile.streak.current),
												longest: String(profile.streak.longest),
											})
										: tl("{current} day streak", {
												current: String(profile?.streak.current ?? 0),
											})}
									<span className="sr-only">{USAGE_STREAK_HINT}</span>
								</TooltipTrigger>
								<TooltipContent>{USAGE_STREAK_HINT}</TooltipContent>
							</Tooltip>
							<span aria-hidden="true">·</span>
							<span className="tabular-nums">
								{tl("{points} points", { points: formatNumber(pointsBalance) })}
							</span>
						</span>
					</div>
				</div>
				{/* Exports go through the anchor download the desktop webview already
				    uses for its other exports (backups, vault, spaces). */}
				<HeatmapClipDialog
					data={clipData}
					isDark={resolvedTheme !== "light"}
					onOpenChange={setClipOpen}
					open={clipOpen}
				/>
			</SettingsSection>

			{profileFailed ? (
				// No profile means every number below would be a zero standing in for
				// "unknown": say so once instead of drawing a dashboard of fixtures.
				<SettingsSection title="Activity">
					<div className="flex min-h-12 items-center justify-between gap-6 py-3">
						<p
							className="text-muted-foreground text-sm"
							title={
								profileQuery.error instanceof Error
									? profileQuery.error.message
									: undefined
							}
						>
							{userId
								? "Couldn't load your stats."
								: "Sign in to see your activity, usage and unlocks."}
						</p>
						{userId ? (
							<Button
								onClick={() => profileQuery.refetch()}
								size="sm"
								variant="outline"
							>
								Retry
							</Button>
						) : null}
					</div>
				</SettingsSection>
			) : (
				<StatsUsageSections
					agentHours={agentHours}
					costMicroUsd={profile?.totals.costMicroUsd ?? 0}
					heatmapData={heatmapData}
					insights={insights}
					requestCount={profile?.totals.requestCount ?? 0}
					stats={stats}
					totalTokens={totalTokens}
					usageDays={usageDays}
				/>
			)}

			<TeamSection />

			{profileFailed ? null : (
				<SettingsSection
					caption="Spend points to unlock features. Some unlock as you level up or come with a plan."
					title="Unlocks"
				>
					{renderUnlocks()}
				</SettingsSection>
			)}
		</div>
	);
}

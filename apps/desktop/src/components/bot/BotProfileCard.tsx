import { ArrowDown01Icon, ArrowUp01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Logo } from "@ryu/ui/components/logo.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { TabsSubtle, TabsSubtleItem } from "@ryu/ui/components/tabs-subtle.tsx";
import {
	type GoalState,
	pauseGoal,
	resumeGoal,
} from "@ryuhq/core-client/goals.ts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useApprovals } from "@/src/hooks/useApprovals.ts";
import { type ActivityItem, listActivity } from "@/src/lib/api/activity.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type BotFeedEngagement,
	type BotFeedPreferences,
	type BotFeedSource,
	loadBotFeedEngagement,
	loadBotFeedPreferences,
	saveBotFeedEngagement,
	saveBotFeedPreferences,
} from "@/src/lib/bot-feed.ts";
import { useLiveActivities } from "@/src/store/useLiveActivityStore.ts";
import type { Conversation } from "@/types/chat.ts";
import { BotProfileContent } from "./BotProfileCard-content.tsx";
import { FeedPreferences } from "./BotProfileCard-feed.tsx";
import {
	type BotProfileTab,
	GOAL_QUERY_PREFIX,
	readCollapsed,
	saveCollapsed,
	useBotGoalRows,
} from "./BotProfileCard-model.ts";

export function BotProfileCard({
	conversations,
}: {
	conversations: Conversation[];
}) {
	const tl = useLiteralMessages();
	const openTab = useTabSelector((state) => state.openTab);
	const node = useActiveNode();
	const target = useMemo<ApiTarget>(
		() => ({
			token: node.token ?? null,
			url: node.url,
			userJwt: node.userJwt ?? null,
		}),
		[node.token, node.url, node.userJwt]
	);
	const approvals = useApprovals();
	const liveActivities = useLiveActivities();
	const queryClient = useQueryClient();
	const [view, setView] = useState<BotProfileTab>("overview");
	const [collapsed, setCollapsed] = useState(readCollapsed);
	const [feedPreferences, setFeedPreferences] = useState<BotFeedPreferences>(
		loadBotFeedPreferences
	);
	const [engagement, setEngagement] = useState<BotFeedEngagement>(
		loadBotFeedEngagement
	);
	const [decidingApproval, setDecidingApproval] = useState<string | null>(null);
	const [togglingGoal, setTogglingGoal] = useState<string | null>(null);
	const activityQuery = useQuery({
		queryKey: ["bot-profile-activity", target.url],
		queryFn: () => listActivity(target, { limit: 24 }),
		refetchInterval: 30_000,
		retry: false,
		staleTime: 15_000,
	});
	const goalState = useBotGoalRows(conversations, target);
	const activity = activityQuery.data ?? [];
	const pendingApprovals = approvals.approvals.filter(
		(approval) => approval.status === "pending"
	);
	const activeGoals = goalState.rows.filter(
		({ goal }) => goal.status === "active"
	);
	const statusText = liveActivities[0]
		? liveActivities[0].detail || liveActivities[0].title
		: pendingApprovals.length > 0
			? tl(
					"{count, plural, one {{countText} action} other {{countText} actions}} waiting for you",
					{
						count: pendingApprovals.length,
						countText: String(pendingApprovals.length),
					}
				)
			: activeGoals.length > 0
				? tl("{count, plural, one {# goal} other {# goals}} in motion", {
						count: activeGoals.length,
					})
				: "Ready when you are";

	useEffect(() => {
		saveBotFeedPreferences(feedPreferences);
	}, [feedPreferences]);
	useEffect(() => {
		saveBotFeedEngagement(engagement);
	}, [engagement]);

	const openChat = useCallback(
		(prompt?: string, title = "New chat") => {
			openTab("/chat", {
				forceNew: true,
				initialPrompt: prompt,
				title,
			});
		},
		[openTab]
	);
	const openActivity = useCallback(
		(item: ActivityItem) => {
			if (item.session_id) {
				openTab("/chat", {
					conversationId: item.session_id,
					title: item.title,
				});
				return;
			}
			setView("feed");
		},
		[openTab]
	);
	const openGoal = useCallback(
		(conversation: Conversation) => {
			openTab("/chat", {
				conversationId: conversation.id,
				title: conversation.title ?? "Goal",
			});
		},
		[openTab]
	);
	const updatePreference = useCallback(
		(source: BotFeedSource, checked: boolean) => {
			setFeedPreferences((current) => ({
				sources: checked
					? [...new Set([...current.sources, source])]
					: current.sources.filter((entry) => entry !== source),
			}));
		},
		[]
	);
	const toggleLike = useCallback((id: string) => {
		setEngagement((current) => ({
			...current,
			liked: current.liked.includes(id)
				? current.liked.filter((entry) => entry !== id)
				: [...current.liked, id],
		}));
	}, []);
	const addComment = useCallback((id: string, comment: string) => {
		setEngagement((current) => ({
			...current,
			comments: {
				...current.comments,
				[id]: [...(current.comments[id] ?? []), comment],
			},
		}));
	}, []);
	const decideApproval = useCallback(
		(id: string, decide: ReturnType<typeof useApprovals>["approve"]) => {
			setDecidingApproval(id);
			decide(id)
				.catch(() => undefined)
				.finally(() => setDecidingApproval(null));
		},
		[]
	);
	const toggleGoal = useCallback(
		(conversationId: string, goal: GoalState) => {
			setTogglingGoal(conversationId);
			const update = goal.status === "paused" ? resumeGoal : pauseGoal;
			update(target, conversationId)
				.then(() =>
					queryClient.invalidateQueries({
						queryKey: [GOAL_QUERY_PREFIX, target.url, conversationId],
					})
				)
				.catch(() => {
					toast.error({
						description:
							"This goal hasn’t changed. Check the connection and try again.",
						title: "Goal",
					});
				})
				.finally(() => setTogglingGoal(null));
		},
		[queryClient, target]
	);

	const setCardCollapsed = (next: boolean) => {
		setCollapsed(next);
		saveCollapsed(next);
	};

	return (
		<section
			aria-label="Bot activity"
			className="mx-2 mb-2"
			data-testid="bot-profile-card"
		>
			<div className="flex h-8 items-center gap-2 px-2">
				<span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
					<Logo size="20px" variant="outline" />
				</span>
				<p className="min-w-0 flex-1 truncate text-sm" title={statusText}>
					<span className="font-medium">Bot</span>
					<span className="ml-2 text-detail text-muted-foreground">
						{statusText}
					</span>
				</p>
				{collapsed ? null : (
					<FeedPreferences
						onChange={updatePreference}
						preferences={feedPreferences}
					/>
				)}
				<Button
					aria-expanded={!collapsed}
					aria-label={
						collapsed ? "Expand bot activity" : "Collapse bot activity"
					}
					className="shrink-0"
					onClick={() => setCardCollapsed(!collapsed)}
					size="icon-sm"
					variant="ghost-muted"
				>
					<HugeiconsIcon
						className="size-3.5"
						icon={collapsed ? ArrowDown01Icon : ArrowUp01Icon}
					/>
				</Button>
			</div>
			{collapsed ? null : (
				<div className="scroll-fade max-h-[min(45vh,25rem)] overflow-y-auto px-2 pt-1 pb-2">
					<TabsSubtle
						appearance="bot-feed"
						aria-label="Bot activity views"
						className="w-full justify-between"
						onSelect={(index) => {
							const next = ["overview", "approvals", "goals", "feed"][index];
							if (
								next === "overview" ||
								next === "approvals" ||
								next === "goals" ||
								next === "feed"
							) {
								setView(next);
							}
						}}
						selectedIndex={["overview", "approvals", "goals", "feed"].indexOf(
							view
						)}
					>
						<TabsSubtleItem index={0} label="Overview" />
						<TabsSubtleItem index={1} label="Approvals" />
						<TabsSubtleItem index={2} label="Goals" />
						<TabsSubtleItem index={3} label="Feed" />
					</TabsSubtle>
					<div className="mt-3">
						<BotProfileContent
							activity={activity}
							activityError={activityQuery.isError}
							activityLoading={activityQuery.isPending}
							approvals={approvals}
							decidingApproval={decidingApproval}
							engagement={engagement}
							feedPreferences={feedPreferences}
							goalError={goalState.error}
							goalLoading={goalState.loading}
							goalRows={goalState.rows}
							liveActivities={liveActivities}
							onApprove={(id) => decideApproval(id, approvals.approve)}
							onComment={addComment}
							onFeedPreference={updatePreference}
							onLike={toggleLike}
							onOpenActivity={openActivity}
							onOpenChat={openChat}
							onOpenGoal={openGoal}
							onReject={(id) => decideApproval(id, approvals.reject)}
							onRetryActivity={() => void activityQuery.refetch()}
							onRetryGoals={() => void goalState.retry()}
							onToggleGoal={toggleGoal}
							togglingGoal={togglingGoal}
							view={view}
						/>
					</div>
				</div>
			)}
		</section>
	);
}

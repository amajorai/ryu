import {
	Activity01Icon,
	ArrowUpRight01Icon,
	Radar01Icon,
	Shield01Icon,
	Target01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Item,
	ItemContent,
	ItemDescription,
	ItemMedia,
	ItemTitle,
} from "@ryu/ui/components/item.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import type { GoalState } from "@ryuhq/core-client/goals.ts";
import type { useApprovals } from "@/src/hooks/useApprovals.ts";
import type { ActivityItem } from "@/src/lib/api/activity.ts";
import {
	type BotFeedEngagement,
	type BotFeedPreferences,
	type BotFeedSource,
	filterBotFeed,
} from "@/src/lib/bot-feed.ts";
import type { useLiveActivities } from "@/src/store/useLiveActivityStore.ts";
import type { Conversation } from "@/types/chat.ts";
import {
	ActivityPreview,
	FeedPost,
	FeedPreferences,
} from "./BotProfileCard-feed.tsx";
import type { BotProfileTab } from "./BotProfileCard-model.ts";
import {
	ApprovalRow,
	EmptyPanel,
	GoalGroup,
	QueryErrorPanel,
	SummaryLine,
} from "./BotProfileCard-rows.tsx";

export function BotProfileContent({
	activity,
	activityError,
	activityLoading,
	approvals,
	engagement,
	feedPreferences,
	goalRows,
	goalError,
	goalLoading,
	liveActivities,
	onApprove,
	onComment,
	onFeedPreference,
	onLike,
	onOpenActivity,
	onOpenChat,
	onOpenGoal,
	onReject,
	onRetryActivity,
	onRetryGoals,
	onToggleGoal,
	decidingApproval,
	togglingGoal,
	view,
}: {
	activity: ActivityItem[];
	activityError: boolean;
	activityLoading: boolean;
	approvals: ReturnType<typeof useApprovals>;
	engagement: BotFeedEngagement;
	feedPreferences: BotFeedPreferences;
	goalRows: { conversation: Conversation; goal: GoalState }[];
	goalError: boolean;
	goalLoading: boolean;
	liveActivities: ReturnType<typeof useLiveActivities>;
	onApprove: (id: string) => void;
	onComment: (id: string, comment: string) => void;
	onFeedPreference: (source: BotFeedSource, checked: boolean) => void;
	onLike: (id: string) => void;
	onOpenActivity: (item: ActivityItem) => void;
	onOpenChat: (prompt?: string, title?: string) => void;
	onOpenGoal: (conversation: Conversation) => void;
	onReject: (id: string) => void;
	onRetryActivity: () => void;
	onRetryGoals: () => void;
	onToggleGoal: (conversationId: string, goal: GoalState) => void;
	decidingApproval: string | null;
	togglingGoal: string | null;
	view: BotProfileTab;
}) {
	const tl = useLiteralMessages();
	const pendingApprovals = approvals.approvals.filter(
		(approval) => approval.status === "pending"
	);
	const activeGoals = goalRows.filter(({ goal }) => goal.status === "active");
	const passiveGoals = goalRows.filter(({ goal }) => goal.status === "paused");
	const completedGoals = goalRows.filter(
		({ goal }) => goal.status === "achieved"
	);
	const feed = filterBotFeed(activity, feedPreferences).slice(0, 6);

	if (view === "approvals") {
		if (approvals.loading) {
			return <Spinner className="mx-auto my-8 size-4" />;
		}
		if (approvals.error) {
			return (
				<EmptyPanel
					description="Ryu keeps the action behind the server-side gate."
					icon={Shield01Icon}
					title="Approvals are unavailable"
				/>
			);
		}
		return pendingApprovals.length > 0 ? (
			<div className="flex flex-col">
				{pendingApprovals.slice(0, 4).map((approval) => (
					<ApprovalRow
						approval={approval}
						busy={decidingApproval === approval.id}
						key={approval.id}
						onApprove={() => onApprove(approval.id)}
						onReject={() => onReject(approval.id)}
					/>
				))}
				{pendingApprovals.length > 4 ? (
					<p className="px-2 pt-2 text-muted-foreground text-xs">
						{tl("+{count} more waiting in the queue", {
							count: String(pendingApprovals.length - 4),
						})}
					</p>
				) : null}
			</div>
		) : (
			<EmptyPanel
				description="Actions that can’t be undone wait here for you."
				icon={Shield01Icon}
				title="Nothing needs your decision"
			/>
		);
	}

	if (view === "goals") {
		if (goalLoading && goalRows.length === 0) {
			return <SkeletonRows spacing="generous" />;
		}
		if (goalError && goalRows.length === 0) {
			return (
				<QueryErrorPanel
					description="Try again to check their latest state."
					icon={Target01Icon}
					onRetry={onRetryGoals}
					title="Goals are unavailable"
				/>
			);
		}
		if (goalRows.length === 0) {
			return (
				<div className="flex flex-col gap-2">
					<EmptyPanel
						description="Goals stay attached to the chats that carry them."
						icon={Target01Icon}
						title="No goals yet"
					/>
					<Button
						className="self-start"
						onClick={() =>
							onOpenChat(
								"I want to set a goal. Help me turn what I want into a clear outcome and a next step.",
								"Set a goal"
							)
						}
						size="sm"
						variant="outline"
					>
						Set a goal in chat
					</Button>
				</div>
			);
		}
		return (
			<div className="flex flex-col gap-2">
				{goalError ? (
					<QueryErrorPanel
						description="Try again to check their latest state."
						icon={Target01Icon}
						onRetry={onRetryGoals}
						title="Some goals are unavailable"
					/>
				) : null}
				<GoalGroup
					label={tl("Active · {count}", { count: String(activeGoals.length) })}
					onOpen={onOpenGoal}
					onToggle={onToggleGoal}
					rows={activeGoals}
					togglingGoal={togglingGoal}
				/>
				<GoalGroup
					label={tl("Passive · {count}", {
						count: String(passiveGoals.length),
					})}
					onOpen={onOpenGoal}
					onToggle={onToggleGoal}
					rows={passiveGoals}
					togglingGoal={togglingGoal}
				/>
				{completedGoals.length > 0 ? (
					<p className="px-2 text-muted-foreground text-xs">
						{tl(
							"{count, plural, one {# recently completed goal} other {# recently completed goals}}",
							{ count: completedGoals.length }
						)}
					</p>
				) : null}
			</div>
		);
	}

	if (view === "feed") {
		if (activityError && activity.length === 0) {
			return (
				<QueryErrorPanel
					description="Try again to reload it from this node."
					icon={Activity01Icon}
					onRetry={onRetryActivity}
					title="Activity is unavailable"
				/>
			);
		}
		if (activityLoading && activity.length === 0) {
			return <Spinner className="mx-auto my-8 size-4" />;
		}
		return (
			<div className="flex flex-col">
				<div className="flex items-center justify-between gap-2 px-2">
					<p className="text-muted-foreground text-xs">
						Reactions are saved on this device for now.
					</p>
					<FeedPreferences
						onChange={onFeedPreference}
						preferences={feedPreferences}
					/>
				</div>
				{feed.length > 0 ? (
					feed.map((item) => (
						<FeedPost
							engagement={engagement}
							item={item}
							key={item.id}
							onComment={(comment) => onComment(item.id, comment)}
							onLike={() => onLike(item.id)}
							onReply={() =>
								onOpenChat(
									`Reply to this Ryu activity update:\n\n${item.title}${item.body ? `\n${item.body}` : ""}\n\nHelp me decide the next useful response. Keep external actions behind approval.`,
									"Reply to activity"
								)
							}
						/>
					))
				) : (
					<EmptyPanel
						description="New agent updates appear here as they happen."
						icon={Activity01Icon}
						title="Your feed is quiet"
					/>
				)}
			</div>
		);
	}

	const recentActivity = filterBotFeed(activity, feedPreferences).slice(0, 3);
	return (
		<div className="flex flex-col gap-3">
			<SummaryLine
				stats={[
					{
						text: tl("{count} working", {
							count: String(liveActivities.length),
						}),
						value: liveActivities.length,
					},
					{
						text: tl("{count} awaiting approval", {
							count: String(pendingApprovals.length),
						}),
						value: pendingApprovals.length,
					},
					{
						text: tl("{count, plural, one {# goal} other {# goals}}", {
							count: activeGoals.length,
						}),
						value: activeGoals.length,
					},
				]}
			/>
			{liveActivities.length > 0 ? (
				<div className="flex flex-col">
					<h4 className="flex h-7 items-center px-2 text-detail text-muted-foreground">
						Live now
					</h4>
					{liveActivities.slice(0, 2).map((activity) => (
						<Item
							className="gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-muted"
							key={activity.id}
							onClick={() => {
								if (activity.action?.kind === "route") {
									onOpenChat(
										`Continue the work currently shown as “${activity.title}”.`,
										activity.title
									);
								}
							}}
							render={<button type="button" />}
							size="xs"
						>
							<ItemMedia className="self-start pt-1.5">
								<span
									aria-hidden="true"
									className="size-1.5 rounded-full bg-status-info"
								/>
							</ItemMedia>
							<ItemContent className="min-w-0 gap-0.5">
								<ItemTitle
									className="block w-full truncate font-normal"
									title={activity.title}
								>
									{activity.title}
								</ItemTitle>
								<ItemDescription className="text-(length:--text-detail) line-clamp-2 leading-(--text-detail--line-height)">
									{activity.detail}
								</ItemDescription>
							</ItemContent>
						</Item>
					))}
				</div>
			) : null}
			{recentActivity.length > 0 ? (
				<div className="flex flex-col">
					<div className="flex h-7 items-center justify-between px-2">
						<span className="text-detail text-muted-foreground">
							Recent work
						</span>
						<Button
							onClick={() =>
								onOpenChat("Summarize my recent Ryu activity.", "Recent work")
							}
							size="xs"
							variant="ghost-muted"
						>
							Ask Ryu
						</Button>
					</div>
					{recentActivity.map((item) => (
						<ActivityPreview
							item={item}
							key={item.id}
							onOpen={() => onOpenActivity(item)}
						/>
					))}
				</div>
			) : activityError ? (
				<QueryErrorPanel
					description="Try again to reload it from this node."
					icon={Activity01Icon}
					onRetry={onRetryActivity}
					title="Recent activity is unavailable"
				/>
			) : null}
			<Button
				aria-label="Open Mission Control"
				className="justify-start gap-2 self-stretch px-2 text-muted-foreground"
				onClick={() =>
					onOpenChat(
						"Give me a Mission Control summary of my recent work.",
						"Mission Control"
					)
				}
				size="sm"
				variant="ghost"
			>
				<HugeiconsIcon className="size-4" icon={Radar01Icon} />
				<span className="flex-1 text-left">Mission Control</span>
				<HugeiconsIcon className="size-3.5" icon={ArrowUpRight01Icon} />
			</Button>
		</div>
	);
}

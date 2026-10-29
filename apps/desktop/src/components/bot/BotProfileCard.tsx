import {
	Activity01Icon,
	ArrowDown01Icon,
	ArrowUp01Icon,
	ArrowUpRight01Icon,
	CheckmarkCircle02Icon,
	Comment01Icon,
	FavouriteIcon,
	Message01Icon,
	PauseIcon,
	PlayIcon,
	Radar01Icon,
	Settings01Icon,
	Shield01Icon,
	Target01Icon,
	ThumbsUpIcon,
	ViewIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Logo } from "@ryu/ui/components/logo.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { TabsSubtle, TabsSubtleItem } from "@ryu/ui/components/tabs-subtle.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type GoalState,
	getGoal,
	pauseGoal,
	resumeGoal,
} from "@ryuhq/core-client/goals.ts";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useApprovals } from "@/src/hooks/useApprovals.ts";
import { type ActivityItem, listActivity } from "@/src/lib/api/activity.ts";
import type { ApprovalRequest } from "@/src/lib/api/approvals.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type BotFeedEngagement,
	type BotFeedPreferences,
	type BotFeedSource,
	feedSourceForActivity,
	filterBotFeed,
	loadBotFeedEngagement,
	loadBotFeedPreferences,
	saveBotFeedEngagement,
	saveBotFeedPreferences,
} from "@/src/lib/bot-feed.ts";
import { useLiveActivities } from "@/src/store/useLiveActivityStore.ts";
import type { Conversation } from "@/types/chat.ts";

type BotProfileTab = "overview" | "approvals" | "goals" | "feed";

const BOT_PROFILE_COLLAPSED_KEY = "ryu:bot-profile-card-collapsed:v1";
const GOAL_QUERY_PREFIX = "bot-profile-goal";

const FEED_SOURCE_LABELS = {
	approvals: "Approvals",
	goals: "Goals",
	notes: "Notes",
	runs: "Work",
	watch: "Watch",
} satisfies Record<BotFeedSource, string>;

const FEED_SOURCE_ICONS = {
	approvals: Shield01Icon,
	goals: Target01Icon,
	notes: Message01Icon,
	runs: Activity01Icon,
	watch: ViewIcon,
} satisfies Record<BotFeedSource, typeof Activity01Icon>;

const FEED_SOURCE_OPTIONS: { id: BotFeedSource; description: string }[] = [
	{ id: "runs", description: "Work Ryu completed or continued" },
	{ id: "approvals", description: "Actions waiting for your decision" },
	{ id: "goals", description: "Goal checks and follow-ups" },
	{ id: "watch", description: "Monitors and things Ryu is watching" },
	{ id: "notes", description: "Notes you or an app added" },
];

function readCollapsed(): boolean {
	try {
		return localStorage.getItem(BOT_PROFILE_COLLAPSED_KEY) === "true";
	} catch {
		return false;
	}
}

function saveCollapsed(collapsed: boolean): void {
	try {
		localStorage.setItem(BOT_PROFILE_COLLAPSED_KEY, String(collapsed));
	} catch {
		// The card remains usable when local storage is unavailable.
	}
}

function statusLabel(status: ApprovalRequest["status"]): string {
	return status === "pending" ? "Waiting for you" : status;
}

function sourceLabel(item: ActivityItem): string {
	return FEED_SOURCE_LABELS[feedSourceForActivity(item)];
}

function sourceIcon(item: ActivityItem): typeof Activity01Icon {
	return FEED_SOURCE_ICONS[feedSourceForActivity(item)];
}

function relativeAge(createdAtSeconds: number): string {
	const delta = Math.max(0, Date.now() - createdAtSeconds * 1000);
	if (delta < 60_000) {
		return "now";
	}
	if (delta < 3_600_000) {
		return `${Math.floor(delta / 60_000)}m`;
	}
	if (delta < 86_400_000) {
		return `${Math.floor(delta / 3_600_000)}h`;
	}
	return `${Math.floor(delta / 86_400_000)}d`;
}

function useBotGoalRows(conversations: Conversation[], target: ApiTarget) {
	const candidates = useMemo(
		() =>
			[...conversations]
				.filter((conversation) => (conversation.messageCount ?? 0) > 0)
				.sort((a, b) => b.updatedAt - a.updatedAt)
				.slice(0, 12),
		[conversations]
	);
	const queries = useQueries({
		queries: candidates.map((conversation) => ({
			queryKey: [
				GOAL_QUERY_PREFIX,
				target.url,
				conversation.id,
				conversation.updatedAt,
			],
			queryFn: () => getGoal(target, conversation.id),
			retry: false,
			staleTime: 30_000,
		})),
	});
	const rows = candidates.flatMap((conversation, index) => {
		const goal = queries[index]?.data;
		if (!(goal?.goal && goal.status)) {
			return [];
		}
		return [
			{
				conversation,
				goal,
			},
		];
	});
	return {
		error: queries.some((query) => query.isError),
		loading: queries.some((query) => query.isPending),
		rows,
		retry: () => Promise.all(queries.map((query) => query.refetch())),
	};
}

function GoalRow({
	conversation,
	goal,
	onOpen,
	onToggle,
	toggling,
}: {
	conversation: Conversation;
	goal: GoalState;
	onOpen: () => void;
	onToggle: () => void;
	toggling: boolean;
}) {
	const achieved = goal.status === "achieved";
	const paused = goal.status === "paused";
	return (
		<div className="flex items-start gap-2 rounded-lg border border-border/60 bg-card/40 p-2">
			<button
				className="mt-0.5 flex min-w-0 flex-1 items-start gap-2 text-left"
				onClick={onOpen}
				type="button"
			>
				<span
					aria-hidden="true"
					className={cn(
						"mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full",
						achieved
							? "bg-success/15 text-status-success"
							: paused
								? "bg-muted text-muted-foreground"
								: "bg-primary/10 text-primary"
					)}
				>
					<HugeiconsIcon
						className="size-3"
						icon={achieved ? CheckmarkCircle02Icon : Target01Icon}
					/>
				</span>
				<span className="min-w-0">
					<span className="line-clamp-2 block font-medium text-xs">
						{goal.goal}
					</span>
					<span className="type-compact mt-0.5 block truncate text-muted-foreground">
						{conversation.title ?? "Untitled chat"}
						{goal.last_reason ? ` · ${goal.last_reason}` : ""}
					</span>
				</span>
			</button>
			{achieved ? (
				<span className="type-compact shrink-0 pt-0.5 text-status-success">
					Done
				</span>
			) : (
				<Button
					aria-label={paused ? "Resume goal" : "Pause goal"}
					className="size-6 shrink-0"
					disabled={toggling}
					onClick={onToggle}
					size="icon"
					variant="ghost"
				>
					{toggling ? (
						<Spinner className="size-3" />
					) : (
						<HugeiconsIcon
							className="size-3.5"
							icon={paused ? PlayIcon : PauseIcon}
						/>
					)}
				</Button>
			)}
		</div>
	);
}

function ApprovalRow({
	approval,
	busy,
	onApprove,
	onReject,
}: {
	approval: ApprovalRequest;
	busy: boolean;
	onApprove: () => void;
	onReject: () => void;
}) {
	return (
		<div className="rounded-lg border border-warning/30 bg-warning/5 p-2.5">
			<div className="flex items-start gap-2">
				<span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-warning/15 text-status-warning">
					<HugeiconsIcon className="size-3.5" icon={Shield01Icon} />
				</span>
				<div className="min-w-0 flex-1">
					<p className="line-clamp-2 font-medium text-xs">{approval.title}</p>
					<p className="type-compact mt-0.5 line-clamp-2 text-muted-foreground">
						{approval.summary ||
							approval.question ||
							statusLabel(approval.status)}
					</p>
				</div>
			</div>
			<div className="mt-2 flex items-center justify-end gap-1.5">
				<Button
					appearance="bot-decision"
					disabled={busy}
					onClick={onReject}
					size="sm"
					variant="ghost"
				>
					Deny
				</Button>
				<Button
					appearance="bot-decision"
					disabled={busy}
					onClick={onApprove}
					size="sm"
				>
					{busy ? <Spinner className="size-3" /> : null}
					Approve
				</Button>
			</div>
		</div>
	);
}

function FeedPreferences({
	preferences,
	onChange,
}: {
	preferences: BotFeedPreferences;
	onChange: (source: BotFeedSource, checked: boolean) => void;
}) {
	return (
		<Popover>
			<PopoverTrigger
				aria-label="Customize feed"
				render={<Button className="size-7" size="icon" variant="ghost" />}
			>
				<HugeiconsIcon className="size-3.5" icon={Settings01Icon} />
			</PopoverTrigger>
			<PopoverContent
				align="end"
				className="w-64"
				sideOffset={8}
				spacing="rail"
			>
				<p className="font-medium text-xs">Customize your feed</p>
				<p className="type-caption mt-1 text-muted-foreground">
					Choose which kinds of agent work show up here.
				</p>
				<div className="mt-3 flex flex-col gap-2">
					{FEED_SOURCE_OPTIONS.map((option) => (
						<label className="flex items-start gap-2" key={option.id}>
							<Checkbox
								aria-label={`Show ${FEED_SOURCE_LABELS[option.id]}`}
								checked={preferences.sources.includes(option.id)}
								onCheckedChange={(checked) =>
									onChange(option.id, checked === true)
								}
							/>
							<span className="min-w-0">
								<span className="block font-medium text-xs">
									{FEED_SOURCE_LABELS[option.id]}
								</span>
								<span className="type-compact block text-muted-foreground">
									{option.description}
								</span>
							</span>
						</label>
					))}
				</div>
			</PopoverContent>
		</Popover>
	);
}

function ActivityPreview({
	item,
	onOpen,
}: {
	item: ActivityItem;
	onOpen: () => void;
}) {
	return (
		<button
			className="flex w-full items-start gap-2 rounded-lg border border-border/60 bg-card/40 p-2 text-left transition-colors hover:bg-muted/60"
			onClick={onOpen}
			type="button"
		>
			<span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
				<HugeiconsIcon className="size-3.5" icon={sourceIcon(item)} />
			</span>
			<span className="min-w-0 flex-1">
				<span className="flex items-center gap-1.5">
					<span className="truncate font-medium text-xs" title={item.title}>
						{item.title}
					</span>
					<span className="type-compact shrink-0 text-muted-foreground">
						{relativeAge(item.created_at)}
					</span>
				</span>
				<span className="type-compact mt-0.5 block truncate text-muted-foreground">
					{item.body || sourceLabel(item)}
				</span>
			</span>
		</button>
	);
}

function FeedPost({
	engagement,
	item,
	onComment,
	onLike,
	onReply,
}: {
	engagement: BotFeedEngagement;
	item: ActivityItem;
	onComment: (comment: string) => void;
	onLike: () => void;
	onReply: () => void;
}) {
	const [commentOpen, setCommentOpen] = useState(false);
	const [draft, setDraft] = useState("");
	const comments = engagement.comments[item.id] ?? [];
	const liked = engagement.liked.includes(item.id);
	const submitComment = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const value = draft.trim();
		if (!value) {
			return;
		}
		onComment(value);
		setDraft("");
	};
	return (
		<article className="rounded-xl border border-border/60 bg-card/40 p-3">
			<header className="flex items-center gap-2">
				<span className="flex size-6 items-center justify-center rounded-full bg-primary/10 text-primary">
					<HugeiconsIcon className="size-3.5" icon={sourceIcon(item)} />
				</span>
				<span className="min-w-0 flex-1">
					<span className="type-caption block font-medium">
						Bot · {sourceLabel(item)}
					</span>
					<span className="type-compact block text-muted-foreground">
						{relativeAge(item.created_at)} ago
					</span>
				</span>
			</header>
			<h4 className="mt-2 font-medium text-xs leading-relaxed">{item.title}</h4>
			{item.body ? (
				<p className="type-caption mt-1 line-clamp-4 text-muted-foreground leading-relaxed">
					{item.body}
				</p>
			) : null}
			<div className="mt-2 flex items-center gap-1 border-border/60 border-t pt-2">
				<Button
					appearance={liked ? "bot-feed-action-liked" : "bot-feed-action"}
					aria-pressed={liked}
					onClick={onLike}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon
						className="size-3.5"
						icon={liked ? ThumbsUpIcon : FavouriteIcon}
					/>
					{liked ? "Liked" : "Like"}
				</Button>
				<Button
					appearance="bot-feed-action"
					aria-expanded={commentOpen}
					onClick={() => setCommentOpen((value) => !value)}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-3.5" icon={Comment01Icon} />
					Comment{comments.length > 0 ? ` · ${comments.length}` : ""}
				</Button>
				<Button
					appearance="bot-feed-action"
					className="ml-auto"
					onClick={onReply}
					size="sm"
					variant="ghost"
				>
					Reply as Ryu
					<HugeiconsIcon className="size-3" icon={ArrowUpRight01Icon} />
				</Button>
			</div>
			{comments.length > 0 ? (
				<div className="mt-2 flex flex-col gap-1">
					{comments.map((comment, index) => (
						<p
							className="type-compact rounded-md bg-muted/70 px-2 py-1.5 text-muted-foreground"
							key={`${item.id}-comment-${index}`}
						>
							{comment}
						</p>
					))}
				</div>
			) : null}
			{commentOpen ? (
				<form className="mt-2 flex gap-1.5" onSubmit={submitComment}>
					<input
						aria-label="Comment on this activity"
						className="type-caption min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1.5 outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
						onChange={(event) => setDraft(event.target.value)}
						placeholder="Leave a note for Ryu"
						value={draft}
					/>
					<Button appearance="bot-feed-submit" size="sm" type="submit">
						Post
					</Button>
				</form>
			) : null}
		</article>
	);
}

function EmptyPanel({
	description,
	icon,
	title,
}: {
	description: string;
	icon: typeof Activity01Icon;
	title: string;
}) {
	return (
		<div className="rounded-lg border border-border/70 border-dashed px-3 py-4 text-center">
			<HugeiconsIcon
				className="mx-auto size-5 text-muted-foreground/70"
				icon={icon}
			/>
			<p className="mt-2 font-medium text-xs">{title}</p>
			<p className="type-compact mt-1 text-muted-foreground leading-relaxed">
				{description}
			</p>
		</div>
	);
}

function QueryErrorPanel({
	description,
	icon,
	onRetry,
	title,
}: {
	description: string;
	icon: typeof Activity01Icon;
	onRetry: () => void;
	title: string;
}) {
	return (
		<div className="rounded-lg border border-border/70 border-dashed px-3 py-4 text-center">
			<HugeiconsIcon
				className="mx-auto size-5 text-muted-foreground/70"
				icon={icon}
			/>
			<p className="mt-2 font-medium text-xs">{title}</p>
			<p className="type-compact mt-1 text-muted-foreground leading-relaxed">
				{description}
			</p>
			<Button
				appearance="bot-retry"
				className="mt-3"
				onClick={onRetry}
				size="sm"
				variant="outline"
			>
				Try again
			</Button>
		</div>
	);
}

function BotProfileContent({
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
					description="The approval queue is unavailable right now. Ryu will keep the action behind the server-side gate."
					icon={Shield01Icon}
					title="Approvals are unavailable"
				/>
			);
		}
		return pendingApprovals.length > 0 ? (
			<div className="flex flex-col gap-2">
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
					<p className="type-compact text-center text-muted-foreground">
						+{pendingApprovals.length - 4} more waiting in the queue
					</p>
				) : null}
			</div>
		) : (
			<EmptyPanel
				description="When an action can’t be undone, it will land here before Ryu continues."
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
					description="Ryu couldn’t load the goals attached to these conversations. Try again to check their latest state."
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
						description="Goals stay attached to the conversations that carry them, so you can keep working without losing the thread."
						icon={Target01Icon}
						title="No goals yet"
					/>
					<Button
						appearance="bot-goal-action"
						className="w-full"
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
			<div className="flex flex-col gap-3">
				{goalError ? (
					<QueryErrorPanel
						description="Some conversation goals couldn’t be loaded. Try again to check their latest state."
						icon={Target01Icon}
						onRetry={onRetryGoals}
						title="Some goals are unavailable"
					/>
				) : null}
				<GoalGroup
					label={`Active · ${activeGoals.length}`}
					onOpen={onOpenGoal}
					onToggle={onToggleGoal}
					rows={activeGoals}
					togglingGoal={togglingGoal}
				/>
				<GoalGroup
					label={`Passive · ${passiveGoals.length}`}
					onOpen={onOpenGoal}
					onToggle={onToggleGoal}
					rows={passiveGoals}
					togglingGoal={togglingGoal}
				/>
				{completedGoals.length > 0 ? (
					<p className="type-compact text-status-success">
						{completedGoals.length} recently completed goal
						{completedGoals.length === 1 ? "" : "s"}
					</p>
				) : null}
			</div>
		);
	}

	if (view === "feed") {
		if (activityError && activity.length === 0) {
			return (
				<QueryErrorPanel
					description="Ryu couldn’t load the activity feed. Try again to reload it from this node."
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
			<div className="flex flex-col gap-2">
				<div className="flex items-center justify-between gap-2">
					<p className="type-compact text-muted-foreground">
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
						description="Change the feed filters above or keep working. New agent updates will appear here as they happen."
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
			<div className="grid grid-cols-3 gap-1.5">
				<SummaryStat label="Working" value={liveActivities.length} />
				<SummaryStat label="Approvals" value={pendingApprovals.length} />
				<SummaryStat label="Goals" value={activeGoals.length} />
			</div>
			{liveActivities.length > 0 ? (
				<div className="flex flex-col gap-1.5">
					<div className="flex items-center gap-1.5 px-0.5">
						<span className="size-1.5 rounded-full bg-primary motion-safe:animate-pulse" />
						<span className="type-compact font-medium text-muted-foreground uppercase tracking-wide">
							Live now
						</span>
					</div>
					{liveActivities.slice(0, 2).map((activity) => (
						<button
							className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 p-2 text-left"
							key={activity.id}
							onClick={() => {
								if (activity.action?.kind === "route") {
									onOpenChat(
										`Continue the work currently shown as “${activity.title}”.`,
										activity.title
									);
								}
							}}
							type="button"
						>
							<span className="mt-0.5 size-2 shrink-0 rounded-full bg-primary" />
							<span className="min-w-0">
								<span
									className="block truncate font-medium text-xs"
									title={activity.title}
								>
									{activity.title}
								</span>
								<span className="type-compact mt-0.5 line-clamp-2 block text-muted-foreground">
									{activity.detail}
								</span>
							</span>
						</button>
					))}
				</div>
			) : null}
			{recentActivity.length > 0 ? (
				<div className="flex flex-col gap-1.5">
					<div className="flex items-center justify-between px-0.5">
						<span className="type-compact font-medium text-muted-foreground uppercase tracking-wide">
							Recent work
						</span>
						<Button
							appearance="bot-summary"
							onClick={() =>
								onOpenChat("Summarize my recent Ryu activity.", "Recent work")
							}
							size="sm"
							variant="ghost"
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
					description="Ryu couldn’t load recent activity. Try again to reload it from this node."
					icon={Activity01Icon}
					onRetry={onRetryActivity}
					title="Recent activity is unavailable"
				/>
			) : null}
			<div className="flex items-center gap-2 rounded-lg border border-border/70 border-dashed px-2.5 py-2">
				<HugeiconsIcon
					className="size-4 text-muted-foreground"
					icon={Radar01Icon}
				/>
				<div className="min-w-0 flex-1">
					<p className="font-medium text-xs">Mission Control, at a glance</p>
					<p className="type-compact mt-0.5 text-muted-foreground">
						Cross-chat summaries and open work stay one conversation away.
					</p>
				</div>
				<Button
					aria-label="Open Mission Control"
					className="size-7 shrink-0"
					onClick={() =>
						onOpenChat(
							"Give me a Mission Control summary of my recent work.",
							"Mission Control"
						)
					}
					size="icon"
					variant="ghost"
				>
					<HugeiconsIcon className="size-3.5" icon={ArrowUpRight01Icon} />
				</Button>
			</div>
		</div>
	);
}

function GoalGroup({
	label,
	onOpen,
	onToggle,
	rows,
	togglingGoal,
}: {
	label: string;
	onOpen: (conversation: Conversation) => void;
	onToggle: (conversationId: string, goal: GoalState) => void;
	rows: { conversation: Conversation; goal: GoalState }[];
	togglingGoal: string | null;
}) {
	if (rows.length === 0) {
		return null;
	}
	return (
		<section className="flex flex-col gap-1.5">
			<h4 className="type-compact px-0.5 font-medium text-muted-foreground uppercase tracking-wide">
				{label}
			</h4>
			{rows.map(({ conversation, goal }) => (
				<GoalRow
					conversation={conversation}
					goal={goal}
					key={conversation.id}
					onOpen={() => onOpen(conversation)}
					onToggle={() => onToggle(conversation.id, goal)}
					toggling={togglingGoal === conversation.id}
				/>
			))}
		</section>
	);
}

function SummaryStat({ label, value }: { label: string; value: number }) {
	return (
		<div className="rounded-lg border border-border/60 bg-card/40 px-2 py-1.5 text-center">
			<div className="font-medium text-sm tabular-nums">{value}</div>
			<div className="type-micro text-muted-foreground">{label}</div>
		</div>
	);
}

export function BotProfileCard({
	conversations,
}: {
	conversations: Conversation[];
}) {
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
			? `${pendingApprovals.length} action${pendingApprovals.length === 1 ? "" : "s"} waiting for you`
			: activeGoals.length > 0
				? `${activeGoals.length} goal${activeGoals.length === 1 ? "" : "s"} in motion`
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
			className="mx-2 mb-2 overflow-hidden rounded-xl border border-border/70 bg-card/70 shadow-sm"
			data-testid="bot-profile-card"
		>
			<div className="flex items-center gap-2 px-2.5 py-2">
				<div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
					<Logo size="18px" variant="outline" />
				</div>
				<div className="min-w-0 flex-1">
					<p className="font-medium text-xs">Bot</p>
					<p
						className="type-compact truncate text-muted-foreground"
						title={statusText}
					>
						{statusText}
					</p>
				</div>
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
					className="size-7 shrink-0"
					onClick={() => setCardCollapsed(!collapsed)}
					size="icon"
					variant="ghost"
				>
					<HugeiconsIcon
						className="size-3.5"
						icon={collapsed ? ArrowDown01Icon : ArrowUp01Icon}
					/>
				</Button>
			</div>
			{collapsed ? null : (
				<div className="scroll-fade max-h-[min(45vh,25rem)] overflow-y-auto border-border/60 border-t px-2.5 py-2.5">
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
					<div className="mt-2.5">
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

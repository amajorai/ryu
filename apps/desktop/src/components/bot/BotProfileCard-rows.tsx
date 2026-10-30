import {
	type Activity01Icon,
	CheckmarkCircle02Icon,
	PauseIcon,
	PlayIcon,
	Shield01Icon,
	Target01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { GoalState } from "@ryuhq/core-client/goals.ts";
import type { ApprovalRequest } from "@/src/lib/api/approvals.ts";
import type { Conversation } from "@/types/chat.ts";
import { statusLabel } from "./BotProfileCard-model.ts";

export function GoalRow({
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
		<div className="group/goal flex items-start gap-2 rounded-lg px-2 py-1.5 transition-colors duration-150 hover:bg-muted hover:duration-0">
			<button
				className="flex min-w-0 flex-1 items-start gap-2 text-left"
				onClick={onOpen}
				type="button"
			>
				<HugeiconsIcon
					aria-hidden="true"
					className={cn(
						"mt-0.5 size-4 shrink-0",
						achieved ? "text-status-success" : "text-muted-foreground"
					)}
					icon={achieved ? CheckmarkCircle02Icon : Target01Icon}
				/>
				<span className="min-w-0">
					<span className="line-clamp-2 block text-sm">{goal.goal}</span>
					<span className="mt-0.5 block truncate text-detail text-muted-foreground">
						{conversation.title ?? "Untitled chat"}
						{goal.last_reason ? ` · ${goal.last_reason}` : ""}
					</span>
				</span>
			</button>
			{achieved ? (
				<span className="shrink-0 pt-0.5 text-muted-foreground text-xs">
					Done
				</span>
			) : (
				<Button
					aria-label={paused ? "Resume goal" : "Pause goal"}
					className={cn(
						"shrink-0 opacity-0 transition-opacity duration-150 group-focus-within/goal:opacity-100 group-hover/goal:opacity-100 group-hover/goal:duration-0",
						(toggling || paused) && "opacity-100"
					)}
					disabled={toggling}
					onClick={onToggle}
					size="icon-xs"
					variant="ghost-muted"
				>
					{toggling ? (
						<Spinner className="size-3.5" />
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

export function ApprovalRow({
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
		<div className="border-border border-b px-2 py-2 last:border-b-0">
			<div className="flex items-start gap-2">
				<HugeiconsIcon
					className="mt-0.5 size-4 shrink-0 text-status-warning"
					icon={Shield01Icon}
				/>
				<div className="min-w-0 flex-1">
					<p className="line-clamp-2 font-medium text-sm">{approval.title}</p>
					<p className="mt-0.5 line-clamp-2 text-detail text-muted-foreground">
						{approval.summary ||
							approval.question ||
							statusLabel(approval.status)}
					</p>
				</div>
			</div>
			<div className="mt-2 flex items-center justify-end gap-2">
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
					variant="mono"
				>
					{busy ? <Spinner className="size-3.5" /> : null}
					Approve
				</Button>
			</div>
		</div>
	);
}

export function EmptyPanel({
	description,
	icon,
	title,
}: {
	description: string;
	icon: typeof Activity01Icon;
	title: string;
}) {
	return (
		<div className="flex items-start gap-2 px-2 py-3">
			<HugeiconsIcon
				className="mt-0.5 size-4 shrink-0 text-muted-foreground"
				icon={icon}
			/>
			<div className="min-w-0">
				<p className="text-sm">{title}</p>
				<p className="mt-0.5 text-detail text-muted-foreground">
					{description}
				</p>
			</div>
		</div>
	);
}

export function QueryErrorPanel({
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
		<div className="flex items-start gap-2 px-2 py-3" role="alert">
			<HugeiconsIcon
				className="mt-0.5 size-4 shrink-0 text-status-destructive"
				icon={icon}
			/>
			<div className="min-w-0 flex-1">
				<p className="text-sm">{title}</p>
				<p className="mt-0.5 text-detail text-muted-foreground">
					{description}
				</p>
			</div>
			<Button onClick={onRetry} size="sm" variant="ghost">
				Try again
			</Button>
		</div>
	);
}

export function GoalGroup({
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
		<section className="flex flex-col gap-0.5">
			<h4 className="flex h-7 items-center px-2 text-detail text-muted-foreground">
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

/** One inline muted line of counts; zero counts are left out. */
export function SummaryLine({
	stats,
}: {
	stats: { text: string; value: number }[];
}) {
	const visible = stats.filter((stat) => stat.value > 0);
	if (visible.length === 0) {
		return null;
	}
	return (
		<p
			className="px-2 text-detail text-muted-foreground tabular-nums"
			data-testid="bot-profile-summary"
		>
			{visible.map((stat) => stat.text).join(" · ")}
		</p>
	);
}

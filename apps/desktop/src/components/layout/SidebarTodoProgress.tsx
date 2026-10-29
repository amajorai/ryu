import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { CSSProperties as LayoutCSSProperties } from "react";
import { useSidebarTodoProgress } from "@/src/hooks/useSidebarTodoProgress.ts";
import type { TodoProgressMessage } from "@/src/lib/todo-progress.ts";
import type { Conversation } from "@/types/chat.ts";
import layoutStyles from "./SidebarTodoProgress.module.css";

export interface SidebarTodoProgressProps {
	/** Only session rows may show the completed-unread celebration. */
	celebrate?: boolean;
	conversation?: Conversation;
	loadMessages?: (
		conversationId: string
	) => Promise<readonly TodoProgressMessage[]>;
	nodeUrl: string;
}

export function SidebarTodoProgress({
	celebrate = false,
	conversation,
	loadMessages,
	nodeUrl,
}: SidebarTodoProgressProps): React.ReactNode {
	const tl = useLiteralMessages();
	const progress = useSidebarTodoProgress({
		conversationId: conversation?.id,
		loadMessages,
		messages:
			conversation && conversation.messages.length > 0
				? conversation.messages
				: undefined,
		nodeUrl,
		revision: conversation?.updatedAt ?? 0,
	});
	if (!(conversation && progress)) {
		return null;
	}

	const label = tl("{completed} of {total} steps complete", {
		completed: progress.completed,
		total: progress.total,
	});
	const showCelebration = celebrate && progress.isComplete;
	const cssVariables1: LayoutCssVariables = {
		"--desktop-inline1-width": `${progress.percentage}%`,
	};
	return (
		<>
			{progress.hasInProgress ? (
				<span
					aria-hidden="true"
					className="t-plan-badge-sheen pointer-events-none absolute inset-0 z-0 opacity-20"
					data-testid="sidebar-todo-sheen"
				/>
			) : null}
			{showCelebration ? (
				<span
					aria-hidden="true"
					className="pointer-events-none absolute inset-0 z-0 overflow-hidden bg-gradient-to-l from-success/20 via-success/10 to-transparent"
					data-testid="sidebar-todo-complete"
				>
					<HugeiconsIcon
						className="absolute top-1/2 right-0 size-9 -translate-y-1/2 text-status-success/15"
						icon={Tick02Icon}
						strokeWidth={3}
					/>
				</span>
			) : null}
			<div
				aria-label={label}
				aria-valuemax={100}
				aria-valuemin={0}
				aria-valuenow={progress.percentage}
				className="pointer-events-none absolute right-2 bottom-0 left-2 z-10 h-0.5 overflow-hidden rounded-full bg-border/60"
				data-testid="sidebar-todo-progress"
				role="progressbar"
			>
				<span
					className={cn(
						cn(
							cn(
								"block h-full rounded-full duration-300 ease-out motion-reduce:transition-none",
								layoutStyles.authored1
							),
							progress.isComplete ? "bg-success" : "bg-primary/80"
						),
						layoutStyles.inline1
					)}
					style={cssVariables1}
				/>
			</div>
		</>
	);
}

interface LayoutCssVariables extends LayoutCSSProperties {
	"--desktop-inline1-width"?: string | number;
}

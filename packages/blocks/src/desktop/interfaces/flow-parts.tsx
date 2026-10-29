import { cn } from "@ryu/ui/lib/utils";
import {
	THREAD_STATUS_LABELS,
	type ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import {
	FolderOpen,
	Inbox,
	MessageSquare,
	MessageSquarePlus,
	User,
	Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { BoardStatusDot } from "./board-status.tsx";
import type { FlowAction, FlowDotTone } from "./flow-model.ts";

/** The status mark on a node's right edge. */
export function FlowDot({
	className,
	tone,
}: {
	className?: string;
	tone: FlowDotTone;
}) {
	if (tone === "idle") {
		return (
			<span
				aria-hidden="true"
				className={cn(
					"inline-block size-2 shrink-0 rounded-full bg-muted-foreground/50",
					className
				)}
			/>
		);
	}
	if (tone === "success") {
		return (
			<span
				aria-hidden="true"
				className={cn(
					"inline-block size-2 shrink-0 rounded-full bg-success",
					className
				)}
			/>
		);
	}
	if (tone === "quiet") {
		// Quiet threads need nothing; a pinpoint keeps the edge aligned without
		// competing with the states that do.
		return (
			<span
				aria-hidden="true"
				className={cn(
					"inline-flex size-2 shrink-0 items-center justify-center",
					className
				)}
			>
				<span className="size-1 rounded-full bg-muted-foreground/45" />
			</span>
		);
	}
	// "working" is the Board's hollow success ring with its pulsing halo, never
	// a solid dot, so it cannot read as "your turn" where primary is green too.
	return <BoardStatusDot className={className} status={tone} />;
}

export function toneLabel(tone: FlowDotTone): string {
	if (tone === "idle") {
		return "Idle";
	}
	if (tone === "success") {
		return "Succeeded";
	}
	return THREAD_STATUS_LABELS[tone as ThreadStatus];
}

/** The small square an action or node kind shows at its left. */
export function FlowActionGlyph({
	action,
	className,
}: {
	action: Pick<FlowAction, "agent" | "icon" | "title">;
	className?: string;
}) {
	let glyph: ReactNode;
	switch (action.icon) {
		case "agent":
			glyph = (
				<BoardAvatar
					agent={action.agent}
					className="size-4.5"
					name={action.agent?.name ?? action.title}
					size={20}
				/>
			);
			break;
		case "team":
			glyph = <Users />;
			break;
		case "project":
			glyph = <FolderOpen />;
			break;
		case "review":
			glyph = <Inbox />;
			break;
		default:
			glyph = <MessageSquarePlus />;
	}
	return (
		<span
			aria-hidden="true"
			className={cn(
				"flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted/60 text-foreground/80 [&_svg]:size-3.5 [&_svg]:stroke-[1.75]",
				className
			)}
		>
			{glyph}
		</span>
	);
}

export function ConversationGlyph({ className }: { className?: string }) {
	return (
		<MessageSquare
			aria-hidden="true"
			className={cn(
				"size-3.5 shrink-0 stroke-[1.75] text-muted-foreground",
				className
			)}
		/>
	);
}

export function TeamGlyph({ className }: { className?: string }) {
	return (
		<Users
			aria-hidden="true"
			className={cn(
				"size-3.5 shrink-0 stroke-[1.75] text-muted-foreground",
				className
			)}
		/>
	);
}

export function OriginGlyph({ className }: { className?: string }) {
	return (
		<User
			aria-hidden="true"
			className={cn("size-4 shrink-0 stroke-[1.75]", className)}
		/>
	);
}

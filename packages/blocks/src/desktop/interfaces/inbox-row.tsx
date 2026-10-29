import { cn } from "@ryu/ui/lib/utils";
import { Pin } from "lucide-react";
import { InboxAgentAvatar } from "./inbox-avatar.tsx";
import type { InboxItem } from "./inbox-model.ts";
import { INBOX_STATUS_META, inboxStatusLabel } from "./inbox-status.tsx";
import { compactAge } from "./interface-renderer.ts";

function spokenAge(age: string): string {
	if (!age) {
		return "";
	}
	return age === "now" ? "updated just now" : `updated ${age} ago`;
}

/**
 * Avatar for the row's lead agent. With nobody on the thread it keeps the
 * same circle, drawn as an empty dashed outline, so every row's avatar
 * column reads alike.
 */
export function InboxItemAvatar({
	item,
	size = "default",
}: {
	item: InboxItem;
	size?: "default" | "sm";
}) {
	if (item.leadAgent) {
		return <InboxAgentAvatar agent={item.leadAgent} size={size} />;
	}
	return (
		<span
			aria-hidden="true"
			className={cn(
				"shrink-0 rounded-full border border-muted-foreground/40 border-dashed",
				size === "sm" ? "size-6" : "size-8"
			)}
			data-slot="inbox-avatar-empty"
		/>
	);
}

/**
 * Unread dot, centred in the row's own 20px left gutter (the row pads 20px
 * on the left), so dot, avatar and title read as three columns and titles
 * line up whether or not the row is unread. Destructive for failures,
 * primary for your turn.
 */
function UnreadDot({ status }: { status: InboxItem["status"] }) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"absolute top-1/2 left-2 size-1.5 -translate-y-1/2 rounded-full",
				status === "attention" ? "bg-status-destructive" : "bg-primary"
			)}
			data-slot="inbox-unread"
		/>
	);
}

/**
 * One triage row: a `listbox` option with roving focus. The listbox owns the
 * keyboard; a click (or Enter/O) opens the thread through the port. Status
 * lives in the sticky section header, so the row only adds unread-style
 * emphasis when the user should act. The keyboard cursor is a light fill;
 * the open row is a full accent fill with a primary rail on the list edge, so
 * it stays findable after focus moves into the conversation.
 */
export function InboxRow({
	cursor,
	item,
	now,
	onFocusRow,
	onOpen,
	open,
	registerRow,
}: {
	cursor: boolean;
	item: InboxItem;
	now: number;
	onFocusRow: (threadId: string) => void;
	onOpen: (threadId: string) => void;
	open: boolean;
	registerRow: (threadId: string, element: HTMLElement | null) => void;
}) {
	const { thread, status, unassigned } = item;
	const meta = INBOX_STATUS_META[status];
	const age = compactAge(thread.updatedAt, now);
	const previewId = `inbox-preview-${thread.id}`;
	const title = thread.title.trim() || "Untitled thread";
	const label = [
		title,
		inboxStatusLabel(status, unassigned),
		unassigned ? "" : item.actorLabel,
		thread.pinned ? "pinned" : "",
		spokenAge(age),
	]
		.filter(Boolean)
		.join(", ");
	// Two greys only: titles are always full foreground and weight alone
	// marks unread (semibold title, medium actor); everything secondary is
	// muted. The open row follows its accent surface.
	const unread = meta.emphasized;
	const primaryTone = open
		? "text-sidebar-accent-foreground"
		: "text-sidebar-foreground";
	const secondaryTone = open
		? "text-sidebar-accent-foreground/70"
		: "text-muted-foreground";
	const titleTone = cn(unread ? "font-semibold" : "font-normal", primaryTone);
	const actorTone = unread ? cn("font-medium", primaryTone) : secondaryTone;
	return (
		<div
			aria-describedby={previewId}
			aria-label={label}
			aria-selected={open}
			className={cn(
				"relative flex cursor-default scroll-mt-10 scroll-mb-2 items-center gap-3 py-2.5 pr-4 pl-5 outline-none focus-visible:before:absolute focus-visible:before:inset-y-0 focus-visible:before:left-0 focus-visible:before:w-0.5 focus-visible:before:bg-ring",
				open
					? "bg-sidebar-accent text-sidebar-accent-foreground before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary"
					: "hover:bg-sidebar-accent/40 focus-visible:bg-sidebar-accent/70"
			)}
			data-inbox-row={thread.id}
			data-open={open ? "" : undefined}
			data-status={status}
			data-testid={`inbox-row-${thread.id}`}
			id={`inbox-row-${thread.id}`}
			onClick={() => onOpen(thread.id)}
			onFocus={() => onFocusRow(thread.id)}
			ref={(element) => registerRow(thread.id, element)}
			role="option"
			tabIndex={cursor ? 0 : -1}
		>
			{unread ? <UnreadDot status={status} /> : null}
			<InboxItemAvatar item={item} size="sm" />
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="flex min-w-0 items-baseline gap-2">
					<span
						className={cn(
							"min-w-0 flex-1 truncate text-sm leading-5",
							titleTone
						)}
					>
						{title}
					</span>
					{thread.pinned ? (
						<Pin
							aria-hidden="true"
							className={cn("size-3.5 shrink-0 self-center", secondaryTone)}
						/>
					) : null}
					<time
						className={cn(
							"shrink-0 text-xs tabular-nums",
							unread ? primaryTone : secondaryTone
						)}
						dateTime={thread.updatedAt}
					>
						{age}
					</time>
				</span>
				<span
					className={cn("truncate text-[13px] leading-[18px]", secondaryTone)}
					id={previewId}
				>
					<span className={actorTone}>{item.actorLabel}</span>
					<span aria-hidden="true"> · </span>
					{item.preview}
				</span>
			</span>
		</div>
	);
}

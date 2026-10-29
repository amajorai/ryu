import { useLiteralMessages } from "@ryu/i18n/react";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceGroup,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { Star } from "lucide-react";
import type { KeyboardEvent } from "react";
import type { MailStatusChip } from "./mail-model.ts";
import { MailLabelChip, MailStatusTag } from "./mail-parts.tsx";

/** One line (Gmail's default list) or stacked (Gmail's split-pane list). */
export type MailDensity = "line" | "stack";

export interface MailRowModel {
	date: string;
	labels: InterfaceGroup[];
	senders: string;
	snippet: string;
	status: MailStatusChip | null;
	subject: string;
	thread: InterfaceThread;
	unread: boolean;
}

function StarMark({ starred }: { starred: boolean }) {
	return (
		<Star
			aria-hidden="true"
			className={cn(
				"size-4.5 shrink-0",
				starred ? "fill-warning text-warning" : "text-foreground/25"
			)}
			data-starred={starred ? "" : undefined}
			strokeWidth={1.75}
		/>
	);
}

function spokenRow(row: MailRowModel): string {
	return [
		row.unread ? "Unread" : "",
		row.thread.pinned ? "Starred" : "",
		`From ${row.senders}`,
		row.subject,
		row.status?.label ?? "",
		row.labels.map((label) => label.name).join(", "),
		row.date,
	]
		.filter(Boolean)
		.join(", ");
}

/**
 * A message-list row. The checkbox is its own control; the rest of the row is
 * one button (the roving-focus target) that opens the conversation, so the
 * list never nests interactive elements.
 */
export function MailRow({
	cursor,
	cursorMarked,
	density,
	onFocusRow,
	onKeyDownRow,
	onOpen,
	onToggleSelected,
	open,
	registerRow,
	row,
	selected,
}: {
	cursor: boolean;
	cursorMarked: boolean;
	density: MailDensity;
	onFocusRow: (threadId: string) => void;
	onKeyDownRow: (event: KeyboardEvent<HTMLElement>, threadId: string) => void;
	onOpen: (threadId: string) => void;
	onToggleSelected: (threadId: string) => void;
	open: boolean;
	registerRow: (threadId: string, element: HTMLElement | null) => void;
	row: MailRowModel;
	selected: boolean;
}) {
	const tl = useLiteralMessages();
	const { thread, unread } = row;
	const strong = unread ? "font-semibold text-foreground" : "font-normal";
	const chips = (
		<>
			{row.status ? <MailStatusTag chip={row.status} /> : null}
			{row.labels.map((label) => (
				<MailLabelChip key={label.id} label={label} />
			))}
		</>
	);
	const date = (
		<time
			className={cn(
				"shrink-0 text-xs tabular-nums",
				unread ? "font-semibold text-foreground" : "text-muted-foreground"
			)}
			dateTime={thread.updatedAt}
		>
			{row.date}
		</time>
	);
	return (
		<li
			className={cn(
				"group/row relative flex border-border/70 border-b transition-[background-color,box-shadow] duration-100",
				"hover:z-10 hover:shadow-[inset_0_-1px_0_0_var(--color-border),0_1px_3px_0_var(--color-border)]",
				"has-[[data-mail-row]:focus-visible]:ring-2 has-[[data-mail-row]:focus-visible]:ring-ring/50 has-[[data-mail-row]:focus-visible]:ring-inset",
				density === "line" ? "h-10 items-center" : "items-start py-2.5",
				open && "bg-primary/10",
				!open && selected && "bg-primary/8",
				!(open || selected) && (unread ? "bg-background" : "bg-muted/45")
			)}
			data-open={open ? "" : undefined}
			data-testid={`mail-row-${thread.id}`}
			data-unread={unread ? "" : undefined}
		>
			{cursor && cursorMarked ? (
				<span
					aria-hidden="true"
					className="absolute inset-y-0 left-0 w-0.5 bg-primary"
					data-cursor=""
				/>
			) : null}
			<span
				className={cn(
					"flex shrink-0 items-center gap-3 pr-3 pl-4",
					density === "line" ? "h-full" : "h-5"
				)}
			>
				<Checkbox
					aria-label={tl("Select {subject}", { subject: row.subject })}
					checked={selected}
					onCheckedChange={() => onToggleSelected(thread.id)}
					tabIndex={-1}
				/>
				<span className="sr-only">
					{thread.pinned ? "Starred" : "Not starred"}
				</span>
				<StarMark starred={thread.pinned} />
			</span>
			<button
				aria-current={open ? "true" : undefined}
				aria-label={spokenRow(row)}
				className={cn(
					"flex min-w-0 flex-1 cursor-default text-left text-sm outline-none",
					density === "line"
						? "h-full items-center gap-3 pr-4"
						: "flex-col gap-0.5 pr-4"
				)}
				data-mail-row={thread.id}
				onClick={() => onOpen(thread.id)}
				onFocus={() => onFocusRow(thread.id)}
				onKeyDown={(event) => onKeyDownRow(event, thread.id)}
				ref={(element) => registerRow(thread.id, element)}
				tabIndex={cursor ? 0 : -1}
				type="button"
			>
				{density === "line" ? (
					<>
						<span
							className={cn(
								"@max-[760px]/list:w-28 w-40 shrink-0 truncate text-foreground",
								strong
							)}
						>
							{row.senders}
							{thread.messageCount > 1 ? (
								<span className="ml-1 font-normal text-muted-foreground text-xs">
									{thread.messageCount}
								</span>
							) : null}
						</span>
						<span className="flex min-w-0 flex-1 items-center gap-1.5">
							{chips}
							<span className="min-w-0 flex-1 truncate">
								<span className={cn("text-foreground", strong)}>
									{row.subject}
								</span>
								<span className="text-muted-foreground"> - {row.snippet}</span>
							</span>
						</span>
						{date}
					</>
				) : (
					<>
						<span className="flex w-full min-w-0 items-baseline gap-2">
							<span
								className={cn(
									"min-w-0 flex-1 truncate text-foreground",
									strong
								)}
							>
								{row.senders}
								{thread.messageCount > 1 ? (
									<span className="ml-1 font-normal text-muted-foreground text-xs">
										{thread.messageCount}
									</span>
								) : null}
							</span>
							{date}
						</span>
						<span className="flex w-full min-w-0 items-center gap-1.5">
							{chips}
							<span
								className={cn(
									"min-w-0 flex-1 truncate text-foreground",
									strong
								)}
							>
								{row.subject}
							</span>
						</span>
						<span className="w-full min-w-0 truncate text-muted-foreground">
							{row.snippet}
						</span>
					</>
				)}
			</button>
		</li>
	);
}

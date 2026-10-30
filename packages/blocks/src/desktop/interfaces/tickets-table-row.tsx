import { useLiteralMessages } from "@ryu/i18n/react";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { ReactNode } from "react";
import { compactAge } from "./interface-renderer.ts";
import {
	type Ticket,
	ticketFullTime,
	ticketStatusHint,
} from "./tickets-model.ts";
import {
	TicketAvatar,
	TicketNumber,
	TicketPriorityLabel,
	TicketSlaChip,
	TicketStatusPill,
	TicketTime,
} from "./tickets-parts.tsx";
import {
	CHECK_WIDTH,
	type Column,
	type ColumnId,
	type TicketsTableLayout,
} from "./tickets-table-columns.ts";

function RequesterCell({ ticket }: { ticket: Ticket }) {
	if (!ticket.requester) {
		return <span className="text-muted-foreground">No requester</span>;
	}
	return (
		<span className="flex min-w-0 items-center gap-2">
			<TicketAvatar agent={ticket.requester} size={20} />
			<span className="truncate">{ticket.requester.name}</span>
			{ticket.ccs.length > 0 ? (
				<span
					className="shrink-0 text-muted-foreground text-xs tabular-nums"
					title={`CC: ${ticket.ccs.map((agent) => agent.name).join(", ")}`}
				>
					+{ticket.ccs.length}
				</span>
			) : null}
		</span>
	);
}

function cellFor(
	id: ColumnId,
	ticket: Ticket,
	now: number,
	subject: ReactNode,
	layout: TicketsTableLayout
): ReactNode {
	switch (id) {
		case "assignee":
			return <span className="text-muted-foreground">You</span>;
		case "number":
			return (
				<TicketNumber
					className="text-muted-foreground"
					number={ticket.number}
				/>
			);
		case "priority":
			return <TicketPriorityLabel priority={ticket.priority} />;
		case "requester":
			return <RequesterCell ticket={ticket} />;
		case "sla":
			return ticket.sla ? <TicketSlaChip sla={ticket.sla} /> : null;
		case "status":
			return (
				<TicketStatusPill
					hint={ticketStatusHint(ticket)}
					status={ticket.status}
				/>
			);
		case "subject":
			return subject;
		default:
			return layout === "compact" ? (
				<time
					className="block text-right text-muted-foreground text-xs tabular-nums"
					dateTime={ticket.thread.updatedAt}
					title={ticketFullTime(ticket.updatedAt)}
				>
					{compactAge(ticket.thread.updatedAt, now)}
				</time>
			) : (
				<TicketTime
					at={ticket.updatedAt}
					className="text-muted-foreground"
					now={now}
				/>
			);
	}
}

/** The compact (phone) row's subject block: subject over its key facts. */
function CompactSubject({
	button,
	ticket,
}: {
	button: ReactNode;
	ticket: Ticket;
}) {
	return (
		<span className="flex min-w-0 flex-col gap-1">
			{button}
			<span className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
				<TicketStatusPill
					hint={ticketStatusHint(ticket)}
					status={ticket.status}
				/>
				<TicketNumber number={ticket.number} />
				<span className="truncate">
					{ticket.requester?.name ?? "No requester"}
				</span>
				{ticket.sla ? <TicketSlaChip sla={ticket.sla} /> : null}
			</span>
		</span>
	);
}
export function TicketRow({
	columns,
	cursor,
	layout,
	now,
	onFocusRow,
	onOpen,
	onToggle,
	open,
	registerRow,
	selected,
	ticket,
}: {
	columns: Column[];
	cursor: boolean;
	layout: TicketsTableLayout;
	now: number;
	onFocusRow: (ticketId: string) => void;
	onOpen: (ticketId: string) => void;
	onToggle: (ticketId: string) => void;
	open: boolean;
	registerRow: (ticketId: string, element: HTMLElement | null) => void;
	selected: boolean;
	ticket: Ticket;
}) {
	const tl = useLiteralMessages();
	const subjectButton = (
		<button
			aria-current={open ? "true" : undefined}
			className="block min-w-0 max-w-full truncate text-left font-medium text-foreground outline-none"
			data-testid={`tickets-row-${ticket.id}`}
			onClick={(event) => {
				event.stopPropagation();
				onOpen(ticket.id);
			}}
			onFocus={() => onFocusRow(ticket.id)}
			ref={(element) => registerRow(ticket.id, element)}
			tabIndex={cursor ? 0 : -1}
			title={ticket.thread.lastMessage ?? undefined}
			type="button"
		>
			{ticket.thread.title || "Untitled ticket"}
		</button>
	);
	const subject =
		layout === "compact" ? (
			<CompactSubject button={subjectButton} ticket={ticket} />
		) : (
			subjectButton
		);
	return (
		<tr
			className={cn(
				"group/row cursor-pointer transition-colors hover:bg-muted/60",
				cursor && "group-focus-within/table:bg-muted/60",
				selected &&
					"bg-primary/10 hover:bg-primary/15 dark:bg-primary/15 dark:hover:bg-primary/20",
				selected &&
					cursor &&
					"group-focus-within/table:bg-primary/15 dark:group-focus-within/table:bg-primary/20",
				layout === "compact" ? "h-16" : "h-10"
			)}
			data-cursor={cursor ? "true" : undefined}
			data-selected={selected ? "true" : undefined}
			data-status={ticket.status}
			onClick={() => onOpen(ticket.id)}
		>
			<td
				className="relative border-border border-b ps-4 pe-0 align-middle"
				style={{ width: CHECK_WIDTH }}
			>
				<span
					aria-hidden="true"
					className={cn(
						"absolute inset-y-0 left-0 w-0.5 bg-primary opacity-0 transition-opacity",
						cursor && "group-focus-within/table:opacity-100"
					)}
				/>
				{/* The cell swallows clicks so checking a ticket never opens it. */}
				{/* biome-ignore lint/a11y/noStaticElementInteractions: click guard around the checkbox */}
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: the checkbox inside handles keys */}
				<span
					className="flex items-center"
					onClick={(event) => event.stopPropagation()}
				>
					<Checkbox
						aria-label={tl("Select ticket #{number}", {
							number: String(ticket.number),
						})}
						checked={selected}
						onCheckedChange={() => {
							onFocusRow(ticket.id);
							onToggle(ticket.id);
						}}
						tabIndex={-1}
					/>
				</span>
			</td>
			{columns.map((column) => (
				<td
					className={cn(
						"border-border border-b px-3 align-middle text-[13px]",
						column.id === "subject" && "max-w-0"
					)}
					key={column.id}
				>
					{cellFor(column.id, ticket, now, subject, layout)}
				</td>
			))}
		</tr>
	);
}

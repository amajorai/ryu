import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { compactAge } from "./interface-renderer.ts";
import {
	TICKET_STATUS_LABELS,
	type Ticket,
	type TicketActivity,
	ticketActivity,
	ticketFullTime,
	ticketStatusHint,
} from "./tickets-model.ts";
import {
	TicketAvatar,
	TicketPriorityLabel,
	TicketSlaChip,
	TicketStatusMark,
	TicketTime,
} from "./tickets-parts.tsx";

function SidebarSection({
	children,
	className,
	title,
}: {
	children: ReactNode;
	className?: string;
	title: string;
}) {
	return (
		<section
			className={cn(
				"flex flex-col gap-3 border-border border-b p-4",
				className
			)}
		>
			<h3 className="font-semibold text-foreground text-xs">{title}</h3>
			{children}
		</section>
	);
}

/** A ticket field shown the way Zendesk draws a locked dropdown. */
function ReadOnlyField({
	children,
	label,
}: {
	children: ReactNode;
	label: string;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<dt className="font-medium text-muted-foreground text-xs">{label}</dt>
			<dd className="flex h-8 min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/30 px-2.5 text-[13px] text-foreground">
				{children}
			</dd>
		</div>
	);
}

function RequesterCard({ ticket }: { ticket: Ticket }) {
	const { requester } = ticket;
	if (!requester) {
		return (
			<p className="text-[13px] text-muted-foreground">
				No agent is on this ticket.
			</p>
		);
	}
	const working = requester.status === "working";
	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center gap-3">
				<TicketAvatar agent={requester} size={40} />
				<div className="flex min-w-0 flex-col gap-0.5">
					<span className="truncate font-medium text-foreground text-sm">
						{requester.name}
					</span>
					<span className="flex items-center gap-1.5 text-muted-foreground text-xs">
						<span
							aria-hidden="true"
							className={cn(
								"size-1.5 rounded-full",
								working ? "bg-success" : "bg-muted-foreground/50"
							)}
						/>
						{working ? "Working now" : "Idle"}
					</span>
				</div>
			</div>
			{requester.description ? (
				<p className="text-[13px] text-muted-foreground leading-5">
					{requester.description}
				</p>
			) : null}
			{ticket.ccs.length > 0 ? (
				<div className="flex min-w-0 items-center gap-2 text-[13px]">
					<span className="shrink-0 text-muted-foreground text-xs">CC</span>
					<span className="flex shrink-0 -space-x-1">
						{ticket.ccs.map((agent) => (
							<TicketAvatar
								agent={agent}
								className="ring-2 ring-background"
								key={agent.id}
								size={20}
							/>
						))}
					</span>
					<span className="truncate text-foreground">
						{ticket.ccs.map((agent) => agent.name).join(", ")}
					</span>
				</div>
			) : null}
		</div>
	);
}

const ACTIVITY_DOT: Record<TicketActivity["tone"], string> = {
	default: "bg-foreground/70",
	destructive: "bg-destructive",
	live: "bg-success",
	muted: "border border-muted-foreground/60 bg-background",
};

function ActivityList({
	items,
	now,
}: {
	items: TicketActivity[];
	now: number;
}) {
	return (
		<ol className="flex flex-col">
			{items.map((item, index) => (
				<li className="relative flex gap-3 pb-3 last:pb-0" key={item.id}>
					{index < items.length - 1 ? (
						<span
							aria-hidden="true"
							className="absolute top-3 bottom-0 left-[3.5px] w-px bg-border"
						/>
					) : null}
					<span
						aria-hidden="true"
						className={cn(
							"relative mt-1.5 size-2 shrink-0 rounded-full",
							ACTIVITY_DOT[item.tone]
						)}
					/>
					<div className="flex min-w-0 flex-col gap-0.5">
						<span
							className={cn(
								"text-[13px]",
								item.tone === "destructive"
									? "text-destructive"
									: "text-foreground"
							)}
						>
							{item.label}
						</span>
						{item.at === null ? (
							<span className="text-muted-foreground text-xs">Now</span>
						) : (
							<TicketTime
								at={item.at}
								className="text-muted-foreground text-xs"
								now={now}
							/>
						)}
					</div>
				</li>
			))}
		</ol>
	);
}

/** The properties sidebar: requester, fields, their other tickets, activity. */
export function TicketsSidebar({
	floating,
	now,
	onClose,
	onOpenTicket,
	others,
	ticket,
}: {
	floating: boolean;
	now: number;
	onClose: () => void;
	onOpenTicket: (ticketId: string) => void;
	others: Ticket[];
	ticket: Ticket;
}) {
	const tl = useLiteralMessages();
	const requesterName = ticket.requester?.name ?? "Requester";
	return (
		<aside
			aria-label="Ticket details"
			className={cn(
				"flex w-80 shrink-0 flex-col overflow-y-auto overscroll-contain border-border border-l bg-background",
				floating && "h-full max-w-full shadow-lg"
			)}
			data-testid="tickets-sidebar"
		>
			{floating ? (
				<div className="flex h-11 shrink-0 items-center justify-between border-border border-b ps-4 pe-2">
					<h2 className="font-semibold text-foreground text-sm">Details</h2>
					<Button
						aria-label="Close details"
						onClick={onClose}
						size="icon-sm"
						type="button"
						variant="ghost-muted"
					>
						<X aria-hidden="true" />
					</Button>
				</div>
			) : (
				<h2 className="sr-only">Details</h2>
			)}
			<SidebarSection title="Requester">
				<RequesterCard ticket={ticket} />
			</SidebarSection>
			<SidebarSection title="Ticket">
				<dl className="flex flex-col gap-3">
					<ReadOnlyField label="Assignee">You</ReadOnlyField>
					<div className="grid grid-cols-2 gap-3">
						<ReadOnlyField label="Status">
							<TicketStatusMark decorative status={ticket.status} />
							<span title={ticketStatusHint(ticket)}>
								{TICKET_STATUS_LABELS[ticket.status]}
							</span>
						</ReadOnlyField>
						<ReadOnlyField label="Priority">
							<TicketPriorityLabel priority={ticket.priority} />
						</ReadOnlyField>
					</div>
					{ticket.sla ? (
						<ReadOnlyField label="Next SLA">
							<TicketSlaChip sla={ticket.sla} />
							<span className="truncate text-muted-foreground text-xs">
								{ticket.sla.longLabel}
							</span>
						</ReadOnlyField>
					) : null}
					<div className="grid grid-cols-2 gap-3">
						<ReadOnlyField label="Project">
							<span
								className={cn(
									"truncate",
									!ticket.project && "text-muted-foreground"
								)}
							>
								{ticket.project?.name ?? "None"}
							</span>
						</ReadOnlyField>
						<ReadOnlyField label="Team">
							<span
								className={cn(
									"truncate",
									!ticket.team && "text-muted-foreground"
								)}
							>
								{ticket.team?.name ?? "None"}
							</span>
						</ReadOnlyField>
					</div>
				</dl>
			</SidebarSection>
			{ticket.requester ? (
				<SidebarSection
					title={tl("Other tickets from {requesterName}", { requesterName })}
				>
					{others.length > 0 ? (
						<ul className="-mx-2 flex flex-col">
							{others.map((other) => (
								<li key={other.id}>
									<button
										className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
										onClick={() => onOpenTicket(other.id)}
										type="button"
									>
										<TicketStatusMark status={other.status} />
										<span className="min-w-0 flex-1 truncate text-foreground">
											{other.thread.title}
										</span>
										<time
											className="shrink-0 text-muted-foreground text-xs tabular-nums"
											dateTime={other.thread.updatedAt}
											title={ticketFullTime(other.updatedAt)}
										>
											{compactAge(other.thread.updatedAt, now)}
										</time>
									</button>
								</li>
							))}
						</ul>
					) : (
						<p className="text-[13px] text-muted-foreground">
							{tl("This is {requesterName}'s only ticket.", { requesterName })}
						</p>
					)}
				</SidebarSection>
			) : null}
			<SidebarSection className="border-b-0" title="Activity">
				<ActivityList items={ticketActivity(ticket, now)} now={now} />
			</SidebarSection>
		</aside>
	);
}

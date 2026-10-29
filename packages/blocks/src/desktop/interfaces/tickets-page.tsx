import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	ChevronDown,
	ChevronUp,
	PanelRight,
	PanelRightClose,
	X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode, RefObject } from "react";
import { compactAge } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";
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
	TicketNumber,
	TicketPriorityLabel,
	TicketSlaChip,
	TicketStatusMark,
	TicketStatusPill,
	TicketTag,
	TicketTime,
} from "./tickets-parts.tsx";

/** Where the open ticket sits in the current view, for previous/next. */
export interface TicketsPosition {
	index: number;
	nextId: string | null;
	previousId: string | null;
	total: number;
}

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
				<SidebarSection title={`Other tickets from ${requesterName}`}>
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
							This is {requesterName}'s only ticket.
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

/**
 * The ticket page: subject, number, tags and requester in the header, the
 * host's own conversation in the centre, and the properties sidebar beside
 * it (or floating over it at narrow widths).
 */
export function TicketsPage({
	detailsFloating,
	detailsOpen,
	headingRef,
	now,
	onClose,
	onCloseDetails,
	onOpenTicket,
	onToggleDetails,
	others,
	position,
	ticket,
	threadView,
}: {
	detailsFloating: boolean;
	detailsOpen: boolean;
	headingRef: RefObject<HTMLHeadingElement | null>;
	now: number;
	onClose: () => void;
	onCloseDetails: () => void;
	onOpenTicket: (ticketId: string) => void;
	onToggleDetails: () => void;
	others: Ticket[];
	position: TicketsPosition | null;
	ticket: Ticket | null;
	threadView: ReactNode;
}) {
	const reduceMotion = useReducedMotion();
	const subject = ticket?.thread.title || "New ticket";
	const messages = ticket?.thread.messageCount ?? 0;
	const sidebar = ticket ? (
		<TicketsSidebar
			floating={detailsFloating}
			now={now}
			onClose={onCloseDetails}
			onOpenTicket={onOpenTicket}
			others={others}
			ticket={ticket}
		/>
	) : null;
	return (
		<section
			aria-labelledby="tickets-page-heading"
			className="flex min-h-0 min-w-0 flex-1 flex-col"
			data-testid="tickets-page"
		>
			<header className="flex shrink-0 flex-col gap-2 border-border border-b px-5 py-3">
				<div className="flex min-w-0 items-center gap-3">
					<TicketStatusPill
						hint={ticket ? ticketStatusHint(ticket) : undefined}
						status={ticket?.status ?? "new"}
					/>
					<h1
						className="min-w-0 truncate font-semibold text-base text-foreground outline-none"
						id="tickets-page-heading"
						ref={headingRef}
						tabIndex={-1}
					>
						{subject}
					</h1>
					{ticket ? (
						<TicketNumber
							className="shrink-0 text-muted-foreground text-sm"
							number={ticket.number}
						/>
					) : null}
					<div className="ms-auto flex shrink-0 items-center gap-1">
						{position && position.total > 1 ? (
							<>
								<span className="me-1 hidden text-muted-foreground text-xs tabular-nums sm:inline">
									{position.index + 1} of {position.total}
								</span>
								<Button
									aria-label="Previous ticket in view"
									disabled={position.previousId === null}
									onClick={() =>
										position.previousId && onOpenTicket(position.previousId)
									}
									size="icon-sm"
									type="button"
									variant="ghost-muted"
								>
									<ChevronUp aria-hidden="true" />
								</Button>
								<Button
									aria-label="Next ticket in view"
									disabled={position.nextId === null}
									onClick={() =>
										position.nextId && onOpenTicket(position.nextId)
									}
									size="icon-sm"
									type="button"
									variant="ghost-muted"
								>
									<ChevronDown aria-hidden="true" />
								</Button>
								<span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
							</>
						) : null}
						{ticket ? (
							<Button
								aria-expanded={detailsOpen}
								aria-label={detailsOpen ? "Hide details" : "Show details"}
								onClick={onToggleDetails}
								size="icon-sm"
								type="button"
								variant="ghost-muted"
							>
								{detailsOpen ? (
									<PanelRightClose aria-hidden="true" />
								) : (
									<PanelRight aria-hidden="true" />
								)}
							</Button>
						) : null}
						<Button
							aria-keyshortcuts="Escape"
							aria-label="Close ticket"
							onClick={onClose}
							size="icon-sm"
							title="Close ticket (Esc)"
							type="button"
							variant="ghost-muted"
						>
							<X aria-hidden="true" />
						</Button>
					</div>
				</div>
				{ticket ? (
					<div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5 text-muted-foreground text-xs">
						<span className="flex min-w-0 items-center gap-1.5">
							<TicketAvatar agent={ticket.requester} size={20} />
							<span className="truncate">
								{ticket.requester ? (
									<>
										Requested by{" "}
										<span className="font-medium text-foreground">
											{ticket.requester.name}
										</span>
									</>
								) : (
									"No requester"
								)}
							</span>
						</span>
						<span>
							Updated <TicketTime at={ticket.updatedAt} now={now} />
						</span>
						<span className="tabular-nums">
							{messages} message{messages === 1 ? "" : "s"}
						</span>
						{ticket.tags.length > 0 ? (
							<ul aria-label="Tags" className="flex min-w-0 flex-wrap gap-1">
								{ticket.tags.map((tag) => (
									<li className="min-w-0" key={tag}>
										<TicketTag>{tag}</TicketTag>
									</li>
								))}
							</ul>
						) : null}
					</div>
				) : null}
			</header>
			<div className="relative flex min-h-0 flex-1">
				<div
					className="flex min-h-0 min-w-0 flex-1 flex-col"
					data-testid="tickets-thread-view"
				>
					{threadView}
				</div>
				{detailsFloating ? (
					<AnimatePresence initial={false}>
						{detailsOpen && sidebar ? (
							<motion.div
								animate={{ opacity: 1, x: 0 }}
								className="absolute inset-y-0 right-0 z-20 flex max-w-full"
								exit={{ opacity: 0, x: reduceMotion ? 0 : 24 }}
								initial={{ opacity: 0, x: reduceMotion ? 0 : 24 }}
								key="details"
								transition={{
									duration: reduceMotion ? 0 : 0.18,
									ease: [0.2, 0, 0, 1],
								}}
							>
								{sidebar}
							</motion.div>
						) : null}
					</AnimatePresence>
				) : null}
				{!detailsFloating && detailsOpen ? sidebar : null}
			</div>
		</section>
	);
}

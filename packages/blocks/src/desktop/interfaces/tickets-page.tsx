import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	ChevronDown,
	ChevronUp,
	PanelRight,
	PanelRightClose,
	X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode, RefObject } from "react";
import { useReducedMotion } from "./reduced-motion.ts";
import { type Ticket, ticketStatusHint } from "./tickets-model.ts";
import { TicketsSidebar } from "./tickets-page-sidebar.tsx";
import {
	TicketAvatar,
	TicketNumber,
	TicketStatusPill,
	TicketTag,
	TicketTime,
} from "./tickets-parts.tsx";

export { TicketsSidebar } from "./tickets-page-sidebar.tsx";

/** Where the open ticket sits in the current view, for previous/next. */
export interface TicketsPosition {
	index: number;
	nextId: string | null;
	previousId: string | null;
	total: number;
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
	const tl = useLiteralMessages();
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
							{tl(
								"{count, plural, one {{countText} message} other {{countText} messages}}",
								{ count: messages, countText: String(messages) }
							)}
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

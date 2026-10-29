import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import {
	DitherAvatar,
	ditherAvatarSeed,
} from "@ryu/ui/components/dither-kit/avatar.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import type { ReactNode } from "react";
import {
	TICKET_PRIORITY_LABELS,
	TICKET_STATUS_HINTS,
	TICKET_STATUS_LABELS,
	type TicketPriority,
	type TicketSla,
	type TicketStatus,
	ticketFullTime,
	ticketTimeLabel,
} from "./tickets-model.ts";

export type TicketAvatarSize = 20 | 24 | 32 | 40;

const AVATAR_SIZE: Record<TicketAvatarSize, string> = {
	20: "size-5",
	24: "size-6",
	32: "size-8",
	40: "size-10",
};

/**
 * An agent's picture, or the generative dither tile the rest of Ryu falls
 * back to (seeded by id). Decorative: the row or card beside it names the
 * agent. A missing requester gets a quiet empty disc.
 */
export function TicketAvatar({
	agent,
	className,
	size,
}: {
	agent: InterfaceAgent | null;
	className?: string;
	size: TicketAvatarSize;
}) {
	if (!agent) {
		return (
			<span
				aria-hidden="true"
				className={cn(
					"inline-block shrink-0 rounded-full border border-border border-dashed",
					AVATAR_SIZE[size],
					className
				)}
			/>
		);
	}
	const seed = ditherAvatarSeed({ id: agent.id, name: agent.name });
	return (
		<Avatar
			aria-hidden="true"
			className={cn(AVATAR_SIZE[size], "shrink-0", className)}
		>
			{agent.avatarUrl ? <AvatarImage alt="" src={agent.avatarUrl} /> : null}
			<AvatarFallback appearance="artwork" className="overflow-hidden bg-muted">
				<DitherAvatar animate={false} className="size-full" name={seed} />
			</AvatarFallback>
		</Avatar>
	);
}

/** Zendesk's status colors, mapped onto the user's theme tokens. */
const STATUS_FILL: Record<TicketStatus, string> = {
	new: "bg-warning text-warning-foreground",
	open: "bg-destructive text-background",
	pending: "bg-primary text-primary-foreground",
	solved: "bg-muted-foreground text-background",
};

/** The status pill the table and the ticket header use. */
export function TicketStatusPill({
	className,
	hint,
	status,
}: {
	className?: string;
	/** Overrides the status's default hint (see `ticketStatusHint`). */
	hint?: string;
	status: TicketStatus;
}) {
	return (
		<span
			className={cn(
				"inline-flex h-5 shrink-0 items-center rounded-sm px-1.5 font-semibold text-[11px] leading-none tracking-wide",
				STATUS_FILL[status],
				className
			)}
			data-status={status}
			title={hint ?? TICKET_STATUS_HINTS[status]}
		>
			{TICKET_STATUS_LABELS[status]}
		</span>
	);
}

/**
 * The one-letter status square Zendesk puts on ticket tabs and in compact
 * lists. The letter is decorative; the accessible text says the status.
 */
export function TicketStatusMark({
	className,
	decorative = false,
	status,
}: {
	className?: string;
	/** Hide it from assistive tech when a label beside it says the status. */
	decorative?: boolean;
	status: TicketStatus;
}) {
	return (
		<span
			aria-hidden={decorative ? "true" : undefined}
			className={cn(
				"inline-flex size-4 shrink-0 items-center justify-center rounded-[3px] font-bold text-[10px] leading-none",
				STATUS_FILL[status],
				className
			)}
			data-status={status}
		>
			<span aria-hidden="true">{TICKET_STATUS_LABELS[status].charAt(0)}</span>
			{decorative ? null : (
				<span className="sr-only">{TICKET_STATUS_LABELS[status]}</span>
			)}
		</span>
	);
}

const PRIORITY_TEXT: Record<TicketPriority, string> = {
	high: "font-medium text-foreground",
	low: "text-muted-foreground",
	normal: "text-foreground",
	urgent: "font-semibold text-destructive",
};

/** Priority as plain text, the way help desks print it. */
export function TicketPriorityLabel({
	priority,
}: {
	priority: TicketPriority;
}) {
	return (
		<span className={PRIORITY_TEXT[priority]} data-priority={priority}>
			{TICKET_PRIORITY_LABELS[priority]}
		</span>
	);
}

const SLA_FILL: Record<TicketSla["state"], string> = {
	breached: "bg-destructive text-background",
	"due-soon": "bg-warning text-warning-foreground",
	"on-track": "bg-muted text-foreground",
};

/** The next-reply SLA chip: time left, or how long ago it was breached. */
export function TicketSlaChip({ sla }: { sla: TicketSla }) {
	return (
		<span
			className={cn(
				"inline-flex h-5 items-center rounded-sm px-1.5 font-semibold text-[11px] tabular-nums leading-none",
				SLA_FILL[sla.state]
			)}
			data-sla={sla.state}
			title={sla.longLabel}
		>
			<span aria-hidden="true">{sla.label}</span>
			<span className="sr-only">{sla.longLabel}</span>
		</span>
	);
}

/** A time in help-desk form, with the full date on hover. */
export function TicketTime({
	at,
	className,
	now,
}: {
	at: number;
	className?: string;
	now: number;
}) {
	if (at === 0) {
		return null;
	}
	return (
		<time
			className={className}
			dateTime={new Date(at).toISOString()}
			title={ticketFullTime(at)}
		>
			{ticketTimeLabel(at, now)}
		</time>
	);
}

/** A Zendesk tag: lowercase, underscored, in a flat grey chip. */
export function TicketTag({ children }: { children: ReactNode }) {
	return (
		<span className="inline-flex h-5 max-w-full items-center truncate rounded-sm bg-muted px-1.5 text-[11px] text-muted-foreground leading-none">
			{children}
		</span>
	);
}

/** The ticket number after a "#", in tabular figures. */
export function TicketNumber({
	className,
	number,
}: {
	className?: string;
	number: number;
}) {
	return <span className={cn("tabular-nums", className)}>#{number}</span>;
}

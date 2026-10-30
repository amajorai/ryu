/**
 * Tickets view model. The implementation is split by responsibility across
 * `tickets-model-base.ts` (statuses, SLA, building tickets),
 * `tickets-model-views.ts` (views, filter, sort, group), and
 * `tickets-model-activity.ts` (activity and time labels); this module keeps
 * the public import path stable.
 */

export {
	type TicketActivity,
	ticketActivity,
	ticketCountLabel,
	ticketFullTime,
	ticketTimeLabel,
} from "./tickets-model-activity.ts";
export {
	buildTickets,
	compactDuration,
	TICKET_ATTENTION_HINT,
	TICKET_PRIORITY_LABELS,
	TICKET_PRIORITY_ORDER,
	TICKET_SLA_TARGET_MS,
	TICKET_SOLVE_AFTER_MS,
	TICKET_STATUS_HINTS,
	TICKET_STATUS_LABELS,
	TICKET_STATUS_ORDER,
	type Ticket,
	type TicketPriority,
	type TicketSla,
	type TicketSlaState,
	type TicketStatus,
	ticketNumbers,
	ticketPriorityOf,
	ticketSla,
	ticketStatusHint,
	ticketStatusOf,
	ticketTag,
} from "./tickets-model-base.ts";
export {
	DEFAULT_TICKET_SORT,
	DEFAULT_TICKET_VIEW,
	EMPTY_TICKET_FILTER,
	findTicketView,
	groupTickets,
	matchesTicketFilter,
	matchesTicketQuery,
	NO_REQUESTER_ID,
	requesterTickets,
	sortTickets,
	TICKET_RECENT_MS,
	TICKET_SORT_FIRST_DIRECTION,
	TICKET_VIEWS,
	type TicketFilter,
	type TicketGroupBy,
	type TicketSection,
	type TicketSort,
	type TicketSortKey,
	type TicketView,
	type TicketViewId,
	ticketFilterCount,
	ticketViewCounts,
	ticketViewRows,
} from "./tickets-model-views.ts";

// apps/desktop/src/components/inbox/InboxCenter-labels.ts
//
// The Inbox tray's header status and empty-state copy. Split out of
// InboxCenter.tsx.

import type { LiteralMessage } from "@ryu/i18n/react";
import {
	type NotificationFilter,
	notificationFilterLabel,
} from "@ryu/ui/lib/notification-filters.tsx";

/** The tray's empty-state title for the active filter. */
export function inboxEmptyTitle(
	activeNotificationFilter: NotificationFilter,
	tl: LiteralMessage
): string {
	return activeNotificationFilter === "all" ||
		activeNotificationFilter === "unread"
		? "You're all caught up"
		: tl("No {label} notifications", {
				label: notificationFilterLabel(activeNotificationFilter).toLowerCase(),
			});
}

/** The tray's empty-state description for the active filter. */
export function inboxEmptyDescription(
	activeNotificationFilter: NotificationFilter,
	showAnnouncements: boolean,
	tl: LiteralMessage
): string {
	return activeNotificationFilter === "archived"
		? "Rows you archive will stay here until you restore them."
		: activeNotificationFilter !== "all" &&
				activeNotificationFilter !== "unread"
			? tl("No {label} notifications yet.", {
					label: notificationFilterLabel(
						activeNotificationFilter
					).toLowerCase(),
				})
			: showAnnouncements
				? "Approvals, tasks, app notifications, and announcements share this space."
				: "Approvals, task check-offs, and app notifications land here when Ryu needs a decision.";
}

/** The tray header's status line. */
export function inboxTrayStatus(
	riskyCount: number,
	decisionCount: number,
	totalCount: number
): string | undefined {
	let status: string | undefined;
	if (riskyCount > 0) {
		status = `${riskyCount} flagged risky`;
	} else if (decisionCount > 0) {
		status = "Waiting on you";
	} else if (totalCount > 0) {
		status = `${totalCount} new`;
	}
	return status;
}

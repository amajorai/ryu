// apps/desktop/src/components/inbox/InboxCenter-sections.tsx
//
// The split layout's tray body (approvals, task suggestions, notifications,
// announcements) for the Inbox tray. Split out of InboxCenter.tsx.

import {
	NotificationStack,
	type NotificationStackItem,
} from "@ryu/ui/components/notification-stack.tsx";
import { isArchivedNotification } from "@ryu/ui/lib/notification-filters.tsx";
import {
	TrayScroll,
	TraySectionLabel,
} from "@/src/components/shell/TrayPopover.tsx";
import {
	ApprovalRow,
	NotificationTrayRow,
	SuggestionRow,
} from "./InboxCenter-rows.tsx";
import {
	type buildInboxStackItems,
	PREVIEW_LIMIT,
} from "./InboxCenter-stack-items.tsx";

/** What the inbox tray's row builders read from `InboxCenter`. */
export type InboxRowContext = Parameters<typeof buildInboxStackItems>[0];

/** The split layout's tray body: approvals, tasks, notifications, announcements. */
export function InboxTraySections({
	announcementCount,
	announcementStackItems,
	context,
	filteredNotificationCount,
	onRefresh,
	showAnnouncements,
}: {
	announcementCount: number;
	announcementStackItems: NotificationStackItem[];
	context: InboxRowContext;
	filteredNotificationCount: number;
	onRefresh: () => Promise<void>;
	showAnnouncements: boolean;
}) {
	const {
		appsById,
		approvals,
		decideApproval,
		decideQuest,
		decidingApprovals,
		decidingQuest,
		notifications,
		openInbox,
		openNotification,
		pending,
		previewNotifications,
		quests,
		taskSuggestions,
	} = context;
	return (
		<TrayScroll onRefresh={onRefresh}>
			{pending.length > 0 && (
				<>
					<TraySectionLabel count={pending.length}>Approvals</TraySectionLabel>
					{pending.slice(0, PREVIEW_LIMIT).map((approval) => (
						<ApprovalRow
							approval={approval}
							busy={
								approvals.deciding === approval.id ||
								decidingApprovals.has(approval.id)
							}
							key={approval.id}
							onApprove={() => {
								decideApproval(approval.id, approvals.approve);
							}}
							onOpen={openInbox}
							onReject={() => {
								decideApproval(approval.id, approvals.reject);
							}}
						/>
					))}
				</>
			)}
			{taskSuggestions.length > 0 && (
				<>
					<TraySectionLabel count={taskSuggestions.length}>
						Tasks
					</TraySectionLabel>
					{taskSuggestions.slice(0, PREVIEW_LIMIT).map((quest) => (
						<SuggestionRow
							busy={decidingQuest === quest.id}
							key={quest.id}
							onAccept={() => decideQuest(quest.id, quests.acceptSuggestion)}
							onDismiss={() => decideQuest(quest.id, quests.dismissSuggestion)}
							onOpen={openInbox}
							quest={quest}
						/>
					))}
				</>
			)}
			{previewNotifications.length > 0 && (
				<>
					<TraySectionLabel count={filteredNotificationCount}>
						Notifications
					</TraySectionLabel>
					{previewNotifications.map((notification) => (
						<NotificationTrayRow
							appsById={appsById}
							archived={isArchivedNotification(notification)}
							key={notification.id}
							notification={notification}
							notifications={notifications}
							onOpen={() => openNotification(notification)}
						/>
					))}
				</>
			)}
			{showAnnouncements && announcementCount > 0 && (
				<>
					<TraySectionLabel count={announcementCount}>
						Announcements
					</TraySectionLabel>
					<NotificationStack
						className="max-w-none"
						collapsedLabel="Announcements"
						expandedLabel="Announcements"
						items={announcementStackItems}
						maxVisible={PREVIEW_LIMIT}
					/>
				</>
			)}
		</TrayScroll>
	);
}

// apps/desktop/src/components/inbox/InboxCenter-stack-items.tsx
//
// Builds the unified-layout NotificationStack items (approvals, task
// suggestions, notifications) for the Inbox tray. Split out of InboxCenter.tsx.

import {
	Archive01Icon,
	ArchiveRestoreIcon,
	CheckListIcon,
	Notification01Icon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import type { LiteralMessage } from "@ryu/i18n/react";
import AppIcon from "@ryu/marketplace/catalog/chrome/app-icon";
import type { NotificationStackItem } from "@ryu/ui/components/notification-stack.tsx";
import {
	isArchivedNotification,
	isUnreadNotification,
} from "@ryu/ui/lib/notification-filters.tsx";
import { riskTagLabel } from "@ryuhq/protocol/interfaces";
import {
	TrayIconAction,
	TrayRowIcon,
	trayMeta,
} from "@/src/components/shell/TrayPopover.tsx";
import type { useApprovals } from "@/src/hooks/useApprovals.ts";
import type { useNotifications } from "@/src/hooks/useNotifications.ts";
import type { useQuests } from "@/src/hooks/useQuests.ts";
import type { ApprovalRequest } from "@/src/lib/api/approvals.ts";
import type { AppNotification } from "@/src/lib/api/notifications.ts";
import type { AppInfo } from "@/src/lib/api/plugins.ts";
import type { Quest } from "@/src/lib/api/quests.ts";
import {
	DecisionStackActions,
	type InboxDecisionResult,
	KIND_ICON,
	shortAgo,
} from "./InboxCenter-rows.tsx";

/** How many of each group the tray previews before deferring to the full page. */
export const PREVIEW_LIMIT = 6;

export function buildInboxStackItems({
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
	tl,
}: {
	appsById: Map<string, AppInfo>;
	approvals: ReturnType<typeof useApprovals>;
	decideApproval: (
		id: string,
		run: ReturnType<typeof useApprovals>["approve"]
	) => InboxDecisionResult;
	decideQuest: (
		id: string,
		run: ReturnType<typeof useQuests>["acceptSuggestion"]
	) => InboxDecisionResult;
	decidingApprovals: Set<string>;
	decidingQuest: string | null;
	notifications: ReturnType<typeof useNotifications>;
	openInbox: () => void;
	openNotification: (notification: AppNotification) => void;
	pending: ApprovalRequest[];
	previewNotifications: AppNotification[];
	quests: ReturnType<typeof useQuests>;
	taskSuggestions: Quest[];
	tl: LiteralMessage;
}): {
	approvalStackItems: NotificationStackItem[];
	notificationStackItems: NotificationStackItem[];
	taskStackItems: NotificationStackItem[];
} {
	const approvalStackItems: NotificationStackItem[] = pending
		.slice(0, PREVIEW_LIMIT)
		.map((approval) => {
			const busy =
				approvals.deciding === approval.id ||
				decidingApprovals.has(approval.id);
			return {
				accent:
					approval.risk_tags.length > 0 ? "var(--destructive)" : undefined,
				actions: (
					<DecisionStackActions
						busy={busy}
						confirmLabel="Approve"
						declineLabel="Reject"
						declineTone="danger"
						onConfirm={() => decideApproval(approval.id, approvals.approve)}
						onDecline={() => decideApproval(approval.id, approvals.reject)}
						pendingLabel="Approval decision pending"
					/>
				),
				ariaLabel: tl("Open {title} in the inbox", { title: approval.title }),
				description: trayMeta(
					...approval.risk_tags.slice(0, 2).map(riskTagLabel),
					approval.summary
				),
				id: `approval:${approval.id}`,
				leading: (
					<TrayRowIcon icon={KIND_ICON[approval.kind] ?? Wrench01Icon} />
				),
				onActivate: openInbox,
				title: approval.title,
				trailing: shortAgo(approval.created_at),
			};
		});

	const taskStackItems: NotificationStackItem[] = taskSuggestions
		.slice(0, PREVIEW_LIMIT)
		.map((quest) => ({
			actions: (
				<DecisionStackActions
					busy={decidingQuest === quest.id}
					confirmLabel="Done"
					declineLabel="Not yet"
					onConfirm={() => decideQuest(quest.id, quests.acceptSuggestion)}
					onDecline={() => decideQuest(quest.id, quests.dismissSuggestion)}
					pendingLabel="Task suggestion decision pending"
				/>
			),
			ariaLabel: tl("Open {title} in the inbox", { title: quest.title }),
			description: quest.suggestion?.reason,
			id: `task:${quest.id}`,
			leading: <TrayRowIcon icon={CheckListIcon} />,
			onActivate: openInbox,
			title: tl("Finished “{title}”?", { title: quest.title }),
		}));

	const notificationStackItems: NotificationStackItem[] =
		previewNotifications.map((notification) => {
			const archived = isArchivedNotification(notification);
			const app = notification.source_app_id
				? (appsById.get(notification.source_app_id) ?? null)
				: null;
			return {
				actions: (
					<span className="relative z-20">
						<TrayIconAction
							icon={archived ? ArchiveRestoreIcon : Archive01Icon}
							label={archived ? "Restore to inbox" : "Archive"}
							onClick={() => {
								const action = archived
									? notifications.unarchive(notification.id)
									: notifications.archive(notification.id);
								// useNotifications' mutation onError already toasts the failure.
								action.catch(() => undefined);
							}}
						/>
					</span>
				),
				ariaLabel: tl("Open {title} in the inbox", {
					title: notification.title,
				}),
				description: trayMeta(
					app?.name ?? "Ryu",
					notification.body ?? undefined,
					shortAgo(notification.created_at)
				),
				id: `notification:${notification.id}`,
				leading: app ? (
					<AppIcon
						className="size-7"
						dither={app.iconDither}
						iconBackground={app.iconBackground ?? undefined}
						iconId={app.icon}
						iconPadding={app.iconPadding}
						iconUrl={app.iconUrl}
						name={app.name}
						presentation="inbox"
						seedId={app.id}
						size={14}
					/>
				) : (
					<TrayRowIcon icon={Notification01Icon} />
				),
				onActivate: () => openNotification(notification),
				title: notification.title,
				trailing: shortAgo(notification.created_at),
				unread: isUnreadNotification(notification),
			};
		});
	return { approvalStackItems, notificationStackItems, taskStackItems };
}

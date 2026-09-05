// apps/desktop/src/components/inbox/InboxCenter.tsx
//
// The Inbox tray — a preview of everything awaiting a decision (pending HITL
// approvals plus the quest engine's check-off suggestions) hung off the sidebar
// footer, with an "Open inbox" action that jumps to the full Inbox tab.
//
// It ALSO previews the per-user notification feed (`useNotifications`) — the
// notification rows that apps and workflows push to the user. The tray defaults
// to unread rows, and the pills can switch it to all, archived, or a level.
// Each notification row
// shows the SENDING APP'S icon (resolved from the app catalog by
// `source_app_id`, so a monitor alert reads as the Monitors app, a reply as
// Outpost), and carries an archive action. Clicking the row marks it read and
// opens the full Inbox, where the read/unread/archived views live.
//
// Rows are actionable: approve/reject an approval, accept/dismiss a task
// suggestion, or archive a notification, without leaving the tray — the same
// mutations the full Inbox drives (useApprovals / useQuests / useNotifications),
// so the two surfaces never disagree. The affirmative action is a labelled pill,
// not a bare tick: this is the one surface in the app where mistaking "reject"
// for "approve" actually costs something. Clicking the row body opens the full
// Inbox; the popover is controlled so those clicks dismiss it.
//
// Chrome comes from TrayPopover (TrayMorph + shared row/header primitives),
// matching the Downloads tray so both read as the same object.

import {
	Archive01Icon,
	ArchiveRestoreIcon,
	Calendar04Icon,
	Cancel01Icon,
	CheckListIcon,
	InboxIcon,
	Notification01Icon,
	Pulse01Icon,
	SparklesIcon,
	WorkflowCircle06Icon,
	Wrench01Icon,
	ZapIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import AppIcon from "@ryu/marketplace/catalog/chrome/app-icon";
import {
	NotificationStack,
	type NotificationStackItem,
} from "@ryu/ui/components/notification-stack";
import {
	filterNotifications,
	isArchivedNotification,
	isUnreadNotification,
	type NotificationFilter,
	NotificationFilterTabs,
	notificationFilterLabel,
} from "@ryu/ui/lib/notification-filters.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { NotificationBell } from "@/components/ui/notification-bell.tsx";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { AnnouncementDetailDialog } from "@/src/components/notifications/announcement-detail-dialog.tsx";
import {
	TrayAction,
	TrayEmpty,
	TrayFooter,
	TrayHeader,
	TrayIconAction,
	TrayMorph,
	TrayRow,
	TrayRowIcon,
	TrayScroll,
	TraySectionLabel,
	trayMeta,
} from "@/src/components/shell/TrayPopover.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAnnouncementDialog } from "@/src/hooks/useAnnouncementDialog.ts";
import { useAnnouncements } from "@/src/hooks/useAnnouncements.ts";
import { useApprovals } from "@/src/hooks/useApprovals.ts";
import { installedAppsQuery } from "@/src/hooks/useAppsCatalog.ts";
import { useNotifications } from "@/src/hooks/useNotifications.ts";
import { useQuests } from "@/src/hooks/useQuests.ts";
import { useSystemAnnouncements } from "@/src/hooks/useSystemAnnouncements.ts";
import type { ApprovalKind, ApprovalRequest } from "@/src/lib/api/approvals.ts";
import type { AppNotification } from "@/src/lib/api/notifications.ts";
import type { AppInfo } from "@/src/lib/api/plugins.ts";
import type { Quest } from "@/src/lib/api/quests.ts";
import type { NotificationLayout } from "@/src/lib/notification-layout.ts";
import { buildAnnouncementStackItems } from "../notifications/announcement-stack-items.tsx";

/** How many of each group the tray previews before deferring to the full page. */
const PREVIEW_LIMIT = 6;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** A glyph per approval kind so the list scans by shape, not just by text. */
const KIND_ICON: Record<ApprovalKind, IconSvgElement> = {
	tool_call: Wrench01Icon,
	workflow_gate: WorkflowCircle06Icon,
	scheduled_run: Calendar04Icon,
	trigger_run: ZapIcon,
	skill_synthesis: SparklesIcon,
	heal_fix: Pulse01Icon,
};

/** Short "2m"/"3h"/"5d" stamp — the tray has no room for a full timestamp. */
function shortAgo(value: string | null | undefined): string | null {
	if (!value) {
		return null;
	}
	const at = new Date(value).getTime();
	if (Number.isNaN(at)) {
		return null;
	}
	const delta = Date.now() - at;
	if (delta < MINUTE_MS) {
		return "now";
	}
	if (delta < HOUR_MS) {
		return `${Math.floor(delta / MINUTE_MS)}m`;
	}
	if (delta < DAY_MS) {
		return `${Math.floor(delta / HOUR_MS)}h`;
	}
	return `${Math.floor(delta / DAY_MS)}d`;
}

/** Risk tags read as `network_access`; the meta line reads `network access`. */
function tagLabel(tag: string): string {
	return tag.replace(/[_-]+/g, " ");
}

function ApprovalRow({
	approval,
	busy,
	onApprove,
	onOpen,
	onReject,
}: {
	approval: ApprovalRequest;
	busy: boolean;
	onApprove: () => void;
	onOpen: () => void;
	onReject: () => void;
}) {
	const risky = approval.risk_tags.length > 0;
	return (
		<TrayRow
			actions={
				<>
					<TrayIconAction
						icon={Cancel01Icon}
						label="Reject"
						onClick={onReject}
						tone="danger"
					/>
					<TrayAction label="Approve" onClick={onApprove} tone="success" />
				</>
			}
			busy={busy}
			icon={KIND_ICON[approval.kind] ?? Wrench01Icon}
			// Risk is carried by the red glyph plus the leading meta segments; the
			// old red chips stacked a third line onto every risky row and turned the
			// list into a wall of pink.
			meta={trayMeta(
				...approval.risk_tags.slice(0, 2).map(tagLabel),
				approval.summary
			)}
			onOpen={onOpen}
			openLabel={`Open ${approval.title} in the inbox`}
			title={approval.title}
			tone={risky ? "danger" : "default"}
			trailing={shortAgo(approval.created_at)}
		/>
	);
}

function SuggestionRow({
	busy,
	onAccept,
	onDismiss,
	onOpen,
	quest,
}: {
	busy: boolean;
	onAccept: () => void;
	onDismiss: () => void;
	onOpen: () => void;
	quest: Quest;
}) {
	return (
		<TrayRow
			actions={
				<>
					<TrayIconAction
						icon={Cancel01Icon}
						label="Not yet"
						onClick={onDismiss}
					/>
					<TrayAction label="Done" onClick={onAccept} tone="success" />
				</>
			}
			busy={busy}
			icon={CheckListIcon}
			meta={quest.suggestion?.reason}
			onOpen={onOpen}
			openLabel={`Open ${quest.title} in the inbox`}
			title={`Finished “${quest.title}”?`}
		/>
	);
}

/**
 * One unread inbox notification. The lead tile is the SENDING app's icon when the
 * row carries a `source_app_id` we can resolve (so a monitor alert reads as the
 * Monitors app, a reply as Outpost); rows from legacy Core producers fall back to
 * a generic glyph. Clicking the row marks it read and opens the full Inbox; the
 * archive action moves it out of the tray without opening anything.
 */
function NotificationTrayRow({
	appsById,
	archived,
	notification,
	notifications,
	onOpen,
}: {
	archived: boolean;
	appsById: Map<string, AppInfo>;
	notification: AppNotification;
	notifications: ReturnType<typeof useNotifications>;
	onOpen: () => void;
}) {
	const app = notification.source_app_id
		? (appsById.get(notification.source_app_id) ?? null)
		: null;
	return (
		<TrayRow
			actions={
				<TrayIconAction
					icon={archived ? ArchiveRestoreIcon : Archive01Icon}
					label={archived ? "Restore to inbox" : "Archive"}
					onClick={() => {
						const action = archived
							? notifications.unarchive(notification.id)
							: notifications.archive(notification.id);
						action.catch(() => undefined);
					}}
				/>
			}
			icon={Notification01Icon}
			iconNode={
				app ? (
					<span className="mt-px flex size-7 shrink-0 items-center justify-center rounded-[10px]">
						<AppIcon
							className="size-7 rounded-[10px]"
							dither={app.iconDither}
							iconBackground={app.iconBackground ?? undefined}
							iconId={app.icon}
							iconPadding={app.iconPadding}
							iconUrl={app.iconUrl}
							name={app.name}
							seedId={app.id}
							size={14}
						/>
					</span>
				) : undefined
			}
			meta={trayMeta(
				app?.name ?? "Ryu",
				notification.body ?? undefined,
				shortAgo(notification.created_at)
			)}
			onOpen={onOpen}
			openLabel={`Open ${notification.title} in the inbox`}
			title={notification.title}
		/>
	);
}

export function InboxCenter({
	layout = "split",
	showAnnouncements = false,
	showInbox = true,
}: {
	layout?: NotificationLayout;
	showAnnouncements?: boolean;
	showInbox?: boolean;
}) {
	const { openTab } = useTabsContext();
	const queryClient = useQueryClient();
	const approvals = useApprovals();
	const quests = useQuests();
	const notifications = useNotifications();
	const announcementsFeed = useAnnouncements();
	const systemAnnouncements = useSystemAnnouncements();
	const announcementDialog = useAnnouncementDialog({
		announcements: announcementsFeed.announcements,
		enabled: showAnnouncements,
		loading: announcementsFeed.loading,
		markRead: announcementsFeed.markRead,
	});
	const node = useActiveNode();
	const target = {
		url: node.url,
		token: node.token,
		userJwt: node.userJwt ?? null,
	};
	// The installed-app catalog (shared query with the Store), used to resolve a
	// notification row's `source_app_id` to its app's icon + name.
	const { data: apps } = useQuery(installedAppsQuery(target));
	const appsById = new Map((apps ?? []).map((a) => [a.id, a]));
	const [open, setOpen] = useState(false);
	const [notificationFilter, setNotificationFilter] =
		useState<NotificationFilter>("unread");
	// useQuests exposes no pending flag for accept/dismissSuggestion (only for
	// judge/delete), so the row's spinner state is tracked here.
	const [decidingQuest, setDecidingQuest] = useState<string | null>(null);

	const decideQuest = (id: string, run: (id: string) => Promise<unknown>) => {
		setDecidingQuest(id);
		run(id)
			.catch(() => undefined)
			.finally(() =>
				setDecidingQuest((current) => (current === id ? null : current))
			);
	};

	const activeNotificationFilter = showInbox ? notificationFilter : "all";
	const includeInboxDecisionItems =
		activeNotificationFilter === "all" || activeNotificationFilter === "unread";
	const allPending = showInbox
		? approvals.approvals.filter((a) => a.status === "pending")
		: [];
	// Open quests carrying a pending check-off suggestion (mirrors InboxPage).
	const allTaskSuggestions = showInbox
		? quests.quests.filter((q) => q.status === "open" && q.suggestion)
		: [];
	const pending = includeInboxDecisionItems ? allPending : [];
	const taskSuggestions = includeInboxDecisionItems ? allTaskSuggestions : [];
	const filteredNotifications = showInbox
		? filterNotifications(notifications.notifications, activeNotificationFilter)
		: [];
	const previewNotifications = filteredNotifications.slice(0, PREVIEW_LIMIT);
	const pendingCount = pending.length + taskSuggestions.length;
	const unreadCount = showInbox
		? notifications.notifications.filter(isUnreadNotification).length
		: 0;
	const filteredNotificationCount = filteredNotifications.length;
	const riskyCount = allPending.filter((a) => a.risk_tags.length > 0).length;
	const hiddenApprovals = Math.max(0, pending.length - PREVIEW_LIMIT);
	const hiddenTasks = Math.max(0, taskSuggestions.length - PREVIEW_LIMIT);
	const hiddenNotifications = Math.max(
		0,
		filteredNotificationCount - PREVIEW_LIMIT
	);
	const announcementCandidates =
		activeNotificationFilter === "unread"
			? announcementsFeed.announcements.filter(
					(announcement) => !announcement.read
				)
			: announcementsFeed.announcements;
	const includeAnnouncements = showAnnouncements && includeInboxDecisionItems;
	const visibleAnnouncements = includeAnnouncements
		? [...systemAnnouncements, ...announcementCandidates]
		: [];
	const announcementCount = visibleAnnouncements.length;
	const allUnreadAnnouncementCount = showAnnouncements
		? announcementsFeed.unreadCount
		: 0;
	const hiddenAnnouncements = Math.max(0, announcementCount - PREVIEW_LIMIT);
	const hidden =
		hiddenApprovals + hiddenTasks + hiddenNotifications + hiddenAnnouncements;
	const totalCount =
		allPending.length +
		allTaskSuggestions.length +
		unreadCount +
		allUnreadAnnouncementCount +
		systemAnnouncements.length;

	const openInbox = () => {
		setOpen(false);
		openTab("/inbox");
	};

	const openNotification = (notification: AppNotification) => {
		if (!notification.read_at) {
			notifications.markRead(notification.id).catch(() => undefined);
		}
		openInbox();
	};

	const openAnnouncement = (
		announcement: (typeof announcementsFeed.announcements)[number]
	) => {
		announcementDialog.open(announcement);
	};

	const openAnnouncementLink = (
		announcement: (typeof announcementsFeed.announcements)[number]
	) => {
		if (announcement.linkUrl) {
			openExternal(announcement.linkUrl).catch(() => undefined);
		}
	};

	const openSystemAnnouncement = (
		announcement: (typeof systemAnnouncements)[number]
	) => {
		if (announcement.action) {
			setOpen(false);
			openTab(announcement.action.path);
		}
	};

	const announcementStackItems = includeAnnouncements
		? buildAnnouncementStackItems({
				announcements: announcementCandidates,
				dismiss: (id) => {
					announcementsFeed.dismiss(id).catch(() => undefined);
				},
				onOpenAnnouncement: openAnnouncement,
				onOpenSystem: openSystemAnnouncement,
				systemAnnouncements,
			})
		: [];

	const approvalStackItems: NotificationStackItem[] = pending
		.slice(0, PREVIEW_LIMIT)
		.map((approval) => ({
			accent: approval.risk_tags.length > 0 ? "var(--destructive)" : undefined,
			actions: (
				<span className="relative z-20 flex items-center gap-0.5">
					<TrayIconAction
						icon={Cancel01Icon}
						label="Reject"
						onClick={() => {
							approvals.reject(approval.id).catch(() => undefined);
						}}
						tone="danger"
					/>
					<TrayAction
						busy={approvals.deciding === approval.id}
						label="Approve"
						onClick={() => {
							approvals.approve(approval.id).catch(() => undefined);
						}}
						tone="success"
					/>
				</span>
			),
			ariaLabel: `Open ${approval.title} in the inbox`,
			description: trayMeta(
				...approval.risk_tags.slice(0, 2).map(tagLabel),
				approval.summary
			),
			id: `approval:${approval.id}`,
			leading: <TrayRowIcon icon={KIND_ICON[approval.kind] ?? Wrench01Icon} />,
			onActivate: openInbox,
			title: approval.title,
			trailing: shortAgo(approval.created_at),
		}));

	const taskStackItems: NotificationStackItem[] = taskSuggestions
		.slice(0, PREVIEW_LIMIT)
		.map((quest) => ({
			actions: (
				<span className="relative z-20 flex items-center gap-0.5">
					<TrayIconAction
						icon={Cancel01Icon}
						label="Not yet"
						onClick={() => decideQuest(quest.id, quests.dismissSuggestion)}
					/>
					<TrayAction
						busy={decidingQuest === quest.id}
						label="Done"
						onClick={() => decideQuest(quest.id, quests.acceptSuggestion)}
						tone="success"
					/>
				</span>
			),
			ariaLabel: `Open ${quest.title} in the inbox`,
			description: quest.suggestion?.reason,
			id: `task:${quest.id}`,
			leading: <TrayRowIcon icon={CheckListIcon} />,
			onActivate: openInbox,
			title: `Finished “${quest.title}”?`,
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
								action.catch(() => undefined);
							}}
						/>
					</span>
				),
				ariaLabel: `Open ${notification.title} in the inbox`,
				description: trayMeta(
					app?.name ?? "Ryu",
					notification.body ?? undefined,
					shortAgo(notification.created_at)
				),
				id: `notification:${notification.id}`,
				leading: app ? (
					<AppIcon
						className="size-7 rounded-[10px]"
						dither={app.iconDither}
						iconBackground={app.iconBackground ?? undefined}
						iconId={app.icon}
						iconPadding={app.iconPadding}
						iconUrl={app.iconUrl}
						name={app.name}
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
	const stackItems = [
		...(includeInboxDecisionItems ? approvalStackItems : []),
		...(includeInboxDecisionItems ? taskStackItems : []),
		...(includeAnnouncements ? announcementStackItems : []),
		...notificationStackItems,
	];
	const emptyFilterTitle =
		activeNotificationFilter === "all" || activeNotificationFilter === "unread"
			? "You're all caught up"
			: `No ${notificationFilterLabel(activeNotificationFilter).toLowerCase()} notifications`;

	let status: string | undefined;
	if (riskyCount > 0) {
		status = `${riskyCount} flagged risky`;
	} else if (allPending.length + allTaskSuggestions.length > 0) {
		status = "Waiting on you";
	} else if (totalCount > 0) {
		status = `${totalCount} new`;
	}

	if (layout === "unified") {
		return (
			<>
				<TrayMorph
					icon={Notification01Icon}
					label="Notifications"
					onOpenChange={setOpen}
					open={open}
					renderTrigger={(triggerProps) => (
						<NotificationBell
							{...triggerProps}
							className={cn(
								"rounded-xl bg-transparent! text-muted-foreground! hover:bg-muted! hover:text-foreground!",
								open && "bg-muted! text-foreground!"
							)}
							color="red"
							count={totalCount}
							max={99}
							size={40}
							style={{ height: 28, width: 28 }}
						/>
					)}
				>
					{showInbox ? (
						<NotificationFilterTabs
							ariaLabel="Filter inbox notifications"
							className="mb-2 w-full"
							items={notifications.notifications}
							onValueChange={setNotificationFilter}
							showCounts={false}
							value={notificationFilter}
						/>
					) : null}
					<NotificationStack
						className="max-w-none"
						collapsedLabel="Notifications"
						defaultExpanded
						emptyLabel="All caught up"
						expandedLabel={showInbox ? "Open inbox" : "Announcements"}
						items={stackItems}
						maxVisible={5}
						onViewAll={showInbox ? openInbox : undefined}
					/>
				</TrayMorph>
				<AnnouncementDetailDialog
					announcement={announcementDialog.selected}
					onOpenChange={(nextOpen) => {
						if (!nextOpen) {
							announcementDialog.close();
						}
					}}
					onOpenLink={openAnnouncementLink}
					open={Boolean(announcementDialog.selected)}
				/>
			</>
		);
	}

	return (
		<>
			<TrayMorph
				icon={showAnnouncements ? Notification01Icon : InboxIcon}
				label={showAnnouncements ? "Notifications" : "Inbox"}
				onOpenChange={setOpen}
				open={open}
				renderTrigger={(triggerProps) => (
					<NotificationBell
						{...triggerProps}
						className={cn(
							"rounded-xl bg-transparent! text-muted-foreground! hover:bg-muted! hover:text-foreground!",
							open && "bg-muted! text-foreground!"
						)}
						color="red"
						count={totalCount}
						max={99}
						size={40}
						style={{ height: 28, width: 28 }}
					/>
				)}
			>
				<TrayHeader
					count={totalCount}
					status={status}
					title={showAnnouncements ? "Notifications" : "Inbox"}
				/>
				{showInbox ? (
					<NotificationFilterTabs
						ariaLabel="Filter inbox notifications"
						className="mb-2 w-full"
						items={notifications.notifications}
						onValueChange={setNotificationFilter}
						showCounts={false}
						value={notificationFilter}
					/>
				) : null}
				{pendingCount > 0 ||
				previewNotifications.length > 0 ||
				announcementCount > 0 ? (
					<TrayScroll onRefresh={() => queryClient.invalidateQueries()}>
						{pending.length > 0 && (
							<>
								<TraySectionLabel count={pending.length}>
									Approvals
								</TraySectionLabel>
								{pending.slice(0, PREVIEW_LIMIT).map((approval) => (
									<ApprovalRow
										approval={approval}
										busy={approvals.deciding === approval.id}
										key={approval.id}
										onApprove={() => {
											approvals.approve(approval.id).catch(() => undefined);
										}}
										onOpen={openInbox}
										onReject={() => {
											approvals.reject(approval.id).catch(() => undefined);
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
										onAccept={() =>
											decideQuest(quest.id, quests.acceptSuggestion)
										}
										onDismiss={() =>
											decideQuest(quest.id, quests.dismissSuggestion)
										}
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
						{hidden > 0 && (
							<button
								className="rounded-[18px] px-2.5 py-2 text-left text-[11px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
								onClick={showInbox ? openInbox : () => setOpen(false)}
								type="button"
							>
								{hidden} more in{" "}
								{showInbox ? "the full inbox" : "announcements"}
							</button>
						)}
					</TrayScroll>
				) : (
					<TrayEmpty
						description={
							activeNotificationFilter === "archived"
								? "Rows you archive will stay here until you restore them."
								: activeNotificationFilter !== "all" &&
										activeNotificationFilter !== "unread"
									? `No ${notificationFilterLabel(activeNotificationFilter).toLowerCase()} notifications yet.`
									: showAnnouncements
										? "Approvals, tasks, app notifications, and announcements share this space."
										: "Approvals, task check-offs, and app notifications land here when Ryu needs a decision."
						}
						icon={showAnnouncements ? Notification01Icon : InboxIcon}
						title={emptyFilterTitle}
					/>
				)}
				{showInbox && <TrayFooter label="Open inbox" onClick={openInbox} />}
			</TrayMorph>
			<AnnouncementDetailDialog
				announcement={announcementDialog.selected}
				onOpenChange={(nextOpen) => {
					if (!nextOpen) {
						announcementDialog.close();
					}
				}}
				onOpenLink={openAnnouncementLink}
				open={Boolean(announcementDialog.selected)}
			/>
		</>
	);
}

// apps/desktop/src/components/inbox/InboxCenter.tsx
//
// The Inbox tray — a preview of everything awaiting a decision (pending HITL
// approvals plus the quest engine's check-off suggestions) hung off the sidebar
// footer, with an "Open inbox" action that jumps to the full Inbox tab.
//
// It ALSO previews the per-user notification feed (`useNotifications`) — the
// notification rows that apps and workflows push to the user. The tray defaults
// to unread rows, and the pills can switch it to all, archived, or a level.
// Row behaviour (app icons, archive, approve/reject) is documented in
// InboxCenter-rows.tsx.
//
// Chrome comes from TrayPopover (TrayMorph + shared row/header primitives),
// matching the Downloads tray so both read as the same object.

import { InboxIcon, Notification01Icon } from "@hugeicons/core-free-icons";
import { useLiteralMessages } from "@ryu/i18n/react";
import { NotificationStack } from "@ryu/ui/components/notification-stack.tsx";
import {
	filterNotifications,
	isUnreadNotification,
	type NotificationFilter,
	NotificationFilterTabs,
} from "@ryu/ui/lib/notification-filters.tsx";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { NotificationBell } from "@/components/ui/notification-bell.tsx";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { AnnouncementDetailDialog } from "@/src/components/notifications/LazyAnnouncementDetailDialog.tsx";
import {
	TrayEmpty,
	TrayFooter,
	TrayHeader,
	TrayMorph,
	type TrayPlacement,
	TrayRefreshButton,
} from "@/src/components/shell/TrayPopover.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAnnouncementDialog } from "@/src/hooks/useAnnouncementDialog.ts";
import { useAnnouncements } from "@/src/hooks/useAnnouncements.ts";
import { useApprovals } from "@/src/hooks/useApprovals.ts";
import { installedAppsQuery } from "@/src/hooks/useAppsCatalog.ts";
import { useNotifications } from "@/src/hooks/useNotifications.ts";
import { useQuests } from "@/src/hooks/useQuests.ts";
import { useSystemAnnouncements } from "@/src/hooks/useSystemAnnouncements.ts";
import type { AppNotification } from "@/src/lib/api/notifications.ts";
import type { NotificationLayout } from "@/src/lib/notification-layout.ts";
import { buildAnnouncementStackItems } from "../notifications/announcement-stack-items.tsx";
import {
	inboxEmptyDescription,
	inboxEmptyTitle,
	inboxTrayStatus,
} from "./InboxCenter-labels.ts";
import {
	type InboxRowContext,
	InboxTraySections,
} from "./InboxCenter-sections.tsx";
import {
	buildInboxStackItems,
	PREVIEW_LIMIT,
} from "./InboxCenter-stack-items.tsx";

export function InboxCenter({
	layout = "split",
	placement = "sidebar",
	showAnnouncements = false,
	showInbox = true,
}: {
	layout?: NotificationLayout;
	placement?: TrayPlacement;
	showAnnouncements?: boolean;
	showInbox?: boolean;
}) {
	const tl = useLiteralMessages();
	const openTab = useTabSelector((state) => state.openTab);
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
	const [decidingApprovals, setDecidingApprovals] = useState<Set<string>>(
		() => new Set()
	);

	const decideApproval = (
		id: string,
		run: ReturnType<typeof useApprovals>["approve"]
	) => {
		setDecidingApprovals((current) => new Set(current).add(id));
		// The hook's mutation onError already toasts a failed decision.
		return run(id)
			.catch(() => undefined)
			.finally(() => {
				setDecidingApprovals((current) => {
					const next = new Set(current);
					next.delete(id);
					return next;
				});
			});
	};

	const decideQuest = (
		id: string,
		run: ReturnType<typeof useQuests>["acceptSuggestion"]
	) => {
		setDecidingQuest(id);
		// The hook's mutation onError already toasts a failed decision.
		return run(id)
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

	const rowContext: InboxRowContext = {
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
	};
	const { approvalStackItems, notificationStackItems, taskStackItems } =
		buildInboxStackItems(rowContext);
	const stackItems = [
		...(includeInboxDecisionItems ? approvalStackItems : []),
		...(includeInboxDecisionItems ? taskStackItems : []),
		...(includeAnnouncements ? announcementStackItems : []),
		...notificationStackItems,
	];
	const emptyFilterTitle = inboxEmptyTitle(activeNotificationFilter, tl);
	const status = inboxTrayStatus(
		riskyCount,
		allPending.length + allTaskSuggestions.length,
		totalCount
	);

	if (layout === "unified") {
		return (
			<>
				<TrayMorph
					icon={Notification01Icon}
					label="Notifications"
					onOpenChange={setOpen}
					open={open}
					placement={placement}
					renderTrigger={(triggerProps) => (
						<NotificationBell
							{...triggerProps}
							appearance={
								placement === "menubar" ? "inbox-menubar" : "inbox-sidebar"
							}
							className=""
							color="red"
							count={totalCount}
							expanded={open}
							max={99}
							size={placement === "menubar" ? 28 : 40}
							style={undefined}
							variant="dot"
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
				placement={placement}
				renderTrigger={(triggerProps) => (
					<NotificationBell
						{...triggerProps}
						appearance={
							placement === "menubar" ? "inbox-menubar" : "inbox-sidebar"
						}
						className=""
						color="red"
						count={totalCount}
						expanded={open}
						max={99}
						size={placement === "menubar" ? 28 : 40}
						style={undefined}
						variant="dot"
					/>
				)}
			>
				<TrayHeader
					actions={
						<TrayRefreshButton
							onRefresh={() => queryClient.invalidateQueries()}
						/>
					}
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
					<>
						<InboxTraySections
							announcementCount={announcementCount}
							announcementStackItems={announcementStackItems}
							context={rowContext}
							filteredNotificationCount={filteredNotificationCount}
							onRefresh={() => queryClient.invalidateQueries()}
							showAnnouncements={showAnnouncements}
						/>
						{hidden > 0 && (
							<button
								className="rounded-(--radius-inbox-status) px-2 py-2 text-left text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground"
								onClick={showInbox ? openInbox : () => setOpen(false)}
								type="button"
							>
								{showInbox
									? tl("{hidden} more in the full inbox", {
											hidden: String(hidden),
										})
									: tl("{hidden} more in announcements", {
											hidden: String(hidden),
										})}
							</button>
						)}
					</>
				) : (
					<TrayEmpty
						description={inboxEmptyDescription(
							activeNotificationFilter,
							showAnnouncements,
							tl
						)}
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

import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { NotificationStack } from "@ryu/ui/components/notification-stack.tsx";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { AnnouncementDetailDialog } from "@/src/components/notifications/announcement-detail-dialog.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { useAnnouncementDialog } from "@/src/hooks/useAnnouncementDialog.ts";
import { useAnnouncements } from "@/src/hooks/useAnnouncements.ts";
import { useSystemAnnouncements } from "@/src/hooks/useSystemAnnouncements.ts";
import {
	buildAnnouncementStackItems,
	markAllAnnouncementsRead,
} from "../notifications/announcement-stack-items.tsx";

/**
 * The split-mode announcement surface. It keeps the banner content in the
 * sidebar, but uses the same compact stack interaction as the shared tray:
 * hover/focus/tap expands the cards, while the footer stays quiet when the feed
 * has nothing to say.
 */
export function AnnouncementsSection() {
	const { announcements, loading, markRead, dismiss, unreadCount } =
		useAnnouncements();
	const systemAnnouncements = useSystemAnnouncements();
	const { openTab } = useTabsContext();
	const announcementDialog = useAnnouncementDialog({
		announcements,
		loading,
		markRead,
	});

	if (announcements.length === 0 && systemAnnouncements.length === 0) {
		return null;
	}

	const openAnnouncement = (announcement: (typeof announcements)[number]) => {
		announcementDialog.open(announcement);
	};

	const openAnnouncementLink = (
		announcement: (typeof announcements)[number]
	) => {
		if (announcement.linkUrl) {
			openExternal(announcement.linkUrl).catch(() => undefined);
		}
	};

	const items = buildAnnouncementStackItems({
		announcements,
		dismiss: (id) => dismiss(id).catch(() => undefined),
		onOpenAnnouncement: openAnnouncement,
		onOpenSystem: (announcement) => {
			if (announcement.action) {
				openTab(announcement.action.path);
			}
		},
		systemAnnouncements,
	});

	return (
		<div
			className="flex flex-col gap-1.5 px-2 pb-1"
			data-notification-surface="split"
		>
			{unreadCount > 0 && (
				<div className="flex items-center gap-2 px-1">
					<span className="type-compact rounded-full bg-primary/15 px-1.5 py-0.5 font-medium text-primary tabular-nums">
						{unreadCount}
					</span>
					<div className="flex-1" />
					<button
						className="type-compact flex items-center gap-0.5 rounded-md px-1 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
						onClick={() => markAllAnnouncementsRead(announcements, markRead)}
						title="Mark all announcements as read"
						type="button"
					>
						<HugeiconsIcon className="size-3" icon={Tick02Icon} />
						Read all
					</button>
				</div>
			)}
			<NotificationStack
				className="max-w-none"
				collapsedLabel="Announcements"
				expandedLabel="Announcements"
				items={items}
				maxVisible={3}
			/>
			<AnnouncementDetailDialog
				announcement={announcementDialog.selected}
				onOpenChange={(open) => {
					if (!open) {
						announcementDialog.close();
					}
				}}
				onOpenLink={openAnnouncementLink}
				open={Boolean(announcementDialog.selected)}
			/>
		</div>
	);
}

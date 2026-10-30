import type { CSSProperties } from "react";
import "./announcement-stack-items.css";
import {
	ArrowUpRight01Icon,
	Cancel01Icon,
	GiftIcon,
	InformationCircleIcon,
	Megaphone01Icon,
	NewReleasesIcon,
	Notification01Icon,
	RocketIcon,
	SparklesIcon,
	StarIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { NotificationStackItem } from "@ryu/ui/components/notification-stack.tsx";
import type { SystemAnnouncement } from "@/src/hooks/useSystemAnnouncements.ts";
import type { Announcement } from "@/src/lib/api/announcements.ts";

const ICON_MAP = new Map<string, IconSvgElement>([
	["sparkles", SparklesIcon],
	["megaphone", Megaphone01Icon],
	["gift", GiftIcon],
	["rocket", RocketIcon],
	["bell", Notification01Icon],
	["star", StarIcon],
	["info", InformationCircleIcon],
	["new", NewReleasesIcon],
]);

function iconFor(name: string | null): IconSvgElement {
	if (!name) {
		return Megaphone01Icon;
	}
	return ICON_MAP.get(name.trim().toLowerCase()) ?? Megaphone01Icon;
}

function accentIcon(accent: string, icon: SystemAnnouncement["icon"]) {
	const announcementAccentVariables1: CSSProperties & {
		"--announcement-accent": string;
	} = { "--announcement-accent": accent };
	return (
		<span
			className="flex size-7 items-center justify-center rounded-lg"
			data-announcement-accent=""
			style={announcementAccentVariables1}
		>
			<HugeiconsIcon className="size-3.5" icon={icon} />
		</span>
	);
}

function AnnouncementAction({
	label,
	onClick,
}: {
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			aria-label={label}
			className="relative z-20 flex h-6 items-center gap-1 rounded-lg px-1.5 font-medium text-primary text-xs transition-colors hover:bg-primary/10"
			data-notification-action="true"
			onClick={onClick}
			type="button"
		>
			{label}
			<HugeiconsIcon className="size-3" icon={ArrowUpRight01Icon} />
		</button>
	);
}

function DismissAction({ onClick }: { onClick: () => void }) {
	return (
		<button
			aria-label="Dismiss announcement"
			className="relative z-20 flex size-6 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
			data-notification-action="true"
			onClick={onClick}
			title="Dismiss"
			type="button"
		>
			<HugeiconsIcon className="size-3.5" icon={Cancel01Icon} />
		</button>
	);
}

export function buildAnnouncementStackItems({
	announcements,
	dismiss,
	onOpenAnnouncement,
	onOpenSystem,
	systemAnnouncements,
}: {
	announcements: Announcement[];
	dismiss: (id: string) => void;
	onOpenAnnouncement: (announcement: Announcement) => void;
	onOpenSystem: (announcement: SystemAnnouncement) => void;
	systemAnnouncements: SystemAnnouncement[];
}): NotificationStackItem[] {
	const systemItems: NotificationStackItem[] = systemAnnouncements.map(
		(announcement) => ({
			accent: announcement.accent,
			activateCollapsed: true,
			actions: announcement.action ? (
				<AnnouncementAction
					label={announcement.action.label}
					onClick={() => onOpenSystem(announcement)}
				/>
			) : undefined,
			ariaLabel: `Open ${announcement.title}`,
			description: announcement.body,
			id: announcement.id,
			leading: accentIcon(announcement.accent, announcement.icon),
			onActivate: () => onOpenSystem(announcement),
			title: announcement.title,
		})
	);

	const authoredItems: NotificationStackItem[] = announcements.map(
		(announcement) => {
			const accent = announcement.color || "var(--primary)";
			return {
				accent,
				activateCollapsed: true,
				actions: (
					<span className="flex items-center gap-0.5">
						{announcement.linkUrl && (
							<AnnouncementAction
								label={announcement.linkLabel || "Learn more"}
								onClick={() => onOpenAnnouncement(announcement)}
							/>
						)}
						<DismissAction onClick={() => dismiss(announcement.id)} />
					</span>
				),
				ariaLabel: `Open ${announcement.title}`,
				description: announcement.body,
				id: announcement.id,
				leading: accentIcon(accent, iconFor(announcement.icon)),
				muted: announcement.read,
				onActivate: () => onOpenAnnouncement(announcement),
				title: announcement.title,
				unread: !announcement.read,
			};
		}
	);

	return [...systemItems, ...authoredItems];
}

export function markAllAnnouncementsRead(
	announcements: Announcement[],
	markRead: (id: string) => void
): void {
	for (const announcement of announcements) {
		if (!announcement.read) {
			markRead(announcement.id);
		}
	}
}

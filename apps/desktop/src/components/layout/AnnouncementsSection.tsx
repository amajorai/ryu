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
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { cn } from "@ryu/ui/lib/utils";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { useAnnouncements } from "@/src/hooks/useAnnouncements.ts";
import { useSystemAnnouncements } from "@/src/hooks/useSystemAnnouncements.ts";
import type { Announcement } from "@/src/lib/api/announcements.ts";

/**
 * Admin-authored product announcements plus locally-generated system/status
 * cards (Core/gateway reachability, node version floor — see
 * useSystemAnnouncements), shown pinned just above the account footer. Each card
 * carries a title, description, an accent color, an optional icon, and an optional
 * action/link. Server announcements can be dismissed or marked read (persisted
 * per-user server-side); system cards are live status and clear themselves. The
 * whole section self-hides when there is nothing to show, so it takes up no space
 * until an admin posts something or a service goes down.
 */

/** Admin-authored icon names → Hugeicons. Unknown/blank falls back to megaphone. */
const ICON_MAP: Record<string, IconSvgElement> = {
	sparkles: SparklesIcon,
	megaphone: Megaphone01Icon,
	gift: GiftIcon,
	rocket: RocketIcon,
	bell: Notification01Icon,
	star: StarIcon,
	info: InformationCircleIcon,
	new: NewReleasesIcon,
};

function iconFor(name: string | null): IconSvgElement {
	if (!name) {
		return Megaphone01Icon;
	}
	return ICON_MAP[name.trim().toLowerCase()] ?? Megaphone01Icon;
}

/**
 * Presentational card shared by admin announcements and system/status items so
 * both render with the exact same design. The dismiss affordance only appears
 * when `onDismiss` is provided (system items have no dismiss); the action is a
 * generic callback so a server link opens externally while a system item opens a
 * tab in-app.
 */
function AnnouncementCard({
	accent,
	icon,
	title,
	body,
	showUnreadDot,
	muted,
	action,
	onDismiss,
}: {
	accent: string;
	icon: IconSvgElement;
	title: string;
	body: string | null;
	showUnreadDot: boolean;
	muted: boolean;
	action: { label: string; onClick: () => void } | null;
	onDismiss: (() => void) | null;
}) {
	return (
		<div
			className="group/ann relative flex gap-2.5 rounded-lg border border-border/60 border-l-2 bg-muted/40 p-2.5 transition-colors hover:bg-muted/70"
			style={{ borderLeftColor: accent }}
		>
			<span
				className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md"
				style={{
					backgroundColor: `color-mix(in srgb, ${accent} 18%, transparent)`,
				}}
			>
				<HugeiconsIcon
					className="size-3.5"
					icon={icon}
					style={{ color: accent }}
				/>
			</span>

			<div className="min-w-0 flex-1">
				<div className="flex items-start gap-1">
					{showUnreadDot && (
						<span
							aria-hidden
							className="mt-1.5 size-1.5 shrink-0 rounded-full"
							style={{ backgroundColor: accent }}
						/>
					)}
					<p
						className={cn(
							"min-w-0 flex-1 truncate font-medium text-foreground text-xs",
							muted && "text-muted-foreground"
						)}
					>
						{title}
					</p>
				</div>
				{body && (
					<p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground leading-snug">
						{body}
					</p>
				)}
				{action && (
					<button
						className="mt-1.5 inline-flex items-center gap-0.5 font-medium text-[11px] hover:underline"
						onClick={action.onClick}
						style={{ color: accent }}
						type="button"
					>
						{action.label}
						<HugeiconsIcon className="size-3" icon={ArrowUpRight01Icon} />
					</button>
				)}
			</div>

			{/* Dismiss — revealed on hover to keep the card clean at rest. */}
			{onDismiss && (
				<button
					aria-label="Dismiss announcement"
					className="absolute top-1 right-1 flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover/ann:opacity-100"
					onClick={onDismiss}
					title="Dismiss"
					type="button"
				>
					<HugeiconsIcon className="size-3" icon={Cancel01Icon} />
				</button>
			)}
		</div>
	);
}

export function AnnouncementsSection() {
	const { announcements, markRead, dismiss, unreadCount } = useAnnouncements();
	const systemAnnouncements = useSystemAnnouncements();
	const { openTab } = useTabsContext();

	if (announcements.length === 0 && systemAnnouncements.length === 0) {
		return null;
	}

	// Following an announcement's link counts as reading it, then opens the URL in
	// the user's browser (external, not a Tauri webview navigation).
	const open = (a: Announcement) => {
		if (!a.read) {
			markRead(a.id).catch(() => undefined);
		}
		if (a.linkUrl) {
			openExternal(a.linkUrl).catch(() => undefined);
		}
	};

	return (
		<div className="flex flex-col gap-1.5 px-2 pb-1">
			{unreadCount > 0 && (
				<div className="flex items-center gap-2 px-1">
					<span className="rounded-full bg-primary/15 px-1.5 py-0.5 font-medium text-[10px] text-primary tabular-nums">
						{unreadCount}
					</span>
					<div className="flex-1" />
					<button
						className="flex items-center gap-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
						onClick={() => {
							for (const a of announcements) {
								if (!a.read) {
									markRead(a.id).catch(() => undefined);
								}
							}
						}}
						title="Mark all as read"
						type="button"
					>
						<HugeiconsIcon className="size-3" icon={Tick02Icon} />
						Read all
					</button>
				</div>
			)}
			<div className="scroll-fade-effect-y flex max-h-[42vh] flex-col gap-1.5 overflow-y-auto">
				{/* Live status items lead — they're the most actionable. */}
				{systemAnnouncements.map((s) => (
					<AnnouncementCard
						accent={s.accent}
						action={
							s.action
								? {
										label: s.action.label,
										onClick: () => openTab(s.action?.path ?? "/fleet"),
									}
								: null
						}
						body={s.body}
						icon={s.icon}
						key={s.id}
						muted={false}
						onDismiss={null}
						showUnreadDot={false}
					/>
				))}
				{announcements.map((a) => (
					<AnnouncementCard
						accent={a.color || "var(--primary)"}
						action={
							a.linkUrl
								? { label: a.linkLabel || "Learn more", onClick: () => open(a) }
								: null
						}
						body={a.body}
						icon={iconFor(a.icon)}
						key={a.id}
						muted={a.read}
						onDismiss={() => dismiss(a.id)}
						showUnreadDot={!a.read}
					/>
				))}
			</div>
		</div>
	);
}

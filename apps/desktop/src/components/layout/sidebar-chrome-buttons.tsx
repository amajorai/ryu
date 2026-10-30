import {
	ArrowDown01Icon,
	ArrowUp01Icon,
	ArrowUpRight01Icon,
	Package01Icon,
	Tick02Icon,
	ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import { Icon } from "@ryu/ui/components/icon.tsx";
import {
	SidebarMenuButton,
	SidebarMenuItem,
} from "@ryu/ui/components/sidebar.tsx";
import type { ReorderShift } from "@ryu/ui/hooks/use-reorder-shift.tsx";
import type { ReactNode } from "react";
import { OpenInNewWindowContextMenuItem } from "@/src/components/layout/OpenInNewWindowMenuItem.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { parseContributedTarget } from "@/src/contributions/contributed-target.ts";
import type { PluginSidebarButton } from "@/src/lib/api/plugins.ts";
import { openEntityInNewWindow } from "@/src/lib/window-routing.ts";
import {
	CHROME_DND_FORMAT,
	type ChromeKey,
	type DynamicChromeKey,
} from "./sidebar-panel-state.tsx";

/** Drag-and-drop wiring threaded into every reorderable header button. Mirrors
 *  SectionDnd, but rides its own state so a button drag can never land between
 *  the content sections below (and vice-versa). */
export interface ChromeDnd {
	draggingKey: ChromeKey | null;
	dragOverKey: ChromeKey | null;
	onDragEnd: () => void;
	onDragOver: (key: ChromeKey) => void;
	onDragStart: (key: ChromeKey) => void;
	onDrop: (key: ChromeKey) => void;
	/** Current button order, so a target can tell which edge to draw the drop line. */
	order: ChromeKey[];
	/** Slides buttons apart to preview the drop. */
	shift: ReorderShift;
}

/** The header-button context-menu actions: move within the button stack or hide. */
export interface ChromeMenu {
	canMove: (key: ChromeKey, dir: "up" | "down") => boolean;
	onHide: (key: ChromeKey) => void;
	onMove: (key: ChromeKey, dir: "up" | "down") => void;
}

/** Shared "Move up / Move down / Hide" items for a header button's context menu,
 *  mirroring the per-section overflow menu so the two surfaces match. */
function ChromeMenuItems({
	chromeKey,
	label,
	menu,
}: {
	chromeKey: ChromeKey;
	label: string;
	menu: ChromeMenu;
}) {
	const tl = useLiteralMessages();
	return (
		<>
			<ContextMenuItem
				disabled={!menu.canMove(chromeKey, "up")}
				onClick={() => menu.onMove(chromeKey, "up")}
			>
				<HugeiconsIcon className="size-4" icon={ArrowUp01Icon} />
				Move up
			</ContextMenuItem>
			<ContextMenuItem
				disabled={!menu.canMove(chromeKey, "down")}
				onClick={() => menu.onMove(chromeKey, "down")}
			>
				<HugeiconsIcon className="size-4" icon={ArrowDown01Icon} />
				Move down
			</ContextMenuItem>
			<ContextMenuSeparator />
			<ContextMenuItem onClick={() => menu.onHide(chromeKey)}>
				<HugeiconsIcon className="size-4" icon={ViewOffSlashIcon} />
				{tl("Hide {label}", { label })}
			</ContextMenuItem>
		</>
	);
}

/** Wraps a header button in a right-click menu (move/hide) — used by the buttons
 *  that aren't NavTabButton (New chat, Search). The matching show toggle lives in
 *  the customize dialog. */
export function ChromeHideMenu({
	children,
	chromeKey,
	label,
	menu,
}: {
	children: ReactNode;
	chromeKey: ChromeKey;
	label: string;
	menu: ChromeMenu;
}) {
	return (
		<ContextMenu>
			<ContextMenuTrigger>{children}</ContextMenuTrigger>
			<ContextMenuContent>
				<ChromeMenuItems chromeKey={chromeKey} label={label} menu={menu} />
			</ContextMenuContent>
		</ContextMenu>
	);
}

/** Draggable shell around a single header button: handles the reorder gesture and
 *  the drop indicator, leaving the button itself to render via `children`. The li
 *  is the drag source so any button (whatever its inner structure) reorders the
 *  same way; the inner button's own click/middle-click still fire (the browser
 *  suppresses the click that follows a real drag). */
export function ChromeButtonShell({
	children,
	chromeKey,
	dnd,
}: {
	children: ReactNode;
	chromeKey: ChromeKey;
	dnd: ChromeDnd;
}) {
	const isDragOver =
		dnd.dragOverKey === chromeKey &&
		dnd.draggingKey !== null &&
		dnd.draggingKey !== chromeKey &&
		!dnd.shift.previewing;
	const isDragging = dnd.draggingKey === chromeKey;
	const dropBelow =
		isDragOver &&
		dnd.draggingKey !== null &&
		dnd.order.indexOf(dnd.draggingKey) < dnd.order.indexOf(chromeKey);
	return (
		<SidebarMenuItem
			draggable
			dragging={isDragging}
			onDragEnd={() => dnd.onDragEnd()}
			onDragOver={(e) => {
				if (dnd.draggingKey) {
					e.preventDefault();
					e.dataTransfer.dropEffect = "move";
					dnd.onDragOver(
						dnd.shift.resolveOver(chromeKey, e.clientX, e.clientY)
					);
				}
			}}
			onDragStart={(e) => {
				e.dataTransfer.effectAllowed = "move";
				e.dataTransfer.setData(CHROME_DND_FORMAT, chromeKey);
				// Some platforms require text/plain to start a drag.
				e.dataTransfer.setData("text/plain", chromeKey);
				dnd.onDragStart(chromeKey);
			}}
			onDrop={(e) => {
				e.preventDefault();
				dnd.onDrop(chromeKey);
			}}
			ref={dnd.shift.register(chromeKey)}
			style={dnd.shift.styleFor(chromeKey)}
		>
			{isDragOver && (
				<div
					className={`reorder-drop-indicator pointer-events-none absolute inset-x-2 z-10 h-0.5 bg-primary ${dropBelow ? "bottom-0" : "top-0"}`}
				/>
			)}
			{children}
		</SidebarMenuItem>
	);
}

export function CheckedContextMenuItem({
	checked,
	children,
	icon,
	onClick,
}: {
	checked: boolean;
	children: ReactNode;
	icon?: IconSvgElement;
	onClick: () => void;
}) {
	return (
		<ContextMenuItem onClick={onClick}>
			<span className="flex size-4 shrink-0 items-center justify-center">
				{checked ? (
					<HugeiconsIcon className="size-3.5" icon={Tick02Icon} />
				) : (
					icon && <HugeiconsIcon className="size-4" icon={icon} />
				)}
			</span>
			{children}
		</ContextMenuItem>
	);
}

export function SidebarContextMenuItem({
	children,
	icon,
	onClick,
}: {
	children: ReactNode;
	icon: IconSvgElement;
	onClick: () => void;
}) {
	return (
		<ContextMenuItem onClick={onClick}>
			<span className="flex size-4 shrink-0 items-center justify-center">
				<HugeiconsIcon className="size-4" icon={icon} />
			</span>
			{children}
		</ContextMenuItem>
	);
}

/** A header nav button that opens a singleton tab — with middle-click and a
 *  right-click "Open in new tab" affordance, matching the tab strip. Rendered
 *  inside a ChromeButtonShell, so it omits its own SidebarMenuItem wrapper. */
export function NavTabButton({
	activeIcon,
	chromeKey,
	icon,
	label,
	menu,
	path,
}: {
	activeIcon?: IconSvgElement;
	chromeKey: ChromeKey;
	icon: IconSvgElement;
	label: string;
	menu: ChromeMenu;
	path: string;
}) {
	const openTab = useTabSelector((state) => state.openTab);
	const tabs = useTabSelector((state) => state.tabs);
	const activeTabId = useTabSelector((state) => state.activeTabId);
	const open = (forceNew: boolean) => openTab(path, { title: label, forceNew });
	const openInNewWindow = () => {
		void openEntityInNewWindow({ path, title: label });
	};
	// Swap to the "active" glyph when the focused tab is this button's page.
	const isActive = tabs.find((t) => t.id === activeTabId)?.path === path;
	const displayIcon = isActive && activeIcon ? activeIcon : icon;
	return (
		<ContextMenu>
			<ContextMenuTrigger>
				<SidebarMenuButton
					corners="rounded"
					data-prefetch-path={path}
					onAuxClick={(e) => {
						if (e.button === 1) {
							e.preventDefault();
							open(true);
						}
					}}
					onClick={() => open(false)}
					size="compact"
				>
					<HugeiconsIcon className="size-4" icon={displayIcon} />
					<span>{label}</span>
				</SidebarMenuButton>
			</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem onClick={() => open(true)}>
					<HugeiconsIcon className="size-4" icon={ArrowUpRight01Icon} />
					Open in new tab
				</ContextMenuItem>
				<OpenInNewWindowContextMenuItem onClick={openInNewWindow} />
				<ContextMenuSeparator />
				<ChromeMenuItems chromeKey={chromeKey} label={label} menu={menu} />
			</ContextMenuContent>
		</ContextMenu>
	);
}

/**
 * A plugin-registered header button, rendered generically from a `sidebar_buttons`
 * contribution. Core-tier Ryu Apps are filtered before this renderer and use the
 * app shelf instead. Opens the contribution's `target` route; its glyph resolves
 * through the string-`icon` primitive (Iconify/Hugeicons) rather than a compiled
 * IconSvgElement. Present only while the owning app is enabled (the aggregator
 * filters the feed), so a disabled/absent app leaves no button behind.
 */
export function DynamicSidebarButton({
	button,
	menu,
}: {
	button: PluginSidebarButton;
	menu: ChromeMenu;
}) {
	const openTab = useTabSelector((state) => state.openTab);
	const chromeKey: DynamicChromeKey = `plugin:${button.plugin}:${button.id}`;
	const open = (forceNew: boolean) => {
		const options: Parameters<typeof openTab>[1] = {
			title: button.title,
			forceNew,
		};
		if (button.context) {
			options.mountContext = button.context;
		}
		openTab(button.target, options);
	};
	const openInNewWindow = () => {
		const { path, options } = parseContributedTarget(button.target);
		void openEntityInNewWindow({
			conversationId: options.conversationId,
			path,
			title: button.title,
		});
	};
	return (
		<ContextMenu>
			<ContextMenuTrigger>
				<SidebarMenuButton
					corners="rounded"
					data-prefetch-path={parseContributedTarget(button.target).path}
					onAuxClick={(e) => {
						if (e.button === 1) {
							e.preventDefault();
							open(true);
						}
					}}
					onClick={() => open(false)}
					size="compact"
				>
					{button.icon ? (
						<Icon className="size-4" icon={button.icon} size={16} />
					) : (
						<HugeiconsIcon className="size-4" icon={Package01Icon} />
					)}
					<span>{button.title}</span>
				</SidebarMenuButton>
			</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem onClick={() => open(true)}>
					<HugeiconsIcon className="size-4" icon={ArrowUpRight01Icon} />
					Open in new tab
				</ContextMenuItem>
				<OpenInNewWindowContextMenuItem onClick={openInNewWindow} />
				<ContextMenuSeparator />
				<ChromeMenuItems
					chromeKey={chromeKey}
					label={button.title}
					menu={menu}
				/>
			</ContextMenuContent>
		</ContextMenu>
	);
}

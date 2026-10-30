// Small building blocks of the sidebar account footer: the hide-from-footer
// context menu, the web account links, and the theme submenu.

import {
	Building03Icon,
	DiscordIcon,
	GiftIcon,
	InboxDownloadIcon,
	Key01Icon,
	LaptopIcon,
	Moon02Icon,
	Settings01Icon,
	Sun03Icon,
	UserIcon,
	ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { ClassicThemeIcon } from "@ryu/ui/components/classic-theme-icon.tsx";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import {
	DropdownMenuItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import {
	INVITE_FRIEND_NAV_ITEM,
	JOIN_DISCORD_NAV_ITEM,
} from "@ryu/ui/lib/referral-navigation.ts";
import { useTheme } from "next-themes";
import type { ReactNode } from "react";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useAvailableUpdates } from "@/src/hooks/useAvailableUpdates.ts";

export function HideChromeContextMenu({
	children,
	label,
	onHide,
}: {
	children: ReactNode;
	label: string;
	onHide?: () => void;
}) {
	const tl = useLiteralMessages();
	if (!onHide) {
		return children;
	}

	return (
		<ContextMenu>
			<ContextMenuTrigger>{children}</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem onClick={onHide}>
					<HugeiconsIcon className="size-4" icon={ViewOffSlashIcon} />
					{tl("Hide {label}", { label })}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

function MenuIcon({ icon }: { icon: IconSvgElement }) {
	return <HugeiconsIcon className="size-4" icon={icon} />;
}

/**
 * The web-account rows that sit under the account switcher: the public
 * profile, account settings on the web and personal access tokens.
 */
export function WebAccountItems({
	onOpenWeb,
	profilePath,
}: {
	onOpenWeb: (path: string) => void;
	profilePath: string;
}) {
	return (
		<>
			<DropdownMenuItem onClick={() => onOpenWeb(profilePath)}>
				<MenuIcon icon={UserIcon} />
				Profile
			</DropdownMenuItem>
			<DropdownMenuItem onClick={() => onOpenWeb("/settings")}>
				<MenuIcon icon={Settings01Icon} />
				Account
			</DropdownMenuItem>
			<DropdownMenuItem onClick={() => onOpenWeb("/api-keys")}>
				<MenuIcon icon={Key01Icon} />
				Personal access tokens
			</DropdownMenuItem>
		</>
	);
}

/** Opens the organizations page on the web. */
export function OrganizationsItem({
	onOpenWeb,
}: {
	onOpenWeb: (path: string) => void;
}) {
	return (
		<DropdownMenuItem onClick={() => onOpenWeb("/organizations")}>
			<MenuIcon icon={Building03Icon} />
			Organizations
		</DropdownMenuItem>
	);
}

/** Invite a friend and the community Discord. */
export function CommunityItems({
	invite = true,
	onOpenWeb,
}: {
	invite?: boolean;
	onOpenWeb: (path: string) => void;
}) {
	return (
		<>
			{invite ? (
				<DropdownMenuItem
					onClick={() => onOpenWeb(INVITE_FRIEND_NAV_ITEM.path)}
				>
					<MenuIcon icon={GiftIcon} />
					{INVITE_FRIEND_NAV_ITEM.label}
				</DropdownMenuItem>
			) : null}
			<DropdownMenuItem onClick={() => onOpenWeb(JOIN_DISCORD_NAV_ITEM.path)}>
				<MenuIcon icon={DiscordIcon} />
				{JOIN_DISCORD_NAV_ITEM.label}
			</DropdownMenuItem>
		</>
	);
}

/**
 * Opens the full Downloads page. The footer tray shows only while something is
 * in flight or failed, so the available-updates count it used to badge is the
 * row's meta here instead.
 */
export function DownloadsMenuItem() {
	const openTab = useTabSelector((state) => state.openTab);
	const { updates } = useAvailableUpdates();
	const updateCount = updates.length;
	const tl = useLiteralMessages();
	const updatesLabel =
		updateCount > 0
			? tl("{updateCount, plural, one {# update} other {# updates}}", {
					updateCount,
				})
			: null;
	return (
		<DropdownMenuItem
			aria-label={
				updatesLabel
					? tl("Downloads, {updatesLabel} available", { updatesLabel })
					: undefined
			}
			onClick={() => openTab("/downloads")}
		>
			<MenuIcon icon={InboxDownloadIcon} />
			<span className="flex-1">Downloads</span>
			{updatesLabel ? (
				<span className="text-muted-foreground text-xs tabular-nums">
					{updatesLabel}
				</span>
			) : null}
		</DropdownMenuItem>
	);
}

interface DesktopWebAccountLinksProps {
	botProduct?: boolean;
	onOpenWeb: (path: string) => void;
	profilePath: string;
}

/** The account links that leave the desktop shell for the web account surface. */
export function DesktopWebAccountLinks({
	botProduct = false,
	onOpenWeb,
	profilePath,
}: DesktopWebAccountLinksProps) {
	if (botProduct) {
		return (
			<>
				<DropdownMenuItem onClick={() => onOpenWeb("/settings")}>
					<MenuIcon icon={Settings01Icon} />
					Account
				</DropdownMenuItem>
				<OrganizationsItem onOpenWeb={onOpenWeb} />
				<CommunityItems invite={false} onOpenWeb={onOpenWeb} />
				<DropdownMenuItem onClick={() => onOpenWeb("/download")}>
					<MenuIcon icon={LaptopIcon} />
					Download Ryu Build
				</DropdownMenuItem>
			</>
		);
	}
	return (
		<>
			<OrganizationsItem onOpenWeb={onOpenWeb} />
			<CommunityItems onOpenWeb={onOpenWeb} />
			<WebAccountItems onOpenWeb={onOpenWeb} profilePath={profilePath} />
		</>
	);
}

/** The desktop user-nav theme submenu, matching the website's icon treatment. */
export function DesktopThemeSubmenu() {
	const { setTheme } = useTheme();

	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger>
				<ClassicThemeIcon className="size-4 shrink-0" />
				<span>Theme</span>
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent>
				<DropdownMenuItem onClick={() => setTheme("light")}>
					<MenuIcon icon={Sun03Icon} />
					Light
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => setTheme("dark")}>
					<MenuIcon icon={Moon02Icon} />
					Dark
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => setTheme("system")}>
					<MenuIcon icon={LaptopIcon} />
					System
				</DropdownMenuItem>
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	);
}

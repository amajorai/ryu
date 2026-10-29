import { Add01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useI18n } from "@ryu/i18n/react";
import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import {
	DitherAvatar,
	ditherAvatarSeed,
} from "@ryu/ui/components/dither-kit/avatar.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type ReactNode, useLayoutEffect } from "react";
import { useSession } from "@/lib/auth-client.ts";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import { useAppStore } from "@/src/store/useAppStore.ts";
import { useCreateAgentDialog } from "@/src/store/useCreateAgentDialog.ts";
import "./CompactRail.css";
import { CompactRailMenuItem } from "./appearance-context-menu.tsx";
import { CompactRailAgents, RailDivider } from "./compact-rail-agents.tsx";

const COMPACT_RAIL_ATTRIBUTE = "data-ryu-compact-rail";

interface CompactRailProps {
	isMac: boolean;
	onOpenNavigation: () => void;
	onSearch: () => void;
	showSearch: boolean;
}

function RailActionButton({
	children,
	label,
	onClick,
}: {
	children: ReactNode;
	label: string;
	onClick: () => void;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						aria-label={label}
						className="size-10 shrink-0 rounded-xl text-muted-foreground hover:text-foreground"
						onClick={onClick}
						size="icon"
						variant="ghost"
					>
						{children}
					</Button>
				}
			/>
			<TooltipContent side="right">{label}</TooltipContent>
		</Tooltip>
	);
}

/** The signed-in user's avatar. The rail has no room for the account menu, so
 *  the avatar opens the full navigation, whose footer carries it. */
function RailAccountButton({
	label,
	onClick,
}: {
	label: string;
	onClick: () => void;
}) {
	const { data: session } = useSession();
	const oidcUser = useAppStore((state) => state.oidcUser);
	const user = session?.user ?? {
		id: undefined,
		email: oidcUser?.email ?? null,
		image: oidcUser?.picture ?? null,
		name: oidcUser?.name ?? null,
	};
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						aria-label={label}
						className="flex size-10 shrink-0 items-center justify-center rounded-full focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60"
						data-testid="compact-rail-account"
						onClick={onClick}
						type="button"
					>
						<Avatar className="size-8">
							<AvatarImage alt="" src={user.image ?? undefined} />
							<AvatarFallback appearance="artwork" className="overflow-hidden">
								<DitherAvatar
									className="size-full"
									name={ditherAvatarSeed({
										id: user.id,
										email: user.email,
										name: user.name,
									})}
								/>
							</AvatarFallback>
						</Avatar>
					</button>
				}
			/>
			<TooltipContent side="right">{label}</TooltipContent>
		</Tooltip>
	);
}

/**
 * The left navigation at narrow widths: one column of agent avatars, with
 * create, search, and the full menu at the bottom.
 *
 * It is fixed to the window edge and marks the root while mounted, so
 * `CompactRail.css` can inset the content to clear it and retire the chrome
 * the rail replaces (the floating nav cluster's title-bar gap and the
 * hover-to-peek strip). Unmounting removes the mark, so nothing outlives it.
 */
export function CompactRail({
	isMac,
	onOpenNavigation,
	onSearch,
	showSearch,
}: CompactRailProps) {
	const { t } = useI18n();
	const { nativeWindowChrome } = useAppSurface();
	const openCreateAgent = useCreateAgentDialog(
		(state) => state.openCreateAgent
	);

	// The native macOS window keeps its traffic lights at the top-left, which is
	// now the rail; it widens just enough to hold them above the roster.
	const clearsTrafficLights = nativeWindowChrome && isMac;
	useLayoutEffect(() => {
		const root = document.documentElement;
		root.setAttribute(
			COMPACT_RAIL_ATTRIBUTE,
			clearsTrafficLights ? "traffic-lights" : ""
		);
		return () => root.removeAttribute(COMPACT_RAIL_ATTRIBUTE);
	}, [clearsTrafficLights]);

	const searchLabel = t("shell.search", undefined, "Search");
	const menuLabel = t("shell.open-menu", undefined, "Open menu");

	return (
		<ContextMenu>
			<ContextMenuTrigger
				render={
					<nav
						aria-label="Agents"
						className={cn(
							"fixed inset-y-0 left-0 z-40 flex w-[var(--ryu-compact-rail-width,4.5rem)] flex-col items-center pb-2",
							clearsTrafficLights ? "pt-11" : "pt-2"
						)}
						data-tauri-drag-region
						data-testid="compact-rail"
					/>
				}
			>
				<div className="scroll-fade flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto overscroll-contain py-1 [scrollbar-width:none]">
					<CompactRailAgents />
				</div>
				<RailDivider />
				<div className="flex flex-col items-center gap-1 pt-1">
					<RailActionButton label="New agent" onClick={openCreateAgent}>
						<HugeiconsIcon className="size-5" icon={Add01Icon} />
					</RailActionButton>
					{showSearch ? (
						<RailActionButton label={searchLabel} onClick={onSearch}>
							<HugeiconsIcon className="size-5" icon={Search01Icon} />
						</RailActionButton>
					) : null}
					<RailAccountButton label={menuLabel} onClick={onOpenNavigation} />
				</div>
			</ContextMenuTrigger>
			<ContextMenuContent>
				<CompactRailMenuItem />
			</ContextMenuContent>
		</ContextMenu>
	);
}

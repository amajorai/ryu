import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import AppIcon from "@ryu/marketplace/catalog/chrome/app-icon";
import type { CardDither } from "@ryu/marketplace/catalog/types";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { KeyboardEvent } from "react";

/** The same density progression as the pinned-agent shelf. */
export type AppStageLayout = "hero" | "pair" | "grid";

export interface PinnedAppItem {
	cacheKey?: string | null;
	dither?: CardDither | null;
	iconBackground?: string | null;
	iconId?: string | null;
	iconPadding?: string | null;
	iconUrl?: string | null;
	id: string;
	label: string;
	seedId: string;
	target: string;
}

export function appStageLayout(count: number): AppStageLayout {
	if (count <= 1) {
		return "hero";
	}
	if (count === 2) {
		return "pair";
	}
	return "grid";
}

const LAYOUT_STYLES: Record<
	AppStageLayout,
	{ avatarSize: string; grid: string; label: string; tile: string }
> = {
	hero: {
		avatarSize: "64px",
		grid: "grid-cols-1",
		label: "text-sm",
		tile: "min-h-28 flex-row gap-3 p-3",
	},
	pair: {
		avatarSize: "44px",
		grid: "grid-cols-2",
		label: "text-xs",
		tile: "min-h-24 flex-col justify-center gap-1.5 p-2",
	},
	grid: {
		avatarSize: "32px",
		grid: "grid-cols-3",
		label: "text-[11px]",
		tile: "min-h-[76px] flex-col justify-center gap-1 p-1.5",
	},
};

function openOnKeyboard(
	event: KeyboardEvent<HTMLButtonElement>,
	onOpen: () => void
) {
	if (event.key === "Enter" || event.key === " ") {
		event.preventDefault();
		onOpen();
	}
}

function AppTile({
	app,
	layout,
	onOpen,
}: {
	app: PinnedAppItem;
	layout: AppStageLayout;
	onOpen: (app: PinnedAppItem, newTab: boolean) => void;
}) {
	const styles = LAYOUT_STYLES[layout];
	const hero = layout === "hero";
	return (
		<button
			aria-label={`Open ${app.label}`}
			className={cn(
				"group/app relative flex items-center overflow-hidden rounded-xl border border-transparent bg-transparent text-left outline-hidden transition-[background-color,border-color,transform] hover:-translate-y-px hover:border-sidebar-border/70 hover:bg-sidebar-accent/60 focus-visible:border-sidebar-border/70 focus-visible:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring/60",
				styles.tile,
				hero && "sm:gap-4"
			)}
			onAuxClick={(event) => {
				if (event.button === 1) {
					event.preventDefault();
					onOpen(app, true);
				}
			}}
			onClick={() => onOpen(app, false)}
			onKeyDown={(event) => openOnKeyboard(event, () => onOpen(app, false))}
			title={app.label}
			type="button"
		>
			<AppIcon
				cacheKey={app.cacheKey}
				className={cn(
					"shrink-0 rounded-2xl",
					hero
						? "size-16"
						: layout === "pair"
							? "size-11 rounded-xl"
							: "size-8 rounded-xl"
				)}
				dither={app.dither}
				iconBackground={app.iconBackground}
				iconId={app.iconId}
				iconPadding={app.iconPadding}
				iconUrl={app.iconUrl}
				name={app.label}
				seedId={app.seedId}
				size={hero ? 28 : layout === "pair" ? 20 : 16}
				variant={hero ? "hero" : "card"}
			/>
			<span
				className={cn(
					"min-w-0 truncate font-medium text-foreground",
					hero ? "flex-1" : "w-full text-center",
					styles.label
				)}
			>
				{app.label}
			</span>
		</button>
	);
}

/** Compact app shelf: one hero, two-up, then a maximum three-column grid. */
export function PinnedAppStage({
	apps,
	onOpenNewWindow,
	onOpen,
	onReport,
}: {
	apps: PinnedAppItem[];
	onOpenNewWindow?: (app: PinnedAppItem) => void;
	onOpen: (app: PinnedAppItem, newTab: boolean) => void;
	onReport?: (app: PinnedAppItem) => void;
}) {
	if (apps.length === 0) {
		return null;
	}

	const layout = appStageLayout(apps.length);
	return (
		<div
			aria-label="Installed apps"
			className="space-y-1.5 px-2 pb-2"
			data-layout={layout}
			data-testid="sidebar-app-stage"
		>
			<div className="flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground uppercase tracking-[0.12em]">
				<span>Apps</span>
				<span className="text-muted-foreground/60 tabular-nums">
					{apps.length}
				</span>
			</div>
			<div className={cn("grid gap-1.5", LAYOUT_STYLES[layout].grid)}>
				{apps.map((app) => (
					<ContextMenu key={app.id}>
						<ContextMenuTrigger>
							<AppTile app={app} layout={layout} onOpen={onOpen} />
						</ContextMenuTrigger>
						<ContextMenuContent>
							<ContextMenuItem onClick={() => onOpen(app, false)}>
								Open
							</ContextMenuItem>
							<ContextMenuItem onClick={() => onOpen(app, true)}>
								<HugeiconsIcon
									className="mr-2 size-4"
									icon={ArrowUpRight01Icon}
								/>
								Open in new tab
							</ContextMenuItem>
							{onOpenNewWindow ? (
								<ContextMenuItem onClick={() => onOpenNewWindow(app)}>
									Open in new window
								</ContextMenuItem>
							) : null}
							{onReport ? (
								<ContextMenuItem onClick={() => onReport(app)}>
									Report
								</ContextMenuItem>
							) : null}
						</ContextMenuContent>
					</ContextMenu>
				))}
			</div>
		</div>
	);
}

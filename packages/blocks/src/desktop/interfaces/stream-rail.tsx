import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Logo } from "@ryu/ui/components/logo.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	Heart,
	House,
	type LucideIcon,
	Plus,
	Search,
	User,
} from "lucide-react";
import type { StreamView } from "./stream-model.ts";

export const STREAM_FOCUS =
	"outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

interface RailItem {
	/** Active icons fill in, the way the reference marks the current page. */
	fills: boolean;
	icon: LucideIcon;
	label: string;
	view: StreamView | "create";
}

const ITEMS: RailItem[] = [
	{ fills: true, icon: House, label: "Home", view: "home" },
	{ fills: false, icon: Search, label: "Search", view: "search" },
	{ fills: false, icon: Plus, label: "Create", view: "create" },
	{ fills: true, icon: Heart, label: "Activity", view: "activity" },
	{ fills: true, icon: User, label: "Profile", view: "profile" },
];

export interface StreamNavProps {
	activityCount: number;
	/** The current page; a post page keeps the page it was opened from. */
	current: StreamView | null;
	onCreate: () => void;
	onNavigate: (view: StreamView) => void;
}

/** The icon, with the unread dot pinned to its corner for Activity. */
function NavIcon({
	active,
	dot,
	item,
	size,
}: {
	active: boolean;
	dot: boolean;
	item: RailItem;
	size: "rail" | "bar";
}) {
	const Icon = item.icon;
	return (
		<span className="relative flex">
			<Icon
				aria-hidden="true"
				className={size === "rail" ? "size-[26px]" : "size-6"}
				fill={active && item.fills ? "currentColor" : "none"}
				strokeWidth={active ? 2.25 : 1.75}
			/>
			{dot ? (
				<span
					aria-hidden="true"
					className="absolute -top-0.5 -right-1 size-2 rounded-full bg-destructive ring-2 ring-background"
				/>
			) : null}
		</span>
	);
}

function itemLabel(
	item: RailItem,
	activityCount: number,
	tl: LiteralMessage
): string {
	if (item.view === "activity" && activityCount > 0) {
		return tl("Activity, {activityCount} waiting on you", {
			activityCount: String(activityCount),
		});
	}
	return item.label;
}

/**
 * The slim left rail: the mark on top, then the five destinations centred
 * down the edge. Create is the one boxed control, as in the reference.
 */
export function StreamRail({
	activityCount,
	current,
	onCreate,
	onNavigate,
}: StreamNavProps) {
	const tl = useLiteralMessages();
	return (
		<aside className="@min-[640px]:flex hidden h-full w-[76px] shrink-0 flex-col items-center py-5">
			{/* A pointer shortcut home; keyboard users reach Home in the nav. */}
			<button
				aria-label="Ryu"
				className={cn(
					"flex size-12 items-center justify-center rounded-xl",
					STREAM_FOCUS
				)}
				onClick={() => onNavigate("home")}
				tabIndex={-1}
				type="button"
			>
				<Logo size="32px" tone="foreground" variant="outline" />
			</button>
			<nav
				aria-label="Stream"
				className="flex flex-1 flex-col items-center justify-center gap-1.5"
			>
				{ITEMS.map((item) => {
					const active = item.view === current;
					const create = item.view === "create";
					const label = itemLabel(item, activityCount, tl);
					return (
						<Tooltip key={item.label}>
							<TooltipTrigger
								aria-current={active ? "page" : undefined}
								aria-label={label}
								className={cn(
									"relative flex h-12 w-[60px] items-center justify-center rounded-xl transition-colors duration-150",
									create &&
										"bg-muted text-muted-foreground hover:text-foreground",
									!create &&
										(active
											? "text-foreground"
											: "text-muted-foreground hover:bg-muted hover:text-foreground"),
									STREAM_FOCUS
								)}
								onClick={() =>
									item.view === "create" ? onCreate() : onNavigate(item.view)
								}
								type="button"
							>
								<NavIcon
									active={active}
									dot={item.view === "activity" && activityCount > 0}
									item={item}
									size="rail"
								/>
							</TooltipTrigger>
							<TooltipContent side="right">{item.label}</TooltipContent>
						</Tooltip>
					);
				})}
			</nav>
			<span aria-hidden="true" className="size-12" />
		</aside>
	);
}

/** The same five destinations as a bottom tab bar on narrow widths. */
export function StreamTabBar({
	activityCount,
	current,
	onCreate,
	onNavigate,
}: StreamNavProps) {
	const tl = useLiteralMessages();
	return (
		<nav
			aria-label="Stream"
			className="flex @min-[640px]:hidden h-14 shrink-0 items-stretch border-border border-t bg-background"
		>
			{ITEMS.map((item) => {
				const active = item.view === current;
				return (
					<button
						aria-current={active ? "page" : undefined}
						aria-label={itemLabel(item, activityCount, tl)}
						className={cn(
							"relative flex flex-1 items-center justify-center transition-colors",
							active
								? "text-foreground"
								: "text-muted-foreground hover:text-foreground",
							STREAM_FOCUS,
							"focus-visible:ring-inset focus-visible:ring-offset-0"
						)}
						key={item.label}
						onClick={() =>
							item.view === "create" ? onCreate() : onNavigate(item.view)
						}
						type="button"
					>
						<NavIcon
							active={active}
							dot={item.view === "activity" && activityCount > 0}
							item={item}
							size="bar"
						/>
					</button>
				);
			})}
		</nav>
	);
}

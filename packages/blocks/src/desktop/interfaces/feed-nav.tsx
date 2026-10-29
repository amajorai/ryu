import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { Logo } from "@ryu/ui/components/logo.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	Ellipsis,
	type LucideIcon,
	Pin,
	Search,
	SquarePen,
	Users,
	Zap,
} from "lucide-react";
import type { ComponentProps } from "react";
import {
	AuthorName,
	FEED_FOCUS,
	FEED_META,
	FeedAvatar,
	YOU,
} from "./feed-parts.tsx";

export type FeedView = "agents" | "home" | "pinned" | "search" | "working";

/** House outline whose filled (active) state keeps the door cut out. */
export function HomeIcon({ className, strokeWidth }: ComponentProps<"svg">) {
	return (
		<svg
			aria-hidden="true"
			className={className}
			fill="none"
			stroke="currentColor"
			strokeLinejoin="round"
			strokeWidth={strokeWidth}
			viewBox="0 0 24 24"
		>
			<path d="M3 10.2 12 3l9 7.2V21h-6.2v-6.4H9.2V21H3z" />
		</svg>
	);
}

/** Active items fill in; an outline-only glyph (search) thickens instead. */
export function navStroke(active: boolean, view: FeedView): number {
	if (!active) {
		return 1.75;
	}
	return view === "search" ? 2.75 : 2.25;
}

export interface FeedNavItem {
	icon: LucideIcon | typeof HomeIcon;
	label: string;
	/** Only offered while the sidebar (and its search box) is hidden. */
	narrowOnly?: boolean;
	view: FeedView;
}

export const NAV_ITEMS: FeedNavItem[] = [
	{ icon: HomeIcon, label: "Home", view: "home" },
	{ icon: Search, label: "Search", narrowOnly: true, view: "search" },
	{ icon: Zap, label: "Working", view: "working" },
	{ icon: Pin, label: "Pinned", view: "pinned" },
	{ icon: Users, label: "Agents", view: "agents" },
];

/**
 * Left navigation rail. Wide containers get icon + label rows; narrower ones
 * collapse to an icon column; the narrowest hide it entirely.
 */
export function FeedNavRail({
	onPost,
	onSelect,
	view,
	workingCount,
}: {
	onPost: () => void;
	onSelect: (view: FeedView) => void;
	view: FeedView;
	workingCount: number;
}) {
	const tl = useLiteralMessages();
	return (
		<header className="@min-[700px]:flex hidden h-full @min-[1280px]:w-[275px] w-[88px] shrink-0">
			<div className="flex h-full w-full flex-col items-center @min-[1280px]:items-stretch overflow-y-auto px-2">
				<div className="flex flex-col @min-[1280px]:items-start items-center">
					<button
						aria-label="Home timeline"
						className={cn(
							"my-0.5 flex size-[52px] items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted",
							FEED_FOCUS
						)}
						onClick={() => onSelect("home")}
						type="button"
					>
						<Logo size="30px" tone="foreground" variant="outline" />
					</button>
					<nav aria-label="Feed views" className="mt-0.5 mb-1 flex flex-col">
						{NAV_ITEMS.map(
							({ icon: Icon, label, narrowOnly, view: itemView }) => {
								const active = view === itemView;
								const badge = itemView === "working" && workingCount > 0;
								return (
									<button
										aria-current={active ? "page" : undefined}
										aria-label={
											badge
												? tl("{label}, {workingCount} running", {
														label,
														workingCount,
													})
												: label
										}
										className={cn(
											"group flex w-full py-1 outline-none",
											narrowOnly && "@min-[1000px]:hidden"
										)}
										key={itemView}
										onClick={() => onSelect(itemView)}
										type="button"
									>
										<span
											className={cn(
												"flex items-center gap-5 rounded-full p-3 transition-colors group-hover:bg-muted",
												"group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-background",
												"text-foreground",
												"@min-[1280px]:pr-6"
											)}
										>
											<span className="relative">
												<Icon
													aria-hidden="true"
													className={cn(
														"size-[26px]",
														active && itemView !== "search" && "fill-current"
													)}
													strokeWidth={navStroke(active, itemView)}
												/>
												{badge ? (
													<Badge
														aria-hidden="true"
														className="absolute -top-1.5 -right-1.5 h-[18px] min-w-[18px] bg-primary px-1 font-bold text-[11px] text-primary-foreground ring-2 ring-background"
														radius="pill"
														typography="tabular"
													>
														{workingCount}
													</Badge>
												) : null}
											</span>
											<span
												className={cn(
													"@min-[1280px]:inline hidden text-[19px] leading-6",
													active ? "font-semibold" : "font-normal"
												)}
											>
												{label}
											</span>
										</span>
									</button>
								);
							}
						)}
					</nav>
				</div>
				<Button
					aria-label="Post a new task"
					className={cn(
						"my-4 size-[52px] rounded-full p-0 font-semibold text-base shadow-none",
						"@min-[1280px]:w-[90%]"
					)}
					onClick={onPost}
					type="button"
				>
					<SquarePen
						aria-hidden="true"
						className="@min-[1280px]:hidden size-6"
					/>
					<span aria-hidden="true" className="@min-[1280px]:inline hidden">
						Post
					</span>
				</Button>
				{/* X's account switcher: avatar, name and handle, a trailing more glyph. */}
				<DropdownMenu>
					<DropdownMenuTrigger
						aria-label="Account menu"
						className={cn(
							"mt-auto mb-3 flex @min-[1280px]:w-full shrink-0 items-center gap-3 rounded-full p-3 text-left text-foreground transition-colors hover:bg-muted data-popup-open:bg-muted",
							FEED_FOCUS
						)}
					>
						<FeedAvatar author={YOU} />
						<span className="@min-[1280px]:flex hidden min-w-0 flex-1 flex-col text-[15px] leading-5">
							<AuthorName author={YOU} />
							<span className={cn("truncate", FEED_META)}>{YOU.handle}</span>
						</span>
						<Ellipsis
							aria-hidden="true"
							className="@min-[1280px]:block hidden size-[18px] shrink-0"
						/>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="min-w-56" side="top">
						<DropdownMenuItem onClick={onPost}>New post</DropdownMenuItem>
						<DropdownMenuItem onClick={() => onSelect("agents")}>
							Your agents
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</header>
	);
}

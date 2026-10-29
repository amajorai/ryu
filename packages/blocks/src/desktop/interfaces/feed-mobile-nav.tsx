import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { SquarePen } from "lucide-react";
import { type FeedView, NAV_ITEMS, navStroke } from "./feed-nav.tsx";

/**
 * Narrow layout (under 700px): the rail and sidebar give way to a bottom tab
 * bar and a floating post button, the way the timeline app does on phones.
 */
export function FeedMobileNav({
	onPost,
	onSelect,
	showPostButton,
	view,
	workingCount,
}: {
	onPost: () => void;
	onSelect: (view: FeedView) => void;
	showPostButton: boolean;
	view: FeedView;
	workingCount: number;
}) {
	const tl = useLiteralMessages();
	return (
		<>
			{showPostButton ? (
				<Button
					aria-label="Post a new task"
					className="absolute right-4 bottom-[69px] z-30 @max-[700px]:flex hidden size-14 rounded-full p-0 shadow-md"
					onClick={onPost}
					type="button"
				>
					<SquarePen aria-hidden="true" className="size-6" strokeWidth={2.25} />
				</Button>
			) : null}
			<nav
				aria-label="Feed views"
				className="absolute inset-x-0 bottom-0 z-30 @max-[700px]:flex hidden h-[53px] border-border border-t bg-background"
			>
				{NAV_ITEMS.map(({ icon: Icon, label, view: itemView }) => {
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
								"group flex flex-1 items-center justify-center text-foreground outline-none"
							)}
							key={itemView}
							onClick={() => onSelect(itemView)}
							type="button"
						>
							<span className="relative flex size-11 items-center justify-center rounded-full transition-colors group-hover:bg-muted group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-background">
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
										className="absolute top-0.5 right-0.5 h-[18px] min-w-[18px] px-1 font-semibold text-[11px] ring-2 ring-background"
										radius="pill"
										typography="tabular"
									>
										{workingCount}
									</Badge>
								) : null}
							</span>
						</button>
					);
				})}
			</nav>
		</>
	);
}

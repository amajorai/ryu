import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { LayoutList, Rows3 } from "lucide-react";
import { type KeyboardEvent, useRef } from "react";
import {
	COMMUNITY_SORTS,
	type CommunitySort,
	type CommunityViewMode,
} from "./community-model.ts";

export interface SortBarProps {
	mode: CommunityViewMode;
	onMode: (mode: CommunityViewMode) => void;
	onSort: (sort: CommunitySort) => void;
	panelId: string;
	sort: CommunitySort;
	tabId: (sort: CommunitySort) => string;
}

const MODES: readonly {
	icon: typeof Rows3;
	id: CommunityViewMode;
	label: string;
}[] = [
	{ icon: Rows3, id: "card", label: "Card view" },
	{ icon: LayoutList, id: "compact", label: "Compact view" },
];

/** Hot / New / Top as pill tabs, with the view switch at the far end. */
export function SortBar({
	mode,
	onMode,
	onSort,
	panelId,
	sort,
	tabId,
}: SortBarProps) {
	const tabs = useRef(new Map<CommunitySort, HTMLButtonElement>());
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const step =
			{ ArrowLeft: -1, ArrowRight: 1 }[event.key] ??
			(event.key === "Home" || event.key === "End" ? 0 : null);
		if (step === null) {
			return;
		}
		event.preventDefault();
		const index = COMMUNITY_SORTS.findIndex((item) => item.id === sort);
		let next = (index + step + COMMUNITY_SORTS.length) % COMMUNITY_SORTS.length;
		if (event.key === "Home") {
			next = 0;
		} else if (event.key === "End") {
			next = COMMUNITY_SORTS.length - 1;
		}
		const target = COMMUNITY_SORTS[next];
		if (target) {
			onSort(target.id);
			tabs.current.get(target.id)?.focus();
		}
	};
	return (
		<div className="flex items-center justify-between gap-3 px-4 py-2">
			<div
				aria-label="Sort posts"
				className="flex items-center gap-1"
				onKeyDown={onKeyDown}
				role="tablist"
			>
				{COMMUNITY_SORTS.map((item) => {
					const selected = item.id === sort;
					return (
						<button
							aria-controls={panelId}
							aria-selected={selected}
							className={cn(
								"h-8 rounded-full px-3 font-semibold text-sm outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-ring/50",
								selected
									? "bg-secondary text-foreground"
									: "text-muted-foreground hover:bg-muted hover:text-foreground"
							)}
							id={tabId(item.id)}
							key={item.id}
							onClick={() => onSort(item.id)}
							ref={(element) => {
								if (element) {
									tabs.current.set(item.id, element);
								} else {
									tabs.current.delete(item.id);
								}
							}}
							role="tab"
							tabIndex={selected ? 0 : -1}
							type="button"
						>
							{item.label}
						</button>
					);
				})}
			</div>
			<fieldset className="flex items-center gap-0.5">
				<legend className="sr-only">View</legend>
				{MODES.map((item) => {
					const Icon = item.icon;
					const active = item.id === mode;
					return (
						<Tooltip key={item.id}>
							<TooltipTrigger
								render={
									<button
										aria-label={item.label}
										aria-pressed={active}
										className={cn(
											"flex size-8 items-center justify-center rounded-full outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-ring/50",
											active
												? "bg-secondary text-foreground"
												: "text-muted-foreground hover:bg-muted hover:text-foreground"
										)}
										onClick={() => onMode(item.id)}
										type="button"
									/>
								}
							>
								<Icon
									aria-hidden="true"
									className="size-4"
									strokeWidth={1.75}
								/>
							</TooltipTrigger>
							<TooltipContent>{item.label}</TooltipContent>
						</Tooltip>
					);
				})}
			</fieldset>
		</div>
	);
}

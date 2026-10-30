import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import {
	ToggleGroup,
	ToggleGroupItem,
} from "@ryu/ui/components/toggle-group.tsx";
import {
	CalendarCheck,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	PanelLeft,
	Plus,
} from "lucide-react";
import type { RefObject } from "react";
import { type CalendarScale, rangeTitleShort } from "./calendar-model.ts";

/**
 * The scale toggle speaks the toolbar's one button language: an outlined
 * group the height of Today, the chosen segment filled with muted.
 */
const SEGMENT_CLASS =
	"h-6.5 rounded-md px-2.5 text-sm text-muted-foreground hover:text-foreground aria-pressed:bg-muted aria-pressed:font-medium aria-pressed:text-foreground aria-pressed:shadow-none";

/**
 * Header icon buttons share the toolbar's rounded-lg square; the sidebar
 * toggle says it is open through aria-expanded alone, never with a fill.
 */
const HEADER_ICON_CLASS =
	"rounded-lg aria-expanded:bg-transparent aria-expanded:text-muted-foreground aria-expanded:hover:bg-muted aria-expanded:hover:text-foreground";

const SCALE_LABELS: Record<CalendarScale, string> = {
	month: "Month",
	week: "Week",
};

interface CalendarHeaderProps {
	anchor: Date;
	chooseScale: (value: CalendarScale) => void;
	loading: boolean;
	newThread: (() => void) | null;
	railInline: boolean;
	railShown: boolean;
	railToggleRef: RefObject<HTMLButtonElement | null>;
	scale: CalendarScale;
	selectDay: (key: string) => void;
	step: (offset: -1 | 1) => void;
	title: string;
	todayKey: string;
	toggleRail: () => void;
}

/** The toolbar: sidebar toggle, Today, paging, the range title, and the scale. */
export function CalendarHeader({
	anchor,
	chooseScale,
	loading,
	newThread,
	railInline,
	railShown,
	railToggleRef,
	scale,
	selectDay,
	step,
	title,
	todayKey,
	toggleRail,
}: CalendarHeaderProps) {
	const tl = useLiteralMessages();
	return (
		<header className="flex h-14 shrink-0 items-center gap-1.5 border-border border-b px-3 sm:gap-3">
			<Button
				aria-expanded={railShown}
				aria-label={railShown ? "Hide sidebar" : "Show sidebar"}
				className={HEADER_ICON_CLASS}
				disabled={loading}
				onClick={toggleRail}
				ref={railToggleRef}
				size="icon-sm"
				title={railShown ? "Hide sidebar" : "Show sidebar"}
				type="button"
				variant="ghost-muted"
			>
				<PanelLeft aria-hidden="true" />
			</Button>
			<h1 className="sr-only">Calendar</h1>
			<Button
				className="rounded-lg max-sm:hidden"
				disabled={loading}
				onClick={() => selectDay(todayKey)}
				size="sm"
				title="Go to today (T)"
				type="button"
				variant="outline"
			>
				Today
			</Button>
			<Button
				aria-label="Today"
				className="rounded-lg sm:hidden"
				disabled={loading}
				onClick={() => selectDay(todayKey)}
				size="icon-sm"
				title="Go to today (T)"
				type="button"
				variant="outline"
			>
				<CalendarCheck aria-hidden="true" />
			</Button>
			<div className="flex items-center">
				<Button
					aria-label={scale === "month" ? "Previous month" : "Previous week"}
					className={HEADER_ICON_CLASS}
					disabled={loading}
					onClick={() => step(-1)}
					size="icon-sm"
					title={scale === "month" ? "Previous month" : "Previous week"}
					type="button"
					variant="ghost-muted"
				>
					<ChevronLeft aria-hidden="true" />
				</Button>
				<Button
					aria-label={scale === "month" ? "Next month" : "Next week"}
					className={HEADER_ICON_CLASS}
					disabled={loading}
					onClick={() => step(1)}
					size="icon-sm"
					title={scale === "month" ? "Next month" : "Next week"}
					type="button"
					variant="ghost-muted"
				>
					<ChevronRight aria-hidden="true" />
				</Button>
			</div>
			<h2
				aria-live="polite"
				className="min-w-0 flex-1 truncate whitespace-nowrap font-heading font-normal text-base text-foreground sm:text-xl"
				data-testid="calendar-range-title"
			>
				<span className="max-sm:hidden">{title}</span>
				<span className="sm:hidden">{rangeTitleShort(scale, anchor)}</span>
			</h2>
			<p className="items-center gap-1 text-muted-foreground text-xs max-2xl:hidden 2xl:flex">
				<Kbd>←</Kbd>
				<Kbd>→</Kbd>
				<span>days</span>
				<Kbd className="ms-1.5">T</Kbd>
				<span>today</span>
			</p>
			<ToggleGroup
				appearance="segmented"
				aria-label="Calendar scale"
				className="h-8 border border-border bg-background max-sm:hidden dark:bg-transparent"
				multiple={false}
				onValueChange={(values: string[]) => {
					const value = values[0];
					if (value === "month" || value === "week") {
						chooseScale(value);
					}
				}}
				spacing={0}
				value={[scale]}
			>
				<ToggleGroupItem
					className={SEGMENT_CLASS}
					density="segmented"
					title="Month (M)"
					value="month"
				>
					Month
				</ToggleGroupItem>
				<ToggleGroupItem
					className={SEGMENT_CLASS}
					density="segmented"
					title="Week (W)"
					value="week"
				>
					Week
				</ToggleGroupItem>
			</ToggleGroup>
			{/* A phone has no room for two segments: one menu, like the reference's mobile view. */}
			<DropdownMenu>
				<DropdownMenuTrigger
					aria-label={tl("Calendar scale: {scale}", {
						scale: SCALE_LABELS[scale],
					})}
					disabled={loading}
					render={
						<button
							className="flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 font-medium text-foreground text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-muted sm:hidden"
							type="button"
						/>
					}
				>
					{SCALE_LABELS[scale]}
					<ChevronDown
						aria-hidden="true"
						className="size-4 text-muted-foreground"
					/>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="end"
					className="w-36"
					drawerLabel="Calendar scale"
				>
					<DropdownMenuRadioGroup
						onValueChange={(value: string) => {
							if (value === "month" || value === "week") {
								chooseScale(value);
							}
						}}
						value={scale}
					>
						<DropdownMenuRadioItem value="month">Month</DropdownMenuRadioItem>
						<DropdownMenuRadioItem value="week">Week</DropdownMenuRadioItem>
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>
			{/* With the rail hidden, its New thread action moves into the header, unchanged. */}
			{newThread && !railInline ? (
				<Button
					aria-label="New thread"
					className="rounded-lg max-md:px-2"
					onClick={newThread}
					size="sm"
					title="New thread"
					type="button"
					variant="outline"
				>
					<Plus aria-hidden="true" data-icon="inline-start" />
					<span className="max-md:hidden">New thread</span>
				</Button>
			) : null}
		</header>
	);
}

import { cn } from "@ryu/ui/lib/utils";

/** The calendar's one small type size: hour labels, weekday names, captions. */
export const MICRO_TEXT_CLASS = "text-xs leading-4";
/** Section labels and weekday headings: the small caps eyebrow. */
export const EYEBROW_CLASS = cn(
	MICRO_TEXT_CLASS,
	"font-medium text-muted-foreground uppercase tracking-wide"
);
/** The one radius for everything drawn on the grid: chips, blocks, pills. */
export const ITEM_RADIUS_CLASS = "rounded-[4px]";

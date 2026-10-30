import { cn } from "@ryu/ui/lib/utils";

export const UI_TYPE =
	"font-(family-name:--sv-font) font-normal [font-synthesis:none]";

/** A small wooden plank button that presses down. */
export const PLANK_BUTTON = cn(
	"inline-flex h-8 items-center gap-2 text-[16px] leading-none outline-none hover:brightness-110 focus-visible:outline-(--sv-focus) focus-visible:outline-2 focus-visible:outline-offset-2 active:translate-y-px",
	UI_TYPE
);

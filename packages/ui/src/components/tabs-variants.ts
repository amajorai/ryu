import { cn } from "@ryu/ui/lib/utils.ts";
import { cva } from "class-variance-authority";

const tabsListVariants = cva(
	// `relative` on every variant (not just segmented) so an optional sliding
	// TabsIndicator can anchor its absolute box against any list.
	"group/tabs-list group-data-vertical/tabs:corner-squircle relative inline-flex w-fit items-center justify-center rounded-full p-1 text-muted-foreground data-[variant=line]:rounded-none group-data-horizontal/tabs:h-9 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col group-data-vertical/tabs:rounded-2xl",
	{
		variants: {
			variant: {
				default: "bg-muted",
				line: "gap-1 bg-transparent",
				// Stepper: a rule ABOVE each label rather than an underline below the
				// active one, so the strip reads as a sequence of steps you can see the
				// whole of at once. Every step stays selectable — it suggests an order
				// without enforcing one, which is what separates it from `stepper.tsx`
				// (that primitive has a notion of "reached" and gates on it).
				stepper:
					"w-full items-start gap-4 rounded-none bg-transparent p-0 group-data-horizontal/tabs:h-fit",
				pills:
					"flex-wrap gap-2 rounded-none bg-transparent p-0 group-data-horizontal/tabs:h-fit",
				// Label-only tabs: use a larger text treatment without painting a pill
				// behind either the active or inactive label.
				text: "gap-4 rounded-none bg-transparent p-0 group-data-horizontal/tabs:h-fit",
				// Same pill, more room. For surfaces where the tab strip IS the
				// primary control rather than a filter above a table — a share
				// dialog's Image/Video switch, say — and a 28px-tall pill reads as
				// incidental. Every `pills` rule below is written with a `^=pills`
				// prefix match so this variant inherits them and only overrides the
				// padding; duplicating a dozen classes per variant is how the two
				// would drift.
				"pills-lg":
					"flex-wrap gap-2 rounded-none bg-transparent p-0 group-data-horizontal/tabs:h-fit",
				// Compact filter pills: the active tab is a muted wash rather than the
				// high-contrast foreground pill used by the primary `pills` variant.
				"muted-pills":
					"flex-wrap gap-1 rounded-none bg-transparent p-0 group-data-horizontal/tabs:h-fit",
				segmented: "relative gap-1 bg-muted",
			},
			layout: {
				"catalog-sections": "h-auto max-h-40 flex-wrap gap-1",
				"listing-detail": "h-auto flex-wrap gap-1",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	}
);

const tabsTriggerClassName = cn(
	"t-tabs-trigger",
	"group-data-vertical/tabs:corner-squircle relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-full border border-transparent! px-3 py-1 font-medium text-foreground/60 text-sm transition-[color,background-color,border-color,box-shadow] hover:text-foreground focus-visible:border-ring focus-visible:outline-1 focus-visible:outline-ring focus-visible:ring-3 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-start]:ps-2 has-data-[icon=inline-end]:pe-2 aria-disabled:pointer-events-none aria-disabled:opacity-50 group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start group-data-vertical/tabs:rounded-2xl group-data-vertical/tabs:px-3 group-data-vertical/tabs:py-1.5 dark:text-muted-foreground dark:hover:text-foreground [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
	"group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent",
	// The rule is the trigger's own `::before`, so the label sits under it
	// with no extra element. `whitespace-normal` because a three-word step
	// clipped to "Reserve your han…" in a narrow column loses the one
	// instruction it exists to give — the rules are what align the strip,
	// so a second line only makes it taller.
	"group-data-[variant=stepper]/tabs-list:corner-squircle group-data-[variant=stepper]/tabs-list:h-auto group-data-[variant=stepper]/tabs-list:flex-col group-data-[variant=stepper]/tabs-list:items-start group-data-[variant=stepper]/tabs-list:gap-2 group-data-[variant=stepper]/tabs-list:whitespace-normal group-data-[variant=stepper]/tabs-list:rounded-sm group-data-[variant=stepper]/tabs-list:px-0 group-data-[variant=stepper]/tabs-list:py-0 group-data-[variant=stepper]/tabs-list:text-start group-data-[variant=stepper]/tabs-list:text-muted-foreground/60 group-data-[variant=stepper]/tabs-list:text-xs",
	"group-data-[variant=stepper]/tabs-list:before:h-1 group-data-[variant=stepper]/tabs-list:before:w-full group-data-[variant=stepper]/tabs-list:before:rounded-full group-data-[variant=stepper]/tabs-list:before:bg-border group-data-[variant=stepper]/tabs-list:before:transition-colors group-data-[variant=stepper]/tabs-list:before:content-['']",
	"group-data-[variant=stepper]/tabs-list:data-active:bg-transparent! group-data-[variant=stepper]/tabs-list:data-active:text-foreground group-data-[variant=stepper]/tabs-list:data-active:after:opacity-0 group-data-[variant=stepper]/tabs-list:data-active:before:bg-foreground",
	// `pills-lg` deliberately resolves to the same box as `pills`. The prefix
	// match covers both names so the two cannot drift again.
	"group-data-[variant^=pills]/tabs-list:h-auto group-data-[variant^=pills]/tabs-list:flex-initial group-data-[variant^=pills]/tabs-list:gap-2 group-data-[variant^=pills]/tabs-list:rounded-full group-data-[variant^=pills]/tabs-list:px-4 group-data-[variant^=pills]/tabs-list:py-2 group-data-[variant^=pills]/tabs-list:text-foreground group-data-[variant^=pills]/tabs-list:text-sm group-data-[variant^=pills]/tabs-list:hover:bg-black/5 group-data-[variant^=pills]/tabs-list:hover:text-foreground dark:group-data-[variant^=pills]/tabs-list:text-foreground dark:group-data-[variant^=pills]/tabs-list:hover:bg-white/10",
	"group-data-[variant^=pills]/tabs-list:data-active:border-transparent! group-data-[variant^=pills]/tabs-list:data-active:bg-black! group-data-[variant^=pills]/tabs-list:data-active:text-white! dark:group-data-[variant^=pills]/tabs-list:data-active:bg-white! dark:group-data-[variant^=pills]/tabs-list:data-active:text-black!",
	"group-data-[variant=text]/tabs-list:h-auto group-data-[variant=text]/tabs-list:flex-initial group-data-[variant=text]/tabs-list:gap-1 group-data-[variant=text]/tabs-list:rounded-none group-data-[variant=text]/tabs-list:bg-transparent! group-data-[variant=text]/tabs-list:px-0 group-data-[variant=text]/tabs-list:py-0 group-data-[variant=text]/tabs-list:text-base group-data-[variant=text]/tabs-list:text-muted-foreground group-data-[variant=text]/tabs-list:hover:bg-transparent! group-data-[variant=text]/tabs-list:hover:text-foreground dark:group-data-[variant=text]/tabs-list:text-muted-foreground dark:group-data-[variant=text]/tabs-list:hover:text-foreground",
	"group-data-[variant=text]/tabs-list:data-active:border-transparent! group-data-[variant=text]/tabs-list:data-active:bg-transparent! group-data-[variant=text]/tabs-list:data-active:text-foreground! dark:group-data-[variant=text]/tabs-list:data-active:bg-transparent! dark:group-data-[variant=text]/tabs-list:data-active:text-foreground!",
	"group-data-[variant=muted-pills]/tabs-list:h-auto group-data-[variant=muted-pills]/tabs-list:flex-initial group-data-[variant=muted-pills]/tabs-list:gap-1 group-data-[variant=muted-pills]/tabs-list:rounded-full group-data-[variant=muted-pills]/tabs-list:px-1 group-data-[variant=muted-pills]/tabs-list:py-1 group-data-[variant=muted-pills]/tabs-list:text-muted-foreground group-data-[variant=muted-pills]/tabs-list:text-xs group-data-[variant=muted-pills]/tabs-list:hover:bg-muted/60 group-data-[variant=muted-pills]/tabs-list:hover:text-foreground",
	"group-data-[variant=muted-pills]/tabs-list:data-active:border-transparent! group-data-[variant=muted-pills]/tabs-list:data-active:bg-muted! group-data-[variant=muted-pills]/tabs-list:data-active:text-foreground! dark:group-data-[variant=muted-pills]/tabs-list:data-active:bg-muted!",
	"data-active:bg-background data-active:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground",
	// Segmented: the sliding TabsIndicator owns the active background, so the
	// trigger itself stays transparent and only animates its text colour. It
	// sits above the indicator (z-10) so the label reads on top of the pill.
	"group-data-[variant=segmented]/tabs-list:z-10 group-data-[variant=segmented]/tabs-list:bg-transparent! group-data-[variant=segmented]/tabs-list:text-foreground/60 group-data-[variant=segmented]/tabs-list:data-active:border-transparent! group-data-[variant=segmented]/tabs-list:data-active:bg-transparent! group-data-[variant=segmented]/tabs-list:data-active:text-foreground group-data-[variant=segmented]/tabs-list:hover:text-foreground dark:group-data-[variant=segmented]/tabs-list:data-active:bg-transparent!",
	"after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
	// When a sliding TabsIndicator is present in the list, hand the active
	// visual (background / border / underline) over to it and keep the
	// trigger's own only its text colour.
	"group-has-[[data-slot=tabs-indicator]]/tabs-list:z-10 group-has-[[data-slot=tabs-indicator]]/tabs-list:data-active:border-transparent! group-has-[[data-slot=tabs-indicator]]/tabs-list:data-active:bg-transparent! group-has-[[data-slot=tabs-indicator]]/tabs-list:data-active:hover:bg-transparent! group-has-[[data-slot=tabs-indicator]]/tabs-list:data-active:after:opacity-0"
);

export { tabsListVariants, tabsTriggerClassName };

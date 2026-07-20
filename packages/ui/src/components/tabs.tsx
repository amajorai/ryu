"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "@ryu/ui/lib/utils.ts";
import { cva, type VariantProps } from "class-variance-authority";

function Tabs({
	className,
	orientation = "horizontal",
	...props
}: TabsPrimitive.Root.Props) {
	return (
		<TabsPrimitive.Root
			className={cn(
				"group/tabs flex gap-2 data-horizontal:flex-col",
				className
			)}
			data-orientation={orientation}
			data-slot="tabs"
			{...props}
		/>
	);
}

const tabsListVariants = cva(
	// `relative` on every variant (not just segmented) so an optional sliding
	// TabsIndicator can anchor its absolute box against any list.
	"group/tabs-list relative inline-flex w-fit items-center justify-center rounded-full p-1 text-muted-foreground data-[variant=line]:rounded-none group-data-horizontal/tabs:h-9 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col group-data-vertical/tabs:rounded-2xl",
	{
		variants: {
			variant: {
				default: "bg-muted",
				line: "gap-1 bg-transparent",
				pills:
					"flex-wrap gap-2 rounded-none bg-transparent p-0 group-data-horizontal/tabs:h-fit",
				segmented: "relative gap-1 bg-muted",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	}
);

function TabsList({
	className,
	variant = "default",
	...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
	return (
		<TabsPrimitive.List
			className={cn(tabsListVariants({ variant }), className)}
			data-slot="tabs-list"
			data-variant={variant}
			{...props}
		/>
	);
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
	return (
		<TabsPrimitive.Tab
			className={cn(
				"relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-full border border-transparent! px-3 py-1 font-medium text-foreground/60 text-sm transition-all hover:text-foreground focus-visible:border-ring focus-visible:outline-1 focus-visible:outline-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 aria-disabled:pointer-events-none aria-disabled:opacity-50 group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start group-data-vertical/tabs:rounded-2xl group-data-vertical/tabs:px-3 group-data-vertical/tabs:py-1.5 dark:text-muted-foreground dark:hover:text-foreground [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
				"group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent",
				"group-data-[variant=pills]/tabs-list:h-auto group-data-[variant=pills]/tabs-list:flex-initial group-data-[variant=pills]/tabs-list:rounded-full group-data-[variant=pills]/tabs-list:px-3 group-data-[variant=pills]/tabs-list:py-1 group-data-[variant=pills]/tabs-list:text-foreground/60 group-data-[variant=pills]/tabs-list:hover:bg-black/5 group-data-[variant=pills]/tabs-list:hover:text-foreground dark:group-data-[variant=pills]/tabs-list:text-foreground/60 dark:group-data-[variant=pills]/tabs-list:hover:bg-white/10",
				"group-data-[variant=pills]/tabs-list:data-active:border-transparent! group-data-[variant=pills]/tabs-list:data-active:bg-black! group-data-[variant=pills]/tabs-list:data-active:text-white group-data-[variant=pills]/tabs-list:data-active:hover:bg-black/80! dark:group-data-[variant=pills]/tabs-list:data-active:bg-white! dark:group-data-[variant=pills]/tabs-list:data-active:text-black dark:group-data-[variant=pills]/tabs-list:data-active:hover:bg-white/80!",
				"data-active:bg-background data-active:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground",
				// Segmented: the sliding TabsIndicator owns the active background, so the
				// trigger itself stays transparent and only animates its text colour. It
				// sits above the indicator (z-10) so the label reads on top of the pill.
				"group-data-[variant=segmented]/tabs-list:z-10 group-data-[variant=segmented]/tabs-list:bg-transparent! group-data-[variant=segmented]/tabs-list:text-foreground/60 group-data-[variant=segmented]/tabs-list:data-active:border-transparent! group-data-[variant=segmented]/tabs-list:data-active:bg-transparent! group-data-[variant=segmented]/tabs-list:data-active:text-foreground group-data-[variant=segmented]/tabs-list:hover:text-foreground dark:group-data-[variant=segmented]/tabs-list:data-active:bg-transparent!",
				"after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
				// When a sliding TabsIndicator is present in the list, hand the active
				// visual (background / border / underline) over to it and keep the
				// trigger's own only its text colour. The `:has()` here outranks the
				// per-variant active-bg rules above, so it wins even against their `!`.
				"group-has-[[data-slot=tabs-indicator]]/tabs-list:data-active:border-transparent! group-has-[[data-slot=tabs-indicator]]/tabs-list:data-active:bg-transparent! group-has-[[data-slot=tabs-indicator]]/tabs-list:data-active:hover:bg-transparent! group-has-[[data-slot=tabs-indicator]]/tabs-list:data-active:after:opacity-0",
				className
			)}
			data-slot="tabs-trigger"
			{...props}
		/>
	);
}

/**
 * Sliding active-tab indicator (transitions.dev "tabs sliding", 16). Base UI
 * positions it over the active tab via the --active-tab-* CSS vars; the
 * `t-tabs-indicator` class (globals.css) tweens left/top/width/height. Render
 * it as a child of ANY TabsList (`default` · `line` · `pills` · `segmented`) to
 * animate that variant's active marker; the trigger cedes its own active
 * background/underline to this element (see TabsTrigger). Its look adapts per
 * variant: a raised pill for default/segmented, a solid pill for pills, and a
 * bottom bar for line.
 */
function TabsIndicator({ className, ...props }: TabsPrimitive.Indicator.Props) {
	return (
		<TabsPrimitive.Indicator
			className={cn(
				// default + segmented: the raised pill.
				"t-tabs-indicator z-0 rounded-full bg-background shadow-sm dark:bg-input/30",
				// pills: a solid black (light) / white (dark) pill, no shadow.
				"group-data-[variant=pills]/tabs-list:bg-black group-data-[variant=pills]/tabs-list:shadow-none dark:group-data-[variant=pills]/tabs-list:bg-white",
				// line: a bottom bar instead of a filled pill.
				"group-data-vertical/tabs:group-data-[variant=line]/tabs-list:border-r-2 group-data-horizontal/tabs:group-data-[variant=line]/tabs-list:border-b-2 group-data-[variant=line]/tabs-list:rounded-none group-data-[variant=line]/tabs-list:border-foreground group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:shadow-none",
				className
			)}
			data-slot="tabs-indicator"
			{...props}
		/>
	);
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
	return (
		<TabsPrimitive.Panel
			className={cn("flex-1 text-sm outline-none", className)}
			data-slot="tabs-content"
			{...props}
		/>
	);
}

export {
	Tabs,
	TabsContent,
	TabsIndicator,
	TabsList,
	TabsTrigger,
	tabsListVariants,
};

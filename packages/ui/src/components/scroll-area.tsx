"use client";

import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import { cn } from "@ryu/ui/lib/utils.ts";

function ScrollArea({
	className,
	appearance = "default",
	children,
	...props
}: ScrollAreaPrimitive.Root.Props & {
	appearance?: "default" | "licenses" | "inspector" | "specimen";
}) {
	return (
		<ScrollAreaPrimitive.Root
			className={cn(
				"relative",
				appearance === "licenses" && "bg-muted/10",
				appearance === "inspector" && "rounded-md border p-2",
				appearance === "specimen" && "rounded-xl border border-border p-3",
				className
			)}
			data-slot="scroll-area"
			{...props}
		>
			<ScrollAreaPrimitive.Viewport
				className="scroll-fade size-full rounded-[inherit] outline-none transition-[color,box-shadow] focus-visible:outline-1 focus-visible:ring-3 focus-visible:ring-ring"
				data-slot="scroll-area-viewport"
			>
				{children}
			</ScrollAreaPrimitive.Viewport>
			<ScrollBar />
			<ScrollAreaPrimitive.Corner />
		</ScrollAreaPrimitive.Root>
	);
}

function ScrollBar({
	className,
	orientation = "vertical",
	...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
	return (
		<ScrollAreaPrimitive.Scrollbar
			className={cn(
				"flex touch-none select-none p-px transition-colors data-horizontal:h-2.5 data-vertical:h-full data-vertical:w-2.5 data-horizontal:flex-col data-horizontal:border-t data-horizontal:border-t-transparent data-vertical:border-l data-vertical:border-l-transparent",
				className
			)}
			data-orientation={orientation}
			data-slot="scroll-area-scrollbar"
			orientation={orientation}
			{...props}
		>
			<ScrollAreaPrimitive.Thumb
				className="relative flex-1 rounded-full bg-border"
				data-slot="scroll-area-thumb"
			/>
		</ScrollAreaPrimitive.Scrollbar>
	);
}

export { ScrollArea, ScrollBar };

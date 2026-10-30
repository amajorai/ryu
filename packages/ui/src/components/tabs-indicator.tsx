"use client";
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { useComposedRefs } from "@ryu/ui/lib/compose-refs.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useRef } from "react";
import { useSafeLayoutEffect, useTabsContext } from "./tabs-root.tsx";

/**
 * Sliding active-tab indicator (transitions.dev "tabs sliding", 16). Base UI
 * positions it over the active tab via the --active-tab-* CSS vars; the
 * `t-tabs-indicator` class (globals.css) tweens transform/width/height.
 * TabsList includes one automatically except for text and stepper variants.
 * Supply an explicit child to customize its look. Layout changes snap into
 * position; selecting a tab slides its marker without moving the labels.
 */
function TabsIndicator({
	className,
	ref,
	...props
}: TabsPrimitive.Indicator.Props) {
	const indicatorRef = useRef<HTMLSpanElement>(null);
	const composedRef = useComposedRefs(indicatorRef, ref);
	const { activeValue } = useTabsContext();
	const hasSelection = activeValue != null;

	useSafeLayoutEffect(() => {
		const indicator = indicatorRef.current;
		const list = indicator?.parentElement;
		if (!(indicator && list)) {
			return;
		}
		let frame = 0;
		const snapToLayout = () => {
			indicator.setAttribute("data-resizing", "");
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				frame = requestAnimationFrame(() => {
					// Commit Base UI's measured position before restoring transitions.
					indicator.getBoundingClientRect();
					indicator.removeAttribute("data-resizing");
				});
			});
		};
		const observer = new ResizeObserver(snapToLayout);
		const observeTabs = () => {
			observer.disconnect();
			observer.observe(list);
			for (const trigger of list.querySelectorAll('[role="tab"]')) {
				observer.observe(trigger);
			}
		};
		observeTabs();
		const mutations = new MutationObserver(observeTabs);
		mutations.observe(list, { childList: true, subtree: true });
		return () => {
			mutations.disconnect();
			observer.disconnect();
			cancelAnimationFrame(frame);
		};
	}, [hasSelection]);

	return (
		<TabsPrimitive.Indicator
			aria-hidden
			className={cn(
				// default + segmented: the raised pill.
				"t-tabs-indicator z-0 rounded-full bg-background shadow-sm dark:bg-input/30",
				// pills: a solid black (light) / white (dark) pill, no shadow.
				"group-data-[variant^=pills]/tabs-list:bg-black group-data-[variant^=pills]/tabs-list:shadow-none dark:group-data-[variant^=pills]/tabs-list:bg-white",
				"group-data-[variant=muted-pills]/tabs-list:bg-muted group-data-[variant=muted-pills]/tabs-list:shadow-none dark:group-data-[variant=muted-pills]/tabs-list:bg-muted",
				// line: a bottom bar instead of a filled pill.
				"group-data-vertical/tabs:group-data-[variant=line]/tabs-list:border-r-2 group-data-horizontal/tabs:group-data-[variant=line]/tabs-list:border-b-2 group-data-[variant=line]/tabs-list:rounded-none group-data-[variant=line]/tabs-list:border-foreground group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:shadow-none",
				className
			)}
			data-slot="tabs-indicator"
			ref={composedRef}
			{...props}
		/>
	);
}

export { TabsIndicator };

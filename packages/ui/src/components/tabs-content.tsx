"use client";
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "@ryu/ui/lib/utils.ts";

type TabsContentProps = TabsPrimitive.Panel.Props & {
	inset?: "review" | "listing-detail" | "agent-activity";
	layout?:
		| "agent-activity"
		| "agent-settings"
		| "install-instructions"
		| "sticky-showcase";
	spacing?: "comfortable" | "relaxed" | "generous";
	appearance?: "layout-proof";
};

function TabsContent({
	className,
	inset,
	layout,
	spacing,
	appearance,
	...props
}: TabsContentProps) {
	return (
		<TabsPrimitive.Panel
			className={cn(
				"flex-1 text-sm outline-none",
				inset === "review" && "t-tabs-panel-review",
				inset === "listing-detail" && "pt-2",
				layout === "agent-activity" && "flex flex-col gap-5",
				layout === "agent-settings" && "flex flex-col gap-6 pt-1",
				layout === "install-instructions" && "flex flex-col gap-3",
				layout === "sticky-showcase" && "flex flex-col gap-4 pt-4",
				inset === "agent-activity" && "px-1 pb-3",
				spacing === "comfortable" && "space-y-6",
				spacing === "relaxed" && "space-y-4",
				spacing === "generous" && "space-y-10",
				appearance === "layout-proof" &&
					"rounded-lg border bg-muted/30 p-4 text-sm",
				className
			)}
			data-slot="tabs-content"
			{...props}
		/>
	);
}

export { TabsContent };

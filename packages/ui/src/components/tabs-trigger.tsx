"use client";
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { useLocalizedText } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import { tabsTriggerClassName } from "./tabs-variants.ts";

type TabsTriggerProps = TabsPrimitive.Tab.Props & {
	density?: "review" | "catalog";
	typography?: "pricing-plan" | "pricing-audience";
	labelCase?: "capitalize";
	spacing?: "store-section";
	tone?: "muted";
};

function TabsTrigger({
	children,
	className,
	density,
	typography,
	labelCase,
	spacing,
	tone,
	...props
}: TabsTriggerProps) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<TabsPrimitive.Tab
			className={cn(
				tabsTriggerClassName,
				density === "review" && "t-tabs-trigger-review",
				density === "catalog" && "gap-1.5 px-2.5 py-1 text-xs",
				typography === "pricing-plan" && "text-base! sm:text-xl!",
				typography === "pricing-audience" && "text-base",
				labelCase === "capitalize" && "capitalize",
				spacing === "store-section" && "gap-1.5",
				tone === "muted" && "text-muted-foreground",
				className
			)}
			data-cuelume-toggle=""
			data-slot="tabs-trigger"
			{...props}
		>
			{localizedChildren}
		</TabsPrimitive.Tab>
	);
}

export { TabsTrigger };

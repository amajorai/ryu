"use client";

import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";
import { useLocalizedText } from "@ryu/i18n/react";
import { isNativeFunction } from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils.ts";

const triggerAppearance = {
	specimen: "rounded-xl bg-muted px-3 py-2 font-medium text-sm",
	"voice-transcript":
		"gap-1.5 py-1.5 text-muted-foreground text-xs transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
	"skill-targets": "rounded-2xl px-3 py-2 font-medium text-sm hover:bg-muted",
	"permission-group": "gap-3 rounded-lg px-2 py-1.5 hover:bg-muted/40",
	"provider-group": "gap-3 rounded-lg p-3.5 hover:bg-muted/40",
	"mission-summary":
		"type-caption gap-1 text-muted-foreground hover:text-foreground",
	"gateway-hook":
		"gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
	"settings-detail":
		"gap-3 rounded-lg px-3.5 py-2 text-muted-foreground text-xs hover:bg-muted/40",
	"tools-server":
		"flex min-w-0 flex-1 items-center gap-2 rounded py-1 text-left hover:bg-muted/40",
};

const contentSpacing = {
	compact: "flex flex-col gap-2",
	"permission-list": "gap-2 px-2 pt-1 pb-2",
	"provider-fields": "gap-3 px-3.5 pt-1 pb-3.5",
	"model-list": "gap-2 px-3.5 pt-1 pb-3.5",
	"mission-events": "space-y-1.5",
	"gateway-detail": "pt-2",
	"settings-detail": "pt-1",
};

function triggerClassName(
	appearance: keyof typeof triggerAppearance,
	className: CollapsiblePrimitive.Trigger.Props["className"]
): CollapsiblePrimitive.Trigger.Props["className"] {
	const recipe = triggerAppearance[appearance];
	if (isNativeFunction(className)) {
		return (state: CollapsiblePrimitive.Trigger.State) => {
			const customClass = className(state);
			return customClass ? `${recipe} ${customClass}` : recipe;
		};
	}
	return className ? `${recipe} ${className}` : recipe;
}

function panelClassName(
	spacing: keyof typeof contentSpacing,
	className: CollapsiblePrimitive.Panel.Props["className"]
): CollapsiblePrimitive.Panel.Props["className"] {
	const recipe = contentSpacing[spacing];
	if (isNativeFunction(className)) {
		return (state: CollapsiblePrimitive.Panel.State) => {
			const customClass = className(state);
			return customClass ? `${recipe} ${customClass}` : recipe;
		};
	}
	return className ? `${recipe} ${className}` : recipe;
}

function rootClassName(
	className: CollapsiblePrimitive.Root.Props["className"]
): CollapsiblePrimitive.Root.Props["className"] {
	const recipe = "flex flex-col gap-2";
	if (isNativeFunction(className)) {
		return (state) => cn(recipe, className(state));
	}
	return cn(recipe, className);
}

function Collapsible({
	className,
	spacing = "default",
	...props
}: CollapsiblePrimitive.Root.Props & { spacing?: "default" | "compact" }) {
	return (
		<CollapsiblePrimitive.Root
			className={spacing === "compact" ? rootClassName(className) : className}
			data-slot="collapsible"
			{...props}
		/>
	);
}

function CollapsibleTrigger({
	children,
	className,
	appearance = "default",
	...props
}: CollapsiblePrimitive.Trigger.Props & {
	appearance?: "default" | keyof typeof triggerAppearance;
}) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<CollapsiblePrimitive.Trigger
			data-slot="collapsible-trigger"
			{...props}
			className={
				appearance === "default"
					? className
					: appearance === "tools-server" || appearance === "settings-detail"
						? cn(triggerAppearance[appearance], className)
						: triggerClassName(appearance, className)
			}
		>
			{localizedChildren}
		</CollapsiblePrimitive.Trigger>
	);
}

function CollapsibleContent({
	className,
	spacing = "default",
	...props
}: CollapsiblePrimitive.Panel.Props & {
	spacing?: "default" | keyof typeof contentSpacing;
}) {
	return (
		<CollapsiblePrimitive.Panel
			data-slot="collapsible-content"
			{...props}
			className={
				spacing === "default"
					? className
					: spacing === "settings-detail"
						? cn(contentSpacing[spacing], className)
						: panelClassName(spacing, className)
			}
		/>
	);
}

export { Collapsible, CollapsibleContent, CollapsibleTrigger };

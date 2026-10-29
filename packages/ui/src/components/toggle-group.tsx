"use client";

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { toggleVariants } from "@ryu/ui/components/toggle.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { VariantProps } from "class-variance-authority";
import { type CSSProperties, createContext, useContext } from "react";
import { FadeOverflowTextChildren } from "./fade-overflow-text.tsx";

interface ToggleGroupSpacingStyle extends CSSProperties {
	"--gap": number;
}

const ToggleGroupContext = createContext<
	Pick<VariantProps<typeof toggleVariants>, "size" | "variant"> & {
		spacing?: number;
		orientation?: "horizontal" | "vertical";
	}
>({
	size: "default",
	variant: "default",
	spacing: 2,
	orientation: "horizontal",
});

function ToggleGroup({
	className,
	appearance = "default",
	variant,
	size,
	spacing = 2,
	orientation = "horizontal",
	children,
	...props
}: ToggleGroupPrimitive.Props &
	Pick<VariantProps<typeof toggleVariants>, "size" | "variant"> & {
		spacing?: number;
		orientation?: "horizontal" | "vertical";
		appearance?: "default" | "plain" | "filter" | "segmented";
	}) {
	const spacingStyle: ToggleGroupSpacingStyle = { "--gap": spacing };
	return (
		<ToggleGroupPrimitive
			className={cn(
				"group/toggle-group data-[spacing=0]:data-[variant=outline]:corner-squircle flex w-fit flex-row items-center gap-[--spacing(var(--gap))] data-[spacing=0]:data-[variant=outline]:rounded-3xl data-vertical:flex-col data-vertical:items-stretch",
				appearance === "plain" && "bg-transparent",
				appearance === "filter" && "rounded-2xl bg-transparent",
				appearance === "segmented" && "rounded-lg bg-muted/60 p-0.5",
				className
			)}
			data-orientation={orientation}
			data-size={size}
			data-slot="toggle-group"
			data-spacing={spacing}
			data-variant={variant}
			style={spacingStyle}
			{...props}
		>
			<ToggleGroupContext.Provider
				value={{ variant, size, spacing, orientation }}
			>
				{children}
			</ToggleGroupContext.Provider>
		</ToggleGroupPrimitive>
	);
}

function ToggleGroupItem({
	className,
	density = "default",
	children,
	variant = "default",
	size = "default",
	...props
}: TogglePrimitive.Props &
	Pick<VariantProps<typeof toggleVariants>, "size" | "variant"> & {
		density?:
			| "default"
			| "metric"
			| "scope"
			| "segmented"
			| "dashboard-tab"
			| "resize-preset";
	}) {
	const context = useContext(ToggleGroupContext);

	return (
		<TogglePrimitive
			className={cn(
				"group-data-horizontal/toggle-group:data-[spacing=0]:last:corner-r-squircle group-data-vertical/toggle-group:data-[spacing=0]:last:corner-b-squircle group-data-vertical/toggle-group:data-[spacing=0]:first:corner-t-squircle group-data-horizontal/toggle-group:data-[spacing=0]:first:corner-l-squircle shrink-0 focus:z-10 focus-visible:z-10 data-[state=on]:bg-muted group-data-[spacing=0]/toggle-group:rounded-none group-data-vertical/toggle-group:data-[spacing=0]:data-[variant=outline]:border-t-0 group-data-horizontal/toggle-group:data-[spacing=0]:data-[variant=outline]:border-l-0 group-data-[spacing=0]/toggle-group:px-3 group-data-[spacing=0]/toggle-group:shadow-none group-data-[spacing=0]/toggle-group:has-data-[icon=inline-end]:pr-2.5 group-data-[spacing=0]/toggle-group:has-data-[icon=inline-start]:pl-2.5 group-data-horizontal/toggle-group:data-[spacing=0]:last:rounded-r-3xl group-data-vertical/toggle-group:data-[spacing=0]:last:rounded-b-3xl group-data-vertical/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-t group-data-horizontal/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-l group-data-vertical/toggle-group:data-[spacing=0]:first:rounded-t-3xl group-data-horizontal/toggle-group:data-[spacing=0]:first:rounded-l-3xl",
				toggleVariants({
					variant: context.variant || variant,
					size: context.size || size,
				}),
				density === "dashboard-tab" && "h-7 gap-1 px-2 text-xs",
				density === "resize-preset" &&
					"h-auto min-h-[4.5rem] w-full min-w-0 flex-col gap-1.5 whitespace-normal rounded-lg px-1.5 py-2 text-center data-[state=on]:border-primary/50 data-[state=on]:bg-primary/5",
				density === "metric" && "h-8 px-2.5 text-xs",
				density === "scope" && "h-8 px-3 text-xs",
				density === "segmented" &&
					"h-7 px-3 text-xs aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm",
				className
			)}
			data-size={context.size || size}
			data-slot="toggle-group-item"
			data-spacing={context.spacing}
			data-variant={context.variant || variant}
			{...props}
		>
			<FadeOverflowTextChildren>{children}</FadeOverflowTextChildren>
		</TogglePrimitive>
	);
}

export { ToggleGroup, ToggleGroupItem };

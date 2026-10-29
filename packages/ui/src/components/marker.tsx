import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cn } from "@ryu/ui/lib/utils.ts";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

const markerVariants = cva(
	"group/marker relative flex min-h-4 w-full items-center gap-2 text-left text-muted-foreground text-sm [&_svg:not([class*='size-'])]:size-4 [a]:underline [a]:underline-offset-3 [a]:hover:text-foreground",
	{
		variants: {
			variant: {
				default: "",
				separator:
					"before:mr-1 before:h-px before:min-w-0 before:flex-1 before:bg-border after:ml-1 after:h-px after:min-w-0 after:flex-1 after:bg-border",
				border: "border-border border-b pb-2",
			},
			tone: {
				default: "",
				primary: "text-primary before:bg-primary/30 after:bg-primary/30",
				destructive: "text-status-destructive",
			},
			spacing: {
				default: "",
				turn: "py-1",
				interrupted: "pt-0.5",
				activity: "py-0.5",
			},
			size: { default: "", compact: "text-xs" },
		},
	}
);

function Marker({
	className,
	variant = "default",
	tone,
	spacing,
	size,
	render,
	...props
}: useRender.ComponentProps<"div"> & VariantProps<typeof markerVariants>) {
	return useRender({
		defaultTagName: "div",
		props: mergeProps<"div">(
			{
				className: cn(
					markerVariants({ variant, tone, spacing, size, className })
				),
			},
			props
		),
		render,
		state: {
			slot: "marker",
			variant,
		},
	});
}

function MarkerIcon({ className, ...props }: React.ComponentProps<"span">) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"size-4 shrink-0 [&_svg:not([class*='size-'])]:size-4",
				className
			)}
			data-slot="marker-icon"
			{...props}
		/>
	);
}

function MarkerContent({
	className,
	spacing = "default",
	...props
}: React.ComponentProps<"span"> & { spacing?: "default" | "compact" }) {
	return (
		<span
			className={cn(
				"wrap-break-word min-w-0 group-data-[variant=separator]/marker:flex-none group-data-[variant=separator]/marker:text-center *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
				spacing === "compact" && "gap-1",
				className
			)}
			data-slot="marker-content"
			{...props}
		/>
	);
}

export { Marker, MarkerContent, MarkerIcon, markerVariants };

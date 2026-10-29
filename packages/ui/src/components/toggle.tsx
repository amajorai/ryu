"use client";

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { cn } from "@ryu/ui/lib/utils.ts";
import { cva, type VariantProps } from "class-variance-authority";
import { FadeOverflowTextChildren } from "./fade-overflow-text.tsx";

const toggleVariants = cva(
	"group/toggle inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-3xl font-medium text-sm outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring active:bg-[color-mix(in_oklch,var(--muted),var(--foreground)_8%)] active:duration-75 disabled:pointer-events-none disabled:opacity-50 aria-pressed:bg-muted aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
	{
		variants: {
			purpose: {
				default: "",
				"calendar-filter":
					"rounded-full text-muted-foreground text-xs aria-pressed:text-foreground",
			},
			variant: {
				default: "bg-transparent",
				outline: "border border-input bg-transparent hover:bg-muted",
			},
			size: {
				default:
					"h-9 min-w-9 px-3 has-data-[icon=inline-start]:ps-2.5 has-data-[icon=inline-end]:pe-2.5",
				sm: "h-8 min-w-8 px-3 has-data-[icon=inline-start]:ps-2 has-data-[icon=inline-end]:pe-2",
				lg: "h-10 min-w-10 px-4 has-data-[icon=inline-start]:ps-3 has-data-[icon=inline-end]:pe-3",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	}
);

function Toggle({
	className,
	variant = "default",
	purpose = "default",
	size = "default",
	children,
	...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
	return (
		<TogglePrimitive
			className={cn(toggleVariants({ variant, size, purpose, className }))}
			data-slot="toggle"
			{...props}
		>
			<FadeOverflowTextChildren>{children}</FadeOverflowTextChildren>
		</TogglePrimitive>
	);
}

export { Toggle, toggleVariants };

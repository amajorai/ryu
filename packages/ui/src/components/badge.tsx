"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { useLocalizedText } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import { cva, type VariantProps } from "class-variance-authority";

const badgeVariants = cva(
	"group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-3xl border border-transparent px-2 py-0.5 font-medium text-xs transition-[color,background-color,border-color,box-shadow] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring has-data-[icon=inline-start]:ps-1.5 has-data-[icon=inline-end]:pe-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
	{
		variants: {
			casing: {
				default: "",
				capitalized: "capitalize",
				uppercase: "uppercase",
			},
			corner: { default: "", preview: "rounded-bl-lg" },
			radius: { default: "", pill: "rounded-full" },
			typography: {
				default: "",
				numeric: "font-mono tabular-nums",
				code: "font-mono text-xs",
				price: "font-heading tabular-nums",
				normal: "font-normal",
				tabular: "tabular-nums",
				caption: "type-caption",
				micro: "type-micro",
				"code-micro": "type-micro font-mono",
			},
			size: {
				default: "",
				compact: "type-compact",
				"download-label": "type-compact h-4 px-1.5 leading-none",
			},
			spacing: { default: "", relaxed: "gap-1.5" },
			trailingAction: { true: "pr-1" },
			motion: { default: "", pulse: "animate-pulse" },
			variant: {
				default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
				secondary:
					"bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
				destructive:
					"bg-destructive/10 text-status-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
				outline:
					"border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
				ghost:
					"hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
				link: "text-primary underline-offset-4 hover:underline",
				inverse: "border-background/20 bg-background/5 text-background",
				surface: "border-border bg-background text-foreground",
			},
			// Muted semantic fills for a passive label (a download row's type
			// stamp) that orients rather than competes with the row's own content.
			tint: {
				default: "",
				amber: "bg-warning/10 text-status-warning",
				blue: "bg-primary/10 text-primary",
				emerald: "bg-success/10 text-status-success",
				neutral: "bg-muted text-muted-foreground",
				rose: "bg-destructive/10 text-status-destructive",
				violet: "bg-accent text-accent-foreground",
			},
			tone: {
				default: "",
				destructive: "border-destructive text-status-destructive",
				informational: "bg-info/15 text-status-info",
				streaming: "bg-chart-2/15 text-foreground",
				success: "bg-success/15 text-status-success",
				warning: "bg-warning/15 text-status-warning",
				expanded: "bg-info/15 text-status-info",
				active: "bg-primary/15 text-primary",
				muted: "bg-muted text-muted-foreground",
				disabled: "bg-muted text-muted-foreground/60",
			},
			appearance: {
				"challenge-status-live":
					"type-compact border border-primary/30 bg-primary/10 font-mono text-primary uppercase tracking-[0.1em]",
				"challenge-status-inactive":
					"type-compact border border-border bg-transparent font-mono text-muted-foreground uppercase tracking-[0.1em]",
				"challenge-muted": "border-border bg-transparent text-muted-foreground",
				"challenge-warning":
					"border-warning/30 bg-warning/10 text-status-warning",
				"challenge-active": "border-primary/30 bg-primary/10 text-primary",
				"agent-count": "type-compact px-1 py-0",
				"catalog-label": "type-compact px-1.5 py-0",
				"ryu-reviewed-card":
					"type-compact inline-flex shrink-0 items-center gap-1 border-status-success/25 bg-status-success/10 px-1.5 py-0 text-status-success",
				"ryu-reviewed-hero":
					"type-compact inline-flex shrink-0 items-center gap-1 border-white/30 bg-white/10 px-1.5 py-0 text-white",
				default: "",
				"exchange-hero":
					"border-background/15 bg-background/10 text-background",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	}
);

function Badge({
	className,
	appearance = "default",
	casing = "default",
	corner = "default",
	radius = "default",
	typography = "default",
	variant = "default",
	size = "default",
	spacing = "default",
	trailingAction,
	motion = "default",
	tint = "default",
	tone = "default",
	render,
	children,
	...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
	const localizedChildren = useLocalizedText(children);
	return useRender({
		defaultTagName: "span",
		props: mergeProps<"span">(
			{
				className: cn(
					badgeVariants({
						appearance,
						casing,
						corner,
						variant,
						size,
						spacing,
						trailingAction,
						motion,
						tint,
						tone,
						radius,
						typography,
					}),
					className
				),
			},
			{ ...props, children: localizedChildren }
		),
		render,
		state: {
			slot: "badge",
			variant,
		},
	});
}

export { Badge, badgeVariants };

"use client";

import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLocalizedString, useLocalizedText } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

const alertVariants = cva(
	"group/alert relative grid w-full gap-0.5 rounded-2xl border px-4 py-3 text-start text-sm has-data-[slot=alert-action]:relative has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2.5 has-data-[slot=alert-action]:pe-18 *:[svg:not([class*='size-'])]:size-4 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current",
	{
		variants: {
			borderTone: { default: "", subtle: "border-border/60" },
			variant: {
				default: "bg-card text-card-foreground",
				destructive:
					"bg-card text-status-destructive *:data-[slot=alert-description]:text-status-destructive/90 *:[svg]:text-current",
				// The three remaining feedback tones. `--success`/`--warning`/`--info`
				// have been in the token set (light and dark) since the palette was
				// written; only `destructive` had ever been wired to a variant, so
				// every non-error banner in the apps was hand-rolling its own colour.
				success:
					"bg-card text-status-success *:data-[slot=alert-description]:text-status-success/90 *:[svg]:text-current",
				warning:
					"bg-card text-status-warning *:data-[slot=alert-description]:text-status-warning/90 *:[svg]:text-current",
				info: "bg-card text-status-info *:data-[slot=alert-description]:text-status-info/90 *:[svg]:text-current",
			},
			appearance: {
				"community-trust": "border-warning/30 bg-warning/5 text-foreground",
			},
			inset: { "community-inline": "px-3 py-2.5" },
		},
		defaultVariants: {
			variant: "default",
		},
	}
);

function Alert({
	className,
	borderTone,
	variant,
	appearance,
	inset,
	...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
	return (
		<div
			className={cn(
				alertVariants({ variant, borderTone, appearance, inset }),
				className
			)}
			data-slot="alert"
			role="alert"
			{...props}
		/>
	);
}

function AlertTitle({
	className,
	children,
	...props
}: React.ComponentProps<"div">) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<div
			className={cn(
				"font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground",
				className
			)}
			data-slot="alert-title"
			{...props}
		>
			{localizedChildren}
		</div>
	);
}

function AlertDescription({
	className,
	layout = "default",
	children,
	...props
}: React.ComponentProps<"div"> & { layout?: "default" | "retry-actions" }) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<div
			className={cn(
				"text-balance text-muted-foreground text-sm md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
				layout === "retry-actions" && "flex flex-col items-start gap-3",
				className
			)}
			data-slot="alert-description"
			{...props}
		>
			{localizedChildren}
		</div>
	);
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			className={cn("absolute end-3 top-2.5", className)}
			data-slot="alert-action"
			{...props}
		/>
	);
}

/**
 * Close affordance for a dismissable alert. Renders into the same top-right
 * slot as `AlertAction` (which reserves the `pe-18` gutter), so a banner can
 * carry either a CTA or a dismiss — or both, by nesting them in one action.
 */
function AlertDismiss({
	className,
	label = "Dismiss",
	...props
}: React.ComponentProps<"button"> & { label?: string }) {
	const localizedLabel = useLocalizedString(label);
	return (
		<button
			aria-label={localizedLabel}
			className={cn(
				"absolute end-3 top-2.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring",
				className
			)}
			data-slot="alert-dismiss"
			type="button"
			{...props}
		>
			<HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
		</button>
	);
}

export { Alert, AlertAction, AlertDescription, AlertDismiss, AlertTitle };

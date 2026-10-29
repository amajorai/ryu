"use client";

import { useLocalizedText } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import type * as React from "react";

function Label({
	children,
	className,
	variant = "default",
	size = "default",
	tone = "default",
	inset = "default",
	spacing = "default",
	typography,
	...props
}: React.ComponentProps<"label"> & {
	size?: "default" | "compact" | "caption";
	tone?: "default" | "muted";
	inset?: "default" | "budget";
	spacing?:
		| "default"
		| "tight"
		| "permission-aligned"
		| "split-choice"
		| "field-row";
	typography?: "normal" | "field-choice";
	variant?: "default" | "description" | "choice" | "agent-choice";
}) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<label
			className={cn(
				"flex select-none items-center gap-2 font-medium text-sm leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-50 group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50",
				variant === "description" && "font-normal leading-relaxed",
				variant === "choice" && "font-medium text-sm",
				variant === "agent-choice" && "cursor-pointer font-normal text-sm",
				spacing === "tight" && "gap-1",
				size === "compact" && "text-xs",
				size === "caption" && "type-caption",
				tone === "muted" && "text-muted-foreground",
				inset === "budget" && "px-3.5",
				spacing === "permission-aligned" && "pt-1.5",
				spacing === "split-choice" && "items-start gap-3 font-normal",
				spacing === "field-row" && "gap-3",
				typography === "normal" && "font-normal",
				typography === "field-choice" && "font-normal text-sm",
				className
			)}
			data-slot="label"
			{...props}
		>
			{localizedChildren}
		</label>
	);
}

export { Label };

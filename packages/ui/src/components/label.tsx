"use client";

import { useLocalizedText } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import type * as React from "react";

function Label({
	children,
	className,
	...props
}: React.ComponentProps<"label">) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<label
			className={cn(
				"flex select-none items-center gap-2 font-medium text-sm leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-50 group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50",
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

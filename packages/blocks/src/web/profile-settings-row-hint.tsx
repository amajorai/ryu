"use client";

import { cn } from "@ryu/ui/lib/utils";
import type { ReactNode } from "react";

/** Muted secondary line under a settings row title, kept inside the row's card. */
export function RowHint({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<p className={cn("text-muted-foreground text-xs leading-snug", className)}>
			{children}
		</p>
	);
}

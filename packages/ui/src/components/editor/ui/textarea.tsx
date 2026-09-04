"use client";

import { useLocalizedString } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import type * as React from "react";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
	const localizedAriaLabel = useLocalizedString(props["aria-label"]);
	const localizedPlaceholder = useLocalizedString(props.placeholder);
	const localizedTitle = useLocalizedString(props.title);
	return (
		<textarea
			className={cn(
				"field-sizing-content flex min-h-16 w-full resize-none rounded-2xl border border-transparent bg-input/50 px-3 py-3 text-base outline-none transition-[color,box-shadow,background-color] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
				className
			)}
			data-slot="textarea"
			{...props}
			aria-label={localizedAriaLabel}
			placeholder={localizedPlaceholder}
			title={localizedTitle}
		/>
	);
}

export { Textarea };

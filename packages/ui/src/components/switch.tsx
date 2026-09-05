"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { useLocalizedString } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";

function Switch({
	className,
	onCheckedChange,
	size = "default",
	...props
}: SwitchPrimitive.Root.Props & {
	size?: "sm" | "default";
}) {
	const localizedAriaLabel = useLocalizedString(props["aria-label"]);
	const localizedTitle = useLocalizedString(props.title);
	return (
		<SwitchPrimitive.Root
			className={cn(
				"peer group/switch t-toggle relative inline-flex shrink-0 items-center rounded-full border-2 outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[size=default]:h-5 data-[size=sm]:h-4 data-[size=default]:w-11 data-[size=sm]:w-7 data-disabled:cursor-not-allowed data-checked:border-primary data-unchecked:border-transparent data-checked:bg-primary data-unchecked:bg-input/90 data-disabled:opacity-50 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
				className
			)}
			data-cuelume-toggle=""
			data-size={size}
			data-slot="switch"
			onCheckedChange={onCheckedChange}
			{...props}
			aria-label={localizedAriaLabel}
			title={localizedTitle}
		>
			<SwitchPrimitive.Thumb
				className="t-toggle-thumb pointer-events-none block rounded-full bg-background not-dark:bg-clip-padding shadow-sm ring-0 group-data-[size=default]/switch:h-4 group-data-[size=sm]/switch:h-3 group-data-[size=default]/switch:w-6 group-data-[size=sm]/switch:w-4 dark:data-checked:bg-primary-foreground dark:data-unchecked:bg-foreground"
				data-slot="switch-thumb"
			/>
		</SwitchPrimitive.Root>
	);
}

export { Switch };

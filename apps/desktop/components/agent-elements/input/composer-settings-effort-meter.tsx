import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import styles from "./composer-settings-menu.module.css";
import {
	activeItem,
	type ComposerSettingsSection,
} from "./composer-settings-menu-types.ts";

/** A glanceable effort indicator whose scale follows the live option list. */
export function EffortMeter({
	className,
	section,
}: {
	className?: string;
	section: ComposerSettingsSection;
}) {
	const tl = useLiteralMessages();
	const activeIndex = Math.max(
		0,
		section.items.findIndex((item) => item.id === section.value)
	);
	const active = activeItem(section);
	const barCount = Math.min(5, Math.max(3, section.items.length));
	const filledBars =
		section.items.length > 1
			? Math.max(
					1,
					Math.round((activeIndex / (section.items.length - 1)) * barCount)
				)
			: 0;

	if (!active || section.items.length < 2) {
		return null;
	}

	return (
		<span
			aria-label={tl("Effort: {name}", { name: active.name })}
			className={cn(
				"inline-flex h-4 shrink-0 items-end gap-px text-primary",
				className
			)}
			data-composer-effort-meter="true"
			role="img"
			title={tl("Effort: {name}", { name: active.name })}
		>
			{Array.from({ length: barCount }, (_, index) => (
				<span
					aria-hidden="true"
					className={cn(
						styles.effortBar,
						"w-1 transition-colors",
						index < filledBars ? "bg-current" : "bg-muted-foreground/25"
					)}
					key={index}
				/>
			))}
		</span>
	);
}

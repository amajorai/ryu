import { cn } from "@ryu/ui/lib/utils.ts";

/** The compact role badge shared by agent headers and navigation rows. */
export function AgentTitleBadge({
	className,
	title,
}: {
	className?: string;
	title?: string | null;
}) {
	const value = title?.trim() ?? "";
	if (!value) {
		return null;
	}

	return (
		<span
			className={cn(
				"type-compact inline-flex max-w-28 shrink-0 items-center truncate rounded-full border border-primary/25 bg-primary/10 px-1.5 py-0.5 font-medium text-primary leading-none",
				className
			)}
			data-slot="agent-title-badge"
			title={value}
		>
			{value}
		</span>
	);
}

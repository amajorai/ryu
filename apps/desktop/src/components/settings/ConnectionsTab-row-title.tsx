import type { ReactNode } from "react";

/**
 * A list row's title: leading tile, the name, and an optional muted detail line
 * under it. Use `detail` when the row's secondary text belongs inside the card;
 * rows whose secondary text is an iOS footer pass it as `description` instead.
 */
export function RowTitle({
	detail,
	leading,
	name,
}: {
	detail?: ReactNode;
	leading: ReactNode;
	name: ReactNode;
}) {
	return (
		<span className="flex min-w-0 items-center gap-2.5">
			{leading}
			<span className="min-w-0 flex-1">
				<span
					className="block truncate"
					title={typeof name === "string" ? name : undefined}
				>
					{name}
				</span>
				{detail ? (
					<span
						className="mt-0.5 block truncate text-muted-foreground text-xs"
						title={typeof detail === "string" ? detail : undefined}
					>
						{detail}
					</span>
				) : null}
			</span>
		</span>
	);
}

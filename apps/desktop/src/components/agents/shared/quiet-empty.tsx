import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";

interface QuietEmptyProps {
	/** At most one `size="sm" variant="outline"` button. */
	action?: ReactNode;
	className?: string;
	/** One line that names the next step. */
	description?: ReactNode;
	icon?: IconSvgElement;
	title: ReactNode;
}

/**
 * The §9.4 empty state for agent, bot, tool and calendar surfaces: the `Empty`
 * primitive with an optional muted `size-5` icon, a `text-sm` title, one line of
 * `text-detail` description and at most one action. No tile, no dashed box.
 */
export function QuietEmpty({
	action,
	className,
	description,
	icon,
	title,
}: QuietEmptyProps) {
	return (
		<Empty className={cn("gap-3 rounded-none p-0 py-12", className)}>
			<EmptyHeader className="gap-1">
				{icon ? (
					<EmptyMedia className="mb-1 text-muted-foreground">
						<HugeiconsIcon className="size-5" icon={icon} />
					</EmptyMedia>
				) : null}
				<EmptyTitle className="font-medium font-sans text-sm tracking-normal">
					{title}
				</EmptyTitle>
				{description ? (
					<EmptyDescription className="text-(length:--text-detail) text-pretty leading-(--text-detail--line-height)">
						{description}
					</EmptyDescription>
				) : null}
			</EmptyHeader>
			{action}
		</Empty>
	);
}

import { useLiteralMessages } from "@ryu/i18n/react";
import { THREAD_STATUS_LABELS } from "@ryuhq/protocol/interfaces";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import type { RecordsFilter } from "./records-model.ts";

function Chip({
	children,
	clearLabel,
	onClear,
}: {
	children: ReactNode;
	clearLabel: string;
	onClear: () => void;
}) {
	return (
		<span className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border bg-background ps-2 pe-0.5 text-foreground text-xs">
			{children}
			<button
				aria-label={clearLabel}
				className="flex size-6 items-center justify-center rounded-[5px] text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
				onClick={onClear}
				type="button"
			>
				<X aria-hidden="true" className="size-3.5" />
			</button>
		</span>
	);
}

/** Active filters as removable chips, Attio-style, after the menu buttons. */
export function FilterChips({
	filter,
	onFilterChange,
}: {
	filter: RecordsFilter;
	onFilterChange: (filter: RecordsFilter) => void;
}) {
	const tl = useLiteralMessages();
	return (
		<>
			{filter.statuses.length > 0 ? (
				<Chip
					clearLabel="Remove status filter"
					onClear={() => onFilterChange({ ...filter, statuses: [] })}
				>
					<span className="text-muted-foreground">Status</span>
					<span className="max-w-48 truncate font-medium">
						{filter.statuses
							.map((status) => THREAD_STATUS_LABELS[status])
							.join(", ")}
					</span>
				</Chip>
			) : null}
			{filter.needsYou ? (
				<Chip
					clearLabel="Remove needs you filter"
					onClear={() => onFilterChange({ ...filter, needsYou: false })}
				>
					<span className="font-medium">Needs you</span>
				</Chip>
			) : null}
			{filter.recentHours === null ? null : (
				<Chip
					clearLabel="Remove last interaction filter"
					onClear={() => onFilterChange({ ...filter, recentHours: null })}
				>
					<span className="text-muted-foreground">Last interaction</span>
					<span className="font-medium">
						{tl("within {recentHours} hours", {
							recentHours: filter.recentHours,
						})}
					</span>
				</Chip>
			)}
		</>
	);
}

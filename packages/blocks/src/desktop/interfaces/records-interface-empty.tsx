import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { RECORDS_OBJECT_LABELS, type RecordsObject } from "./records-model.ts";
import { RECORDS_OBJECT_ICONS } from "./records-nav.tsx";

/** The state shown when an object has no records at all. */
export function RecordsEmptyState({
	object,
	resetTo,
}: {
	object: RecordsObject;
	resetTo: (nextObject: RecordsObject) => void;
}) {
	const tl = useLiteralMessages();
	const labels = RECORDS_OBJECT_LABELS[object];
	const Icon = RECORDS_OBJECT_ICONS[object];
	return (
		<Empty className="h-full" data-testid="records-empty">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<Icon aria-hidden="true" />
				</EmptyMedia>
				<EmptyTitle className="text-sm">
					{tl("No {plural} yet", { plural: labels.plural.toLowerCase() })}
				</EmptyTitle>
				<EmptyDescription className="text-[13px]">
					{object === "agents"
						? "Agents you create in Ryu appear here as records, with their threads and status."
						: tl(
								"{plural} you create in Ryu appear here, with their members and threads.",
								{ plural: labels.plural }
							)}
				</EmptyDescription>
			</EmptyHeader>
			{object === "agents" ? null : (
				<EmptyContent>
					<Button
						onClick={() => resetTo("agents")}
						size="sm"
						type="button"
						variant="outline"
					>
						Show agents
					</Button>
				</EmptyContent>
			)}
		</Empty>
	);
}

/** The state shown when filters or search leave no records. */
export function RecordsNoMatchState({
	clearFilters,
	hasFilters,
	object,
	query,
}: {
	clearFilters: () => void;
	hasFilters: boolean;
	object: RecordsObject;
	query: string;
}) {
	const tl = useLiteralMessages();
	const labels = RECORDS_OBJECT_LABELS[object];
	return (
		<Empty className="h-full" data-testid="records-no-match">
			<EmptyHeader>
				<EmptyTitle className="text-sm">
					{tl("No {plural} match", { plural: labels.plural.toLowerCase() })}
				</EmptyTitle>
				<EmptyDescription className="text-[13px]">
					{query
						? tl("Nothing matches “{query}” with the current filters.", {
								query: query.trim(),
							})
						: "No records meet every filter in this view."}
				</EmptyDescription>
			</EmptyHeader>
			<EmptyContent>
				<Button
					onClick={clearFilters}
					size="sm"
					type="button"
					variant="outline"
				>
					{hasFilters || query ? "Clear filters" : "Show all"}
				</Button>
			</EmptyContent>
		</Empty>
	);
}

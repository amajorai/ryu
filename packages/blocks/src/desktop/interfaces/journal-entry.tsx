import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import type { ReactNode } from "react";
import {
	entryTitle,
	fullDateLabel,
	type JournalEntry,
	timeLabel,
} from "./journal-model.ts";
import {
	entryPlaceItems,
	type JournalMetaItem,
	JournalMetaLine,
	JournalStatusText,
} from "./journal-parts.tsx";

/**
 * The entry page column. Header and body share it so one edge runs from the
 * date line down through the conversation; the header's inset matches the
 * host chat surface's own padding.
 */
export const ENTRY_COLUMN =
	"mx-auto flex w-full max-w-[52rem] min-h-0 flex-1 flex-col";
/** Matches the host chat surface's inset, so the divider spans the text column only. */
const ENTRY_INSET = "mx-4";

/**
 * One entry, read as Day One shows it: a metadata line where Day One puts
 * place and weather (here the agents and the project), the title, and the
 * host's conversation as the body.
 */
export function JournalEntryPage({
	draftAgents,
	draftPlace,
	entry,
	threadView,
	titleClass,
}: {
	/** Agents of a just-started entry the snapshot does not list yet. */
	draftAgents: InterfaceAgent[];
	draftPlace: string | null;
	entry: JournalEntry | null;
	threadView: ReactNode;
	titleClass: string;
}) {
	const agents = entry?.agents ?? draftAgents;
	const place = entry ? entry.place : draftPlace;
	const dateLine = entry
		? `${fullDateLabel(entry.day)} at ${timeLabel(entry.at)}`
		: "New entry";
	const items: JournalMetaItem[] = entryPlaceItems(agents, place);
	if (entry) {
		items.push({
			key: "status",
			node: <JournalStatusText live status={entry.status} />,
		});
	}
	return (
		<article
			aria-label={entry ? entryTitle(entry.thread) : "New entry"}
			className={ENTRY_COLUMN}
		>
			<header className={cn(ENTRY_INSET, "border-border border-b pt-8 pb-5")}>
				<p className="text-muted-foreground text-sm leading-5">
					{entry ? (
						<time dateTime={entry.thread.updatedAt}>{dateLine}</time>
					) : (
						dateLine
					)}
				</p>
				<h1
					className={cn(
						"mt-1 text-balance font-semibold text-3xl text-foreground leading-9",
						titleClass
					)}
				>
					{entry ? entryTitle(entry.thread) : "Untitled entry"}
				</h1>
				{items.length > 0 ? (
					<JournalMetaLine
						agents={agents}
						className="mt-3 text-sm leading-5"
						items={items}
					/>
				) : null}
			</header>
			<div
				className="flex min-h-0 flex-1 flex-col"
				data-slot="journal-entry-body"
			>
				{threadView}
			</div>
		</article>
	);
}

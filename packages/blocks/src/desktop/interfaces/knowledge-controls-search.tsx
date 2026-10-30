import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { KeyboardEvent, RefObject } from "react";
import {
	displayLabel,
	KIND_LABELS,
	type KnowledgeNode,
} from "./knowledge-model.ts";

/** Matches shown under the search field; the rest are counted. */
const MAX_RESULTS = 6;

/** A result's name with the matched part set in the foreground. */
function Highlighted({ query, text }: { query: string; text: string }) {
	const needle = query.trim().toLowerCase();
	const at = needle ? text.toLowerCase().indexOf(needle) : -1;
	if (at < 0) {
		return <>{text}</>;
	}
	return (
		<>
			{text.slice(0, at)}
			<mark className="bg-transparent font-medium text-foreground">
				{text.slice(at, at + needle.length)}
			</mark>
			{text.slice(at + needle.length)}
		</>
	);
}

const RESULTS_SURFACE =
	"mt-1 rounded-md border border-border bg-background/70 p-1";

/**
 * Search hits, inline under the field (the settings below move down rather
 * than being covered), reachable by name: Arrow Down from the field moves
 * into the list.
 */
export function SearchResults({
	listRef,
	onPick,
	query,
	results,
	searchRef,
}: {
	listRef: RefObject<HTMLUListElement | null>;
	onPick: (id: string) => void;
	query: string;
	results: readonly KnowledgeNode[];
	searchRef: RefObject<HTMLInputElement | null>;
}) {
	const tl = useLiteralMessages();
	if (results.length === 0) {
		return (
			<p
				className={cn(
					RESULTS_SURFACE,
					"flex h-9 items-center px-2 text-muted-foreground text-xs"
				)}
			>
				No matching nodes
			</p>
		);
	}
	const move = (event: KeyboardEvent<HTMLButtonElement>, step: 1 | -1) => {
		event.preventDefault();
		const buttons = [
			...(listRef.current?.querySelectorAll("button") ?? []),
		] as HTMLButtonElement[];
		const index = buttons.indexOf(event.currentTarget);
		const next = buttons[index + step];
		if (next) {
			next.focus();
		} else if (step === -1) {
			searchRef.current?.focus();
		}
	};
	const extra = results.length - MAX_RESULTS;
	return (
		<ul
			aria-label="Matching nodes"
			className={cn(RESULTS_SURFACE, "flex flex-col")}
			ref={listRef}
		>
			{results.slice(0, MAX_RESULTS).map((node) => (
				<li key={node.id}>
					<button
						className="flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
						onClick={() => onPick(node.id)}
						onKeyDown={(event) => {
							if (event.key === "ArrowDown") {
								move(event, 1);
							} else if (event.key === "ArrowUp") {
								move(event, -1);
							}
						}}
						type="button"
					>
						<span className="min-w-0 flex-1 truncate text-foreground/80 text-sm">
							<Highlighted query={query} text={displayLabel(node)} />
						</span>
						<span className="shrink-0 text-muted-foreground text-xs">
							{KIND_LABELS[node.kind]}
						</span>
					</button>
				</li>
			))}
			{extra > 0 ? (
				<li className="flex h-6 items-center px-2 text-muted-foreground text-xs tabular-nums">
					{tl("{extra} more", { extra: String(extra) })}
				</li>
			) : null}
		</ul>
	);
}

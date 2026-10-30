import { useLiteralMessages } from "@ryu/i18n/react";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { type FormEvent, useId, useMemo, useState } from "react";
import { excerptAround, wikiSearch, wikiStamp } from "./wiki-model.ts";
import { Marked, PROSE, WikiFooter, WikiLink } from "./wiki-parts.tsx";

// ---------------------------------------------------------------------------
// Search results
// ---------------------------------------------------------------------------

export function SearchPage({
	onSearch,
	query,
	snapshot,
}: {
	onSearch: (query: string) => void;
	query: string;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const hits = useMemo(() => wikiSearch(snapshot, query), [snapshot, query]);
	const [draft, setDraft] = useState(query);
	const fieldId = useId();
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (draft.trim()) {
			onSearch(draft.trim());
		}
	};
	return (
		<div className="pt-4">
			<form className="flex max-w-xl" onSubmit={submit} role="search">
				<label className="sr-only" htmlFor={fieldId}>
					Search query
				</label>
				<input
					className="h-9 min-w-0 flex-1 rounded-l-[2px] border border-input bg-background px-3 text-sm outline-none hover:border-ring/60 focus:border-ring focus:ring-1 focus:ring-ring [&::-webkit-search-cancel-button]:appearance-none"
					id={fieldId}
					onChange={(event) => setDraft(event.target.value)}
					type="search"
					value={draft}
				/>
				<button
					className="-ml-px h-9 cursor-pointer rounded-r-[2px] bg-primary px-4 font-medium text-primary-foreground text-sm outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 active:bg-primary/80"
					type="submit"
				>
					Search
				</button>
			</form>
			<p className="mt-4 border-border border-b pb-2 text-[13px] text-muted-foreground leading-5">
				{hits.length > 0
					? tl(
							"{count, plural, =1 {Showing the only result for “{query}”.} other {Showing {countText} results for “{query}”.}}",
							{
								count: hits.length,
								countText: String(hits.length),
								query,
							}
						)
					: tl("There were no results matching the query “{query}”.", {
							query,
						})}
			</p>
			{hits.length > 0 ? (
				<ul className="mt-2">
					{hits.map((hit) => {
						const snippet = excerptAround(hit.snippet, query);
						return (
							<li className="py-2" key={`${hit.entry.kind}-${hit.entry.id}`}>
								<WikiLink
									className="text-base leading-6"
									route={hit.entry.route}
								>
									<Marked query={query} value={hit.entry.title} />
								</WikiLink>
								{snippet && snippet !== hit.entry.description ? (
									<p className="text-sm leading-6">
										<Marked query={query} value={snippet} />
									</p>
								) : null}
								<p className="text-[13px] text-muted-foreground leading-5">
									{hit.entry.description}
									{hit.entry.updatedAt
										? ` · ${wikiStamp(hit.entry.updatedAt)}`
										: ""}
								</p>
							</li>
						);
					})}
				</ul>
			) : (
				<p className={`${PROSE} mt-3`}>
					Try fewer words, or browse the{" "}
					<WikiLink route={{ index: "threads", kind: "index" }}>
						List of threads
					</WikiLink>
					.
				</p>
			)}
			<WikiFooter edited={null} />
		</div>
	);
}

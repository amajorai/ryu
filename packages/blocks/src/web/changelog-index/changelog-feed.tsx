"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { ArrowUpRight } from "lucide-react";
import { useMemo, useState } from "react";
import { SearchInput } from "../blog.tsx";
import { SearchResultStatus } from "../blog-index/search-result-status.tsx";
import { ChangelogFeedItem } from "./changelog-feed-entry.tsx";
import {
	type ChangelogFeedEntry,
	newestReleasesFirst,
	releaseMatchesQuery,
} from "./changelog-feed-model.ts";

/** Below this many releases a search box has nothing to narrow down. */
export const MIN_SEARCHABLE_RELEASES = 6;

/**
 * The changelog index: a dated timeline feed, newest release first, closed by
 * a link to the docs release notes for every older version.
 */
export function ChangelogFeed({
	entries,
	olderReleasesHref,
}: {
	entries: readonly ChangelogFeedEntry[];
	/** The docs page that keeps every version's full notes. */
	olderReleasesHref: string;
}) {
	const tl = useLiteralMessages();
	const [query, setQuery] = useState("");
	const ordered = useMemo(() => newestReleasesFirst(entries), [entries]);
	const matches = useMemo(
		() => ordered.filter((entry) => releaseMatchesQuery(entry, query)),
		[ordered, query]
	);

	return (
		<div className="flex flex-col">
			{entries.length >= MIN_SEARCHABLE_RELEASES ? (
				<div className="mb-12 md:ms-[calc(12rem+2.5rem)]">
					<SearchInput
						className="w-full max-w-xs"
						onSearch={setQuery}
						placeholder="Search releases"
					/>
				</div>
			) : null}

			<SearchResultStatus
				count={matches.length}
				kind="releases"
				query={query}
			/>

			{entries.length === 0 ? (
				<p className="py-12 text-muted-foreground">No releases yet.</p>
			) : null}

			{entries.length > 0 && matches.length === 0 ? (
				<p className="py-12 text-muted-foreground">
					{tl('No changelog entries found matching "{searchQuery}".', {
						searchQuery: query,
					})}
				</p>
			) : null}

			{matches.length > 0 ? (
				<ol aria-label="Releases, newest first" className="flex flex-col">
					{matches.map((entry) => (
						<li key={entry.id}>
							<ChangelogFeedItem entry={entry} />
						</li>
					))}
				</ol>
			) : null}

			{/* The timeline line runs on into the closing link. */}
			<div className="grid gap-4 md:grid-cols-[12rem_1fr] md:gap-10">
				<span aria-hidden="true" className="hidden md:block" />
				<div
					className="md:border-border md:border-s md:ps-10"
					data-slot="release-timeline-end"
				>
					<a
						className="group flex items-center justify-between gap-6 rounded-lg border border-border p-5 transition-colors hover:bg-muted md:max-w-2xl"
						data-slot="older-releases"
						href={olderReleasesHref}
						rel="noopener noreferrer"
						target="_blank"
					>
						<span className="flex flex-col gap-1">
							<span className="font-heading font-medium text-foreground text-lg">
								Older releases
							</span>
							<span className="text-muted-foreground text-sm">
								Every version&apos;s full notes are in the release notes.
							</span>
						</span>
						<ArrowUpRight
							aria-hidden="true"
							className="size-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
						/>
					</a>
				</div>
			</div>
		</div>
	);
}

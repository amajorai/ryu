"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { cn } from "@ryu/ui/lib/utils";
import type { Route } from "next";
import Link from "next/link";
import { type ReactNode, useMemo, useState } from "react";
import { SearchInput } from "./blog.tsx";
import { RELEASES_PAGE } from "./download-assets.ts";
import { formatPublicationDate } from "./publication-date.ts";

/**
 * Block-local changelog-entry shape, the subset the presentational layer needs.
 * The live app's MDX `ChangelogEntry` is a structural superset; `banner` is a
 * same-site `/content/...` path or an https URL. `body` is the entry's
 * already-rendered release notes; when present the timeline shows them in full.
 */
export interface ChangelogEntryData {
	banner?: string;
	body?: ReactNode;
	content: string;
	date: string;
	id: string;
	slug: string;
	title: string;
	type: string;
	version: string;
}

/** Compact changelog card for grids and home-page previews. */
export function ChangelogCard({ entry }: { entry: ChangelogEntryData }) {
	const formattedDate = formatPublicationDate(entry.date, "short");
	const bannerSrc = safeMediaUrl(entry.banner);

	return (
		<div className="group">
			<div className="flex flex-col gap-1 pb-3">
				<Link className="block" href={`/changelog/${entry.slug}`}>
					{bannerSrc ? (
						<div className="mb-4 aspect-video w-full overflow-hidden rounded-md">
							{}
							<img
								alt={entry.title}
								className="h-full w-full object-cover transition-transform duration-200 motion-safe:group-hover:scale-105"
								src={bannerSrc}
							/>
						</div>
					) : null}
					<div className="flex flex-col gap-2">
						<h2
							className="font-heading font-medium text-xl underline-offset-4 hover:underline"
							data-slot="article-title"
						>
							{entry.title}
						</h2>
					</div>
				</Link>
				<div className="mb-2 flex flex-wrap items-center gap-2 text-muted-foreground text-sm">
					<Badge variant="secondary">Changelog</Badge>
					{entry.version ? (
						<>
							<span>&bull;</span>
							<span className="tabular-nums">v{entry.version}</span>
						</>
					) : null}
					<span>&bull;</span>
					<time dateTime={entry.date}>{formattedDate}</time>
					{entry.type ? (
						<>
							<span>&bull;</span>
							<span className="capitalize">{entry.type}</span>
						</>
					) : null}
				</div>
			</div>
		</div>
	);
}

/**
 * A single changelog timeline entry, presentational. `single` drops the date
 * column and the timeline rail: with one release there is nothing to connect,
 * so the meta sits above the title, on the page's one left edge.
 */
export function ChangelogEntry({
	entry,
	single = false,
}: {
	entry: ChangelogEntryData;
	single?: boolean;
}) {
	const formattedDate = formatPublicationDate(entry.date, "long");
	const bannerSrc = safeMediaUrl(entry.banner);
	// SAFETY: the host app serves /changelog/[slug]; this shared block cannot see
	// that app's generated typedRoutes list.
	const href = `/changelog/${entry.slug}` as Route;

	return (
		<article
			className={cn(
				// Whitespace separates entries; the last one adds no gap before the
				// section's own bottom padding and the footer.
				"relative grid gap-4 pb-16 last:pb-0",
				single ? null : "md:grid-cols-[10rem_1fr] md:gap-10"
			)}
			id={entry.slug}
		>
			{/* Timeline rail: date and version stick beside the release notes. */}
			<div className={single ? undefined : "md:sticky md:top-24 md:self-start"}>
				<div
					className={cn(
						"flex flex-wrap items-center gap-2 text-muted-foreground text-sm",
						single ? null : "md:flex-col md:items-start md:gap-1"
					)}
				>
					<time dateTime={entry.date}>{formattedDate}</time>
					{entry.version ? (
						<>
							{/* Inline meta reads "date · version", as on the entry page. */}
							<span
								aria-hidden="true"
								className={single ? undefined : "md:hidden"}
							>
								·
							</span>
							{/* The version links to its GitHub release, where the full
							    notes live. */}
							<a
								className="tabular-nums underline-offset-4 hover:text-foreground hover:underline"
								href={`${RELEASES_PAGE}/tag/v${entry.version}`}
								rel="noopener noreferrer"
								target="_blank"
							>
								v{entry.version}
							</a>
						</>
					) : null}
					{/* Most entries are releases; a pill only earns its place for other types. */}
					{entry.type && entry.type.toLowerCase() !== "release" ? (
						<Badge className="capitalize" variant="secondary">
							{entry.type}
						</Badge>
					) : null}
				</div>
			</div>

			{/* Entries are separated by whitespace (the article's pb-16) and the
			    sticky date column, not a hairline rail. */}
			<div className="relative min-w-0 space-y-6">
				<h2 className="font-heading font-medium text-2xl tracking-tight md:text-3xl">
					<Link className="underline-offset-4 hover:underline" href={href}>
						{entry.title}
					</Link>
				</h2>

				{bannerSrc ? (
					<Link
						className="group relative block aspect-video w-full overflow-hidden rounded-lg md:max-w-2xl"
						href={href}
					>
						{}
						<img
							alt={entry.title}
							className="h-full w-full object-cover transition-transform duration-200 motion-safe:group-hover:scale-105"
							src={bannerSrc}
						/>
					</Link>
				) : null}

				{entry.body ?? null}
			</div>
		</article>
	);
}

/** Below this many releases a search box has nothing to narrow down. */
const MIN_SEARCHABLE_ENTRIES = 6;

/** The searchable changelog timeline, presentational. */
export function ChangelogTimelineSearch({
	entries,
	className = "",
}: {
	entries: ChangelogEntryData[];
	className?: string;
}) {
	const tl = useLiteralMessages();
	const [searchQuery, setSearchQuery] = useState("");

	const filteredEntries = useMemo(() => {
		if (!searchQuery.trim()) {
			return entries;
		}
		const query = searchQuery.toLowerCase();
		return entries.filter(
			(entry) =>
				entry.title.toLowerCase().includes(query) ||
				entry.content.toLowerCase().includes(query) ||
				entry.version.toLowerCase().includes(query) ||
				entry.type.toLowerCase().includes(query)
		);
	}, [entries, searchQuery]);

	if (entries.length === 0) {
		return (
			<div className={className}>
				<div className="py-12 text-center">
					<h3 className="mb-2 font-medium text-lg">No changelogs yet</h3>
					<p className="text-muted-foreground">Come back later.</p>
				</div>
			</div>
		);
	}

	return (
		<div className={className}>
			{entries.length >= MIN_SEARCHABLE_ENTRIES ? (
				<div className="mb-8">
					<SearchInput
						className="w-full max-w-xs"
						onSearch={setSearchQuery}
						placeholder="Search releases"
					/>
				</div>
			) : null}

			{filteredEntries.length === 0 ? (
				<div className="py-12 text-center">
					<h3 className="mb-2 font-medium text-lg">No results found</h3>
					<p className="text-muted-foreground">
						{tl('No changelog entries found matching "{searchQuery}".', {
							searchQuery,
						})}
					</p>
				</div>
			) : (
				<div className="relative">
					{filteredEntries.map((entry) => (
						<ChangelogEntry
							entry={entry}
							key={entry.id}
							single={entries.length < 2}
						/>
					))}
				</div>
			)}
		</div>
	);
}

"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { SearchInput } from "./blog.tsx";

/**
 * Block-local changelog-entry shape, the subset the presentational layer needs.
 * The live app's Notion `ChangelogEntry` is a structural superset.
 */
export interface ChangelogEntryData {
	banner?: string;
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
	const formattedDate = new Date(entry.date).toLocaleDateString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
	});

	return (
		<div className="group transition-all duration-200">
			<div className="flex flex-col gap-1 pb-3">
				<Link className="block" href={`/changelog/${entry.slug}`}>
					{entry.banner && (
						<div className="mb-4 aspect-video w-full overflow-hidden rounded-md">
							{/* biome-ignore lint/performance/noImgElement: Notion banner served via the app's notion-image proxy route */}
							<img
								alt={entry.title}
								className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
								src={`/api/notion-image?pageId=${entry.id}&prop=banner`}
							/>
						</div>
					)}
					<div className="flex flex-col gap-2">
						<h2 className="font-medium text-xl transition-colors hover:text-primary">
							{entry.title}
						</h2>
					</div>
				</Link>
				<div className="mb-2 flex flex-wrap items-center gap-2 text-muted-foreground text-sm">
					<span className="rounded-full bg-muted px-2 py-0.5 text-xs capitalize">
						Changelog
					</span>
					{entry.version ? (
						<>
							<span>&bull;</span>
							<span className="font-mono">v{entry.version}</span>
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

/** A single changelog timeline entry, presentational. */
export function ChangelogEntry({ entry }: { entry: ChangelogEntryData }) {
	const formattedDate = new Date(entry.date).toLocaleDateString("en-US", {
		year: "numeric",
		month: "long",
		day: "numeric",
	});

	return (
		<Link href={`/changelog/${entry.slug}`}>
			<div className="group">
				<div className="relative pb-12 pl-12">
					{/* Timeline line */}
					<div className="absolute top-0 bottom-0 left-4 w-0.5 bg-border" />

					{/* Version, date, type — left of circle on desktop */}
					<div className="absolute top-2 -left-2 hidden -translate-x-full pr-4 text-right xl:block">
						{entry.version && (
							<div className="font-mono text-muted-foreground">
								v{entry.version}
							</div>
						)}
						<div className="text-muted-foreground">{formattedDate}</div>
						<div className="text-muted-foreground">{entry.type}</div>
					</div>

					{/* Timeline circle */}
					<div className="absolute -left-1 size-10 rounded-full border-8 border-background bg-muted" />

					{/* Content */}
					<div className="space-y-3">
						<h3 className="font-medium text-3xl">{entry.title}</h3>

						{/* Mobile meta */}
						<div className="mt-2 flex items-center gap-4 text-sm xl:hidden">
							{entry.version && (
								<span className="font-mono text-muted-foreground">
									v{entry.version}
								</span>
							)}
							<span className="text-muted-foreground">&bull;</span>
							<time className="text-muted-foreground" dateTime={entry.date}>
								{formattedDate}
							</time>
							<span className="text-muted-foreground">&bull;</span>
							<span className="text-muted-foreground">{entry.type}</span>
						</div>

						{/* Banner */}
						{entry.banner && (
							<div className="relative aspect-video w-full max-w-2xl overflow-hidden rounded-lg">
								{/* biome-ignore lint/performance/noImgElement: Notion banner served via the app's notion-image proxy route */}
								<img
									alt={entry.title}
									className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
									src={`/api/notion-image?pageId=${entry.id}&prop=banner`}
								/>
							</div>
						)}
					</div>
				</div>
			</div>
		</Link>
	);
}

/** The searchable changelog timeline, presentational. */
export function ChangelogTimelineSearch({
	entries,
	className = "",
}: {
	entries: ChangelogEntryData[];
	className?: string;
}) {
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
			<div className="mb-8">
				<SearchInput onSearch={setSearchQuery} placeholder="Search releases" />
			</div>

			{filteredEntries.length === 0 ? (
				<div className="py-12 text-center">
					<h3 className="mb-2 font-medium text-lg">No results found</h3>
					<p className="text-muted-foreground">
						No changelog entries found matching &quot;{searchQuery}&quot;.
					</p>
				</div>
			) : (
				<div className="relative">
					{filteredEntries.map((entry) => (
						<ChangelogEntry entry={entry} key={entry.id} />
					))}
				</div>
			)}
		</div>
	);
}

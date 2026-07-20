"use client";

import { cn } from "@ryu/ui/lib/utils";
import Link from "next/link";
import { useMemo, useState } from "react";
import {
	BLOG_TAGS,
	BlogPostCard,
	type BlogPostData,
	SearchInput,
} from "./blog.tsx";
import { ChangelogCard, type ChangelogEntryData } from "./changelog.tsx";

type ContentFilter = "all" | "blog" | "changelog";

type RecentItem =
	| { kind: "blog"; post: BlogPostData }
	| { kind: "changelog"; entry: ChangelogEntryData };

const CONTENT_FILTERS: { label: string; value: ContentFilter }[] = [
	{ label: "All", value: "all" },
	{ label: "Blog", value: "blog" },
	{ label: "Changelog", value: "changelog" },
];

const DISPLAY_LIMIT = 6;

function mergeRecentItems(
	posts: BlogPostData[],
	entries: ChangelogEntryData[]
): RecentItem[] {
	const items: RecentItem[] = [
		...posts.map((post) => ({ kind: "blog" as const, post })),
		...entries.map((entry) => ({ kind: "changelog" as const, entry })),
	];

	return items.sort(
		(a, b) =>
			new Date(b.kind === "blog" ? b.post.date : b.entry.date).getTime() -
			new Date(a.kind === "blog" ? a.post.date : a.entry.date).getTime()
	);
}

function FilterPill({
	active,
	label,
	onClick,
}: {
	active: boolean;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			className={cn(
				"rounded-full border px-4 py-2 font-medium text-sm transition-colors",
				active
					? "border-transparent bg-black text-white hover:bg-black/80 dark:bg-white dark:text-black dark:hover:bg-white/80"
					: "text-foreground/60 hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
			)}
			onClick={onClick}
			type="button"
		>
			{label}
		</button>
	);
}

/** Recent blog posts and changelog entries with content-type and tag filters. */
export function RecentUpdates({
	posts,
	entries,
	className = "",
}: {
	posts: BlogPostData[];
	entries: ChangelogEntryData[];
	className?: string;
}) {
	const [contentFilter, setContentFilter] = useState<ContentFilter>("all");
	const [activeTag, setActiveTag] = useState<string | undefined>();
	const [searchQuery, setSearchQuery] = useState("");

	const allItems = useMemo(
		() => mergeRecentItems(posts, entries),
		[posts, entries]
	);

	const filteredItems = useMemo(() => {
		let items = allItems;

		if (contentFilter === "blog") {
			items = items.filter((item) => item.kind === "blog");
		} else if (contentFilter === "changelog") {
			items = items.filter((item) => item.kind === "changelog");
		}

		if (activeTag) {
			items = items.filter(
				(item) => item.kind === "changelog" || item.post.tag === activeTag
			);
		}

		if (searchQuery.trim()) {
			const query = searchQuery.toLowerCase();
			items = items.filter((item) => {
				if (item.kind === "blog") {
					const { post } = item;
					return (
						post.title.toLowerCase().includes(query) ||
						post.content.toLowerCase().includes(query) ||
						post.tag?.toLowerCase().includes(query) ||
						post.authors?.some((author) =>
							author.name.toLowerCase().includes(query)
						)
					);
				}

				const { entry } = item;
				return (
					entry.title.toLowerCase().includes(query) ||
					entry.content.toLowerCase().includes(query) ||
					entry.version.toLowerCase().includes(query) ||
					entry.type.toLowerCase().includes(query)
				);
			});
		}

		return items;
	}, [activeTag, allItems, contentFilter, searchQuery]);

	const visibleItems = filteredItems.slice(0, DISPLAY_LIMIT);
	const showBlogTags = contentFilter !== "changelog";

	if (allItems.length === 0) {
		return null;
	}

	return (
		<div className={className}>
			<div className="mb-6 flex flex-wrap gap-2">
				{CONTENT_FILTERS.map((filter) => (
					<FilterPill
						active={contentFilter === filter.value}
						key={filter.value}
						label={filter.label}
						onClick={() => setContentFilter(filter.value)}
					/>
				))}
			</div>

			{showBlogTags ? (
				<div className="mb-6 flex flex-wrap gap-2">
					{BLOG_TAGS.map((tag) => {
						const isActive =
							tag.value === activeTag || !(tag.value || activeTag);

						return (
							<FilterPill
								active={isActive}
								key={tag.label}
								label={tag.label}
								onClick={() => setActiveTag(tag.value)}
							/>
						);
					})}
				</div>
			) : null}

			<div className="mb-8">
				<SearchInput
					onSearch={setSearchQuery}
					placeholder="Search posts and releases"
				/>
			</div>

			{visibleItems.length === 0 ? (
				<div className="py-12 text-center">
					<p className="text-muted-foreground">
						No results found
						{searchQuery ? ` matching "${searchQuery}"` : " for this filter"}.
					</p>
				</div>
			) : (
				<div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
					{visibleItems.map((item) =>
						item.kind === "blog" ? (
							<BlogPostCard key={item.post.id} post={item.post} />
						) : (
							<ChangelogCard entry={item.entry} key={item.entry.id} />
						)
					)}
				</div>
			)}

			<div className="mt-8 flex flex-wrap items-center gap-4 text-sm">
				<Link
					className="text-muted-foreground transition-colors hover:text-foreground"
					href="/blog"
				>
					View all blog posts
				</Link>
				<span className="text-muted-foreground">&bull;</span>
				<Link
					className="text-muted-foreground transition-colors hover:text-foreground"
					href="/changelog"
				>
					View full changelog
				</Link>
			</div>
		</div>
	);
}

"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useCallback, useMemo, useState } from "react";
import { SearchInput } from "../blog.tsx";
import { outlineCtaClass } from "../sections.tsx";
import { BlogIndexCard } from "./blog-index-card.tsx";
import {
	type BlogIndexPost,
	type BlogTagChip,
	newestFirst,
	pickLeadPost,
	postMatchesQuery,
} from "./blog-index-model.ts";
import { BlogLeadPost } from "./blog-lead-post.tsx";
import { BlogTagFilter } from "./blog-tag-filter.tsx";
import { SearchResultStatus } from "./search-result-status.tsx";

/** Four rows of three before "Show more posts". */
export const BLOG_GRID_PAGE_SIZE = 12;

/**
 * The blog index body: the tag filter and search, then the lead story, then
 * every other post as a card grid. While a search is active the lead steps
 * aside and the grid shows every match, so nothing is hidden behind it. The
 * filter row sits above the lead so the search box never moves as the lead
 * hides and returns.
 */
export function BlogIndexView({
	activeTag,
	chips,
	posts,
}: {
	activeTag?: string;
	chips: readonly BlogTagChip[];
	posts: readonly BlogIndexPost[];
}) {
	const tl = useLiteralMessages();
	const [query, setQuery] = useState("");
	const [visibleCount, setVisibleCount] = useState(BLOG_GRID_PAGE_SIZE);

	const handleSearch = useCallback((next: string) => {
		setQuery(next);
		setVisibleCount(BLOG_GRID_PAGE_SIZE);
	}, []);

	const isSearching = query.trim().length > 0;
	const lead = useMemo(
		() => (isSearching ? undefined : pickLeadPost(posts)),
		[isSearching, posts]
	);
	const gridPosts = useMemo(
		() =>
			newestFirst(posts).filter(
				(post) => post.id !== lead?.id && postMatchesQuery(post, query)
			),
		[lead, posts, query]
	);
	const visiblePosts = gridPosts.slice(0, visibleCount);

	return (
		<div className="flex flex-col gap-12 md:gap-16">
			<div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
				<BlogTagFilter activeTag={activeTag} chips={chips} />
				{posts.length > 0 ? (
					<SearchInput
						className="w-full shrink-0 md:w-64"
						onSearch={handleSearch}
						placeholder="Search posts"
					/>
				) : null}
			</div>

			<SearchResultStatus count={gridPosts.length} kind="posts" query={query} />

			{posts.length === 0 ? (
				<p className="py-12 text-muted-foreground">Nothing here yet.</p>
			) : null}

			{lead ? <BlogLeadPost post={lead} /> : null}

			{gridPosts.length > 0 || isSearching ? (
				<section
					aria-labelledby="blog-grid-title"
					className="flex flex-col gap-8"
				>
					<h2
						className={cn(
							"font-heading font-medium text-2xl text-foreground tracking-tight",
							// The lead's own heading already introduces an unsearched list.
							lead ? null : "sr-only"
						)}
						id="blog-grid-title"
					>
						{lead ? "More posts" : "Posts"}
					</h2>
					{gridPosts.length === 0 && isSearching ? (
						<p className="py-12 text-muted-foreground">
							{tl('No posts match "{searchQuery}".', { searchQuery: query })}
						</p>
					) : (
						<ul className="grid gap-x-8 gap-y-14 sm:grid-cols-2 lg:grid-cols-3">
							{visiblePosts.map((post) => (
								<li key={post.id}>
									<BlogIndexCard post={post} />
								</li>
							))}
						</ul>
					)}
					{gridPosts.length > visibleCount ? (
						<Button
							className={cn("self-start rounded-full", outlineCtaClass)}
							onClick={() =>
								setVisibleCount((count) => count + BLOG_GRID_PAGE_SIZE)
							}
							size="lg"
							type="button"
							variant="outline"
						>
							Show more posts
						</Button>
					) : null}
				</section>
			) : null}
		</div>
	);
}

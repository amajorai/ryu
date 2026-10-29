"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { cn } from "@ryu/ui/lib/utils";
import { Search } from "lucide-react";
import type { Route } from "next";
import Image from "next/image";
import Link, { useLinkStatus } from "next/link";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { formatPublicationDate } from "./publication-date.ts";
import { outlineCtaClass } from "./sections.tsx";

/**
 * Block-local author shape. The live app's MDX `Author` type is a structural
 * superset, so it satisfies this without importing app-local types into the block.
 */
export interface BlogAuthorData {
	avatar?: string;
	name: string;
	slug: string;
}

/**
 * Block-local post shape, the subset of fields the presentational blog layer
 * needs. The live app's MDX `BlogPost` satisfies it structurally; `banner` and
 * author `avatar` are same-site `/content/...` paths or https URLs.
 */
export interface BlogPostData {
	authors?: BlogAuthorData[];
	banner?: string;
	content: string;
	date: string;
	id: string;
	pinned?: boolean;
	slug: string;
	tag?: string;
	title: string;
}

const AVATAR_SIZES = {
	small: { width: 20, height: 20, className: "h-5 w-5" },
	medium: { width: 24, height: 24, className: "h-6 w-6" },
	large: { width: 96, height: 96, className: "h-24 w-24" },
} as const;

function LinkPendingIndicator({ className }: { className: string }) {
	const { pending } = useLinkStatus();

	return (
		<span
			aria-hidden="true"
			className={cn(
				"pointer-events-none absolute size-2 rounded-full bg-primary opacity-0 transition-opacity",
				pending && "animate-pulse opacity-100",
				className
			)}
		/>
	);
}

/** Inline author avatars + names, presentational. */
export function BlogAuthor({
	authors,
	avatarSize = "small",
	className = "",
}: {
	authors?: BlogAuthorData[];
	avatarSize?: "small" | "medium" | "large";
	className?: string;
}) {
	const size = AVATAR_SIZES[avatarSize];

	if (!authors || authors.length === 0) {
		return null;
	}

	return (
		<div className={`flex items-center gap-2 ${className}`}>
			{authors.map((author, index) => {
				const avatarSrc = safeMediaUrl(author.avatar);
				return (
					<span className="flex items-center gap-2" key={author.slug}>
						<Link
							className="relative flex items-center gap-2 transition-colors hover:text-foreground"
							href={`/blog/author/${encodeURIComponent(author.slug)}`}
						>
							<LinkPendingIndicator className="-top-0.5 -right-1" />
							{avatarSrc ? (
								<Image
									alt={author.name}
									className={`${size.className} rounded-full object-cover`}
									height={size.height}
									src={avatarSrc}
									unoptimized
									width={size.width}
								/>
							) : null}
							<span>{author.name}</span>
						</Link>
						{index < authors.length - 1 && <span>,</span>}
					</span>
				);
			})}
		</div>
	);
}

/** The tags posts in apps/web/content/blog actually carry, most used first. */
export const BLOG_TAGS = [
	{ label: "All", value: undefined },
	{ label: "Comparisons", value: "Comparisons" },
	{ label: "Explainers", value: "Explainers" },
	{ label: "How-to", value: "How-to" },
	{ label: "Product", value: "Product" },
	{ label: "Company", value: "Company" },
	{ label: "Research", value: "Research" },
];

/**
 * Tag filter chips, presentational client links. With `counts`, only "All"
 * and tags that have posts render, and the row is hidden entirely when fewer
 * than two tags have posts (a single filter is not a choice).
 */
export function BlogTags({
	activeTag,
	authorFilter,
	counts,
}: {
	activeTag?: string;
	authorFilter?: string;
	counts?: Record<string, number>;
}) {
	const baseUrl = authorFilter ? `/blog/author/${authorFilter}` : "/blog";
	const tags = counts
		? BLOG_TAGS.filter(
				(tag) => tag.value === undefined || (counts[tag.value] ?? 0) > 0
			)
		: BLOG_TAGS;

	if (counts && tags.length - 1 < 2) {
		return null;
	}

	return (
		<div className="flex min-w-0 gap-2 overflow-x-auto py-1 [scrollbar-width:none] max-md:-mx-6 max-md:px-6 md:flex-wrap max-md:[mask-image:linear-gradient(to_right,black_85%,transparent)]">
			{tags.map((tag) => {
				const isActive = tag.value === activeTag || !(tag.value || activeTag);
				const url = tag.value
					? `${baseUrl}?tag=${encodeURIComponent(tag.value)}`
					: baseUrl;

				return (
					<Link
						className={cn(
							"relative inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-4 py-2 font-medium text-sm outline-offset-4 transition-colors focus-visible:outline-2 focus-visible:outline-ring max-md:min-h-10",
							isActive
								? "bg-foreground text-background"
								: "text-foreground hover:bg-black/5 dark:hover:bg-white/10"
						)}
						href={
							/* SAFETY: The href is constructed above from the existing /blog or /blog/author/[authorId] route family with an encoded tag query; Next documents this cast for nonliteral href construction. */ url as Route
						}
						key={tag.label}
					>
						<LinkPendingIndicator className="-top-0.5 -right-0.5" />
						{tag.label}
					</Link>
				);
			})}
		</div>
	);
}

/** Debounced search input, presentational client component. */
export function SearchInput({
	onSearch,
	placeholder = "Search",
	className = "",
}: {
	onSearch: (query: string) => void;
	placeholder?: string;
	className?: string;
}) {
	const [query, setQuery] = useState("");

	useEffect(() => {
		const debounceTimer = setTimeout(() => {
			onSearch(query);
		}, 300);

		return () => clearTimeout(debounceTimer);
	}, [query, onSearch]);

	return (
		<div className={`relative ${className}`}>
			<Search
				aria-hidden="true"
				className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
			/>
			<Input
				aria-label={placeholder}
				onChange={(e) => setQuery(e.target.value)}
				placeholder={placeholder}
				type="search"
				value={query}
				variant="blog-search"
			/>
		</div>
	);
}

/** One post as a list row: title and date, nothing else. */
export function BlogPostRow({ post }: { post: BlogPostData }) {
	return (
		<li>
			<Link
				className="group relative flex items-baseline justify-between gap-6 py-5"
				href={`/blog/${post.slug}`}
			>
				<span className="font-heading font-medium text-[17px] text-foreground underline-offset-4 group-hover:underline">
					{post.title}
				</span>
				<time
					className="shrink-0 text-muted-foreground text-sm tabular-nums"
					dateTime={post.date}
				>
					{formatPublicationDate(post.date, "short")}
				</time>
			</Link>
		</li>
	);
}

/**
 * One post in the featured tier: date and a large title, text only. Post data
 * carries no curated excerpt (`content` is a search blob), so none is shown.
 */
export function BlogFeaturedPost({ post }: { post: BlogPostData }) {
	return (
		<li>
			<time
				className="text-muted-foreground text-sm tabular-nums"
				dateTime={post.date}
			>
				{formatPublicationDate(post.date, "short")}
			</time>
			<Link
				className="relative mt-3 block text-balance font-heading font-medium text-2xl text-foreground leading-[1.2] tracking-[-0.03em] underline-offset-4 hover:underline md:text-[1.75rem]"
				href={`/blog/${post.slug}`}
			>
				<LinkPendingIndicator className="top-1 -left-4" />
				{post.title}
			</Link>
		</li>
	);
}

/** The newest posts as a text-only featured tier above the list. */
export function BlogFeatured({ posts }: { posts: BlogPostData[] }) {
	if (posts.length === 0) {
		return null;
	}
	return (
		<ul className="mb-16 grid gap-10 md:mb-20 md:grid-cols-3">
			{posts.map((post) => (
				<BlogFeaturedPost key={post.id} post={post} />
			))}
		</ul>
	);
}

/** A single blog post card, presentational. */
export function BlogPostCard({ post }: { post: BlogPostData }) {
	const formattedDate = formatPublicationDate(post.date, "short");
	const bannerSrc = safeMediaUrl(post.banner);

	return (
		<div className="group">
			<div className="flex flex-col gap-1 pb-3">
				<Link className="relative block" href={`/blog/${post.slug}`}>
					<LinkPendingIndicator className="top-3 right-3" />
					{bannerSrc ? (
						<div className="mb-4 aspect-video w-full overflow-hidden rounded-md">
							<Image
								alt={post.title}
								className="h-full w-full object-cover transition-transform duration-200 motion-safe:group-hover:scale-105"
								height={337}
								src={bannerSrc}
								unoptimized
								width={600}
							/>
						</div>
					) : null}
					<div className="flex flex-col gap-2">
						<h2
							className="font-heading font-medium text-xl transition-colors hover:underline hover:underline-offset-4"
							data-slot="article-title"
						>
							{post.title}
						</h2>
					</div>
				</Link>
				<div className="mb-2 flex items-center gap-2 text-muted-foreground text-sm">
					<BlogAuthor authors={post.authors} avatarSize="small" />
					{post.authors && post.authors.length > 0 && <span>&bull;</span>}
					<time dateTime={post.date}>{formattedDate}</time>
					{post.tag && (
						<>
							<span>&bull;</span>
							<span>{post.tag}</span>
						</>
					)}
				</div>
			</div>
		</div>
	);
}

const BLOG_PAGE_SIZE = 20;

/**
 * The searchable, pinned-first blog post list, presentational. With
 * `featuredCount`, the newest posts lead as a featured tier while no search
 * is active, and the list below skips them so nothing repeats.
 */
export function BlogPostsSearch({
	posts,
	className = "",
	featuredCount = 0,
	toolbar,
}: {
	posts: BlogPostData[];
	className?: string;
	featuredCount?: number;
	toolbar?: ReactNode;
}) {
	const tl = useLiteralMessages();
	const [searchQuery, setSearchQuery] = useState("");
	const [visibleCount, setVisibleCount] = useState(BLOG_PAGE_SIZE);

	// A new query starts a fresh list, so it shows the first page again.
	const handleSearch = useCallback((query: string) => {
		setSearchQuery(query);
		setVisibleCount(BLOG_PAGE_SIZE);
	}, []);

	const isSearching = searchQuery.trim().length > 0;
	// Posts arrive newest first; the featured tier is the head of that order.
	const featuredPosts = useMemo(
		() => (isSearching ? [] : posts.slice(0, featuredCount)),
		[featuredCount, isSearching, posts]
	);

	const orderedPosts = useMemo(() => {
		const query = searchQuery.trim().toLowerCase();
		const featuredIds = new Set(featuredPosts.map((post) => post.id));
		const matches = query
			? posts.filter((post) => {
					const titleMatch = post.title.toLowerCase().includes(query);
					const contentMatch = post.content.toLowerCase().includes(query);
					const tagMatch = post.tag?.toLowerCase().includes(query);
					const authorMatch = post.authors?.some((author) =>
						author.name.toLowerCase().includes(query)
					);
					return titleMatch || contentMatch || tagMatch || authorMatch;
				})
			: posts.filter((post) => !featuredIds.has(post.id));
		return [
			...matches.filter((post) => post.pinned),
			...matches.filter((post) => !post.pinned),
		];
	}, [featuredPosts, posts, searchQuery]);

	if (posts.length === 0) {
		return (
			<div className={className}>
				{toolbar ? <div className="mb-8">{toolbar}</div> : null}
				<p className="py-12 text-muted-foreground">Nothing here yet.</p>
			</div>
		);
	}

	const visiblePosts = orderedPosts.slice(0, visibleCount);

	return (
		<div className={className}>
			<div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
				{toolbar ?? <span />}
				<SearchInput
					className="w-full shrink-0 sm:w-56"
					onSearch={handleSearch}
					placeholder="Search posts"
				/>
			</div>
			<BlogFeatured posts={featuredPosts} />
			{orderedPosts.length === 0 && featuredPosts.length === 0 ? (
				<p className="py-12 text-muted-foreground">
					{tl('No posts match "{searchQuery}".', { searchQuery })}
				</p>
			) : (
				<>
					<ul>
						{visiblePosts.map((post) => (
							<BlogPostRow key={post.id} post={post} />
						))}
					</ul>
					{orderedPosts.length > visibleCount ? (
						<Button
							className={cn("corner-round mt-10 rounded-full", outlineCtaClass)}
							onClick={() => setVisibleCount((count) => count + BLOG_PAGE_SIZE)}
							size="lg"
							type="button"
							variant="outline"
						>
							Show more posts
						</Button>
					) : null}
				</>
			)}
		</div>
	);
}

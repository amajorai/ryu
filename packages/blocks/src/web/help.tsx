"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { Tabs, TabsList, TabsTrigger } from "@ryu/ui/components/tabs";
import Link from "next/link";
import { useMemo, useState } from "react";
import { SearchInput } from "./blog.tsx";

/**
 * Block-local help-article shape, the subset the presentational layer needs.
 * The live app's MDX `HelpArticle` is a structural superset.
 */
export interface HelpArticleData {
	category: string;
	content: string;
	id: string;
	last_edited_time?: string;
	slug: string;
	title: string;
}

/** Category navigation styled with the shared tab primitives. */
export function HelpCategories({
	categories,
	activeCategory,
}: {
	categories: string[];
	activeCategory?: string;
}) {
	return (
		<Tabs value={activeCategory ?? "All"}>
			<TabsList className="w-full" manageLayout={false} variant="pills">
				<TabsTrigger
					data-state={activeCategory ? "inactive" : "active"}
					nativeButton={false}
					render={<Link href="/help" />}
					value="All"
				>
					All
				</TabsTrigger>
				{categories.map((category) => (
					<TabsTrigger
						data-state={activeCategory === category ? "active" : "inactive"}
						key={category}
						nativeButton={false}
						render={
							<Link href={`/help/category/${encodeURIComponent(category)}`} />
						}
						value={category}
					>
						{category}
					</TabsTrigger>
				))}
			</TabsList>
		</Tabs>
	);
}

/** A heading line: Markdown `#` syntax, or processed text ending in a `[#slug]` anchor. */
const HEADING_LINE = /^(#+\s+.*|.*\[#[^\]]+\]\s*)$/;

/**
 * Plain-text excerpt: the first paragraph that is not a heading, with link
 * targets, heading anchors and emphasis marks removed.
 */
export function articleExcerpt(content: string): string {
	const paragraphs = content
		.split(/\n\s*\n/)
		.map((block) =>
			block
				.split("\n")
				.filter((line) => !HEADING_LINE.test(line.trim()))
				.join(" ")
				.trim()
		)
		.filter(Boolean);
	return (paragraphs[0] ?? "")
		.replace(/\s*\[#[^\]]+\]/g, "")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*_`]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** A single help article as a list row: title and a two-line excerpt. */
export function HelpArticleCard({ article }: { article: HelpArticleData }) {
	const excerpt = article.content ? articleExcerpt(article.content) : "";
	return (
		<li>
			<Link className="group block py-4" href={`/help/${article.slug}`}>
				<span className="font-heading font-medium text-base text-foreground underline-offset-4 group-hover:underline">
					{article.title}
				</span>
				{excerpt ? (
					<p className="mt-1 line-clamp-2 text-muted-foreground text-sm leading-relaxed">
						{excerpt}
					</p>
				) : null}
			</Link>
		</li>
	);
}

/** Below this many articles a search box has nothing to narrow down. */
const MIN_SEARCHABLE_ARTICLES = 8;

/** The searchable, category-grouped help article list, presentational. */
export function HelpArticlesSearch({
	articles,
	category,
	className = "",
}: {
	articles: HelpArticleData[];
	category?: string;
	className?: string;
}) {
	const tl = useLiteralMessages();
	const [searchQuery, setSearchQuery] = useState("");

	const filteredArticles = useMemo(() => {
		if (!searchQuery.trim()) {
			return articles;
		}
		const query = searchQuery.toLowerCase();
		return articles.filter((article) => {
			const titleMatch = article.title.toLowerCase().includes(query);
			const contentMatch = article.content.toLowerCase().includes(query);
			const categoryMatch = article.category.toLowerCase().includes(query);
			return titleMatch || contentMatch || categoryMatch;
		});
	}, [articles, searchQuery]);

	if (articles.length === 0) {
		return (
			<div className={className}>
				<p className="py-12 text-muted-foreground">
					{category
						? tl('No articles in "{category}" yet.', { category })
						: "No help articles yet."}
				</p>
			</div>
		);
	}

	const groupedArticles = new Map<string, HelpArticleData[]>();
	if (category) {
		groupedArticles.set(category, filteredArticles);
	} else {
		for (const article of filteredArticles) {
			const cat = article.category || "Uncategorized";
			const rows = groupedArticles.get(cat) ?? [];
			rows.push(article);
			groupedArticles.set(cat, rows);
		}
	}
	const showGroupTitles = groupedArticles.size > 1;
	// Same order as the category tabs, which getHelpCategories() sorts by name.
	const groups = [...groupedArticles].sort(([a], [b]) => a.localeCompare(b));

	return (
		<div className={className}>
			{articles.length >= MIN_SEARCHABLE_ARTICLES ? (
				<div className="mb-8">
					<SearchInput
						className="w-full max-w-xs"
						onSearch={setSearchQuery}
						placeholder="Search articles"
					/>
				</div>
			) : null}
			{filteredArticles.length === 0 ? (
				<p className="py-12 text-muted-foreground">
					{tl('No articles match "{searchQuery}".', { searchQuery })}
				</p>
			) : (
				<div className="space-y-12">
					{groups.map(([cat, catArticles]) => (
						<div data-slot="help-article-group" key={cat}>
							{showGroupTitles ? (
								<h2 className="mb-2 font-medium text-muted-foreground text-sm">
									{cat}
								</h2>
							) : null}
							<ul className="max-w-3xl">
								{catArticles.map((article) => (
									<HelpArticleCard article={article} key={article.id} />
								))}
							</ul>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

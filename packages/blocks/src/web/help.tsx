"use client";

import { Tabs, TabsList, TabsTrigger } from "@ryu/ui/components/tabs";
import Link from "next/link";
import { useMemo, useState } from "react";
import { SearchInput } from "./blog.tsx";

/**
 * Block-local help-article shape, the subset the presentational layer needs.
 * The live app's Notion `HelpArticle` is a structural superset.
 */
export interface HelpArticleData {
	category: string;
	content: string;
	id: string;
	last_edited_time?: string;
	slug: string;
	title: string;
}

/** Category tabs, presentational (Link-wrapped triggers). */
export function HelpCategories({
	categories,
	activeCategory,
}: {
	categories: string[];
	activeCategory?: string;
}) {
	return (
		<Tabs value={activeCategory ?? "All"}>
			<TabsList variant="pills">
				<Link href="/help">
					<TabsTrigger
						className={activeCategory ? "" : "pointer-events-none"}
						data-state={activeCategory ? "inactive" : "active"}
						value="All"
					>
						All Articles
					</TabsTrigger>
				</Link>
				{categories.map((category) => (
					<Link
						href={`/help/category/${encodeURIComponent(category)}`}
						key={category}
					>
						<TabsTrigger
							className={
								activeCategory === category
									? "pointer-events-none capitalize"
									: "capitalize"
							}
							data-state={activeCategory === category ? "active" : "inactive"}
							value={category}
						>
							{category}
						</TabsTrigger>
					</Link>
				))}
			</TabsList>
		</Tabs>
	);
}

/** A single help-article card, presentational. */
export function HelpArticleCard({ article }: { article: HelpArticleData }) {
	return (
		<Link href={`/help/${article.slug}`}>
			<div className="group rounded-lg border p-4 transition-all duration-200 hover:border-primary/50 hover:shadow-md">
				<div className="flex flex-col gap-2">
					<div className="flex items-start justify-between gap-2">
						<h3 className="font-medium text-lg transition-colors group-hover:text-primary">
							{article.title}
						</h3>
						{article.category && (
							<span className="whitespace-nowrap rounded-md bg-muted px-2 py-1 text-xs">
								{article.category}
							</span>
						)}
					</div>
					{article.content && (
						<p className="line-clamp-2 text-muted-foreground text-sm">
							{article.content
								.replace(/^#+\s+.+\n*/g, "")
								.trim()
								.substring(0, 150)}
						</p>
					)}
					<div className="mt-2 text-muted-foreground text-xs">
						Updated{" "}
						{new Date(article.last_edited_time ?? "").toLocaleDateString(
							"en-US",
							{ timeZone: "UTC" }
						)}
					</div>
				</div>
			</div>
		</Link>
	);
}

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
				<div className="py-12 text-center">
					<h3 className="mb-2 font-medium text-lg">No help articles found</h3>
					<p className="text-muted-foreground">
						{category
							? `No articles available in the "${category}" category.`
							: "No help articles are available at the moment."}
					</p>
				</div>
			</div>
		);
	}

	const groupedArticles = category
		? { [category]: filteredArticles }
		: filteredArticles.reduce(
				(groups, article) => {
					const cat = article.category || "Uncategorized";
					if (!groups[cat]) {
						groups[cat] = [];
					}
					groups[cat].push(article);
					return groups;
				},
				{} as Record<string, HelpArticleData[]>
			);

	return (
		<div className={className}>
			<div className="mb-8">
				<SearchInput onSearch={setSearchQuery} placeholder="Search articles" />
			</div>
			{filteredArticles.length === 0 ? (
				<div className="py-12 text-center">
					<h3 className="mb-2 font-medium text-lg">No results found</h3>
					<p className="text-muted-foreground">
						No help articles found matching "{searchQuery}".
					</p>
				</div>
			) : (
				<div className="space-y-8">
					{Object.entries(groupedArticles).map(([cat, catArticles]) => (
						<div key={cat}>
							{!category && (
								<h2 className="mb-4 font-semibold text-xl capitalize">{cat}</h2>
							)}
							<div className="grid gap-4 md:grid-cols-2">
								{catArticles.map((article) => (
									<HelpArticleCard article={article} key={article.id} />
								))}
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

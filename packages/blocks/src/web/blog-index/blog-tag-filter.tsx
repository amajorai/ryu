"use client";

import { cn } from "@ryu/ui/lib/utils.ts";
import type { Route } from "next";
import Link from "next/link";
import type { BlogTagChip } from "./blog-index-model.ts";

/**
 * The tag filter row: one link chip per tag with its post count. Each chip is
 * a `?tag=` link, so a filtered view is a real URL with its own metadata. The
 * active chip carries `aria-current`. Fewer than two tags is no choice, so the
 * row then renders nothing.
 */
export function BlogTagFilter({
	activeTag,
	baseUrl = "/blog",
	chips,
}: {
	activeTag?: string;
	baseUrl?: string;
	chips: readonly BlogTagChip[];
}) {
	if (chips.filter((chip) => chip.value).length < 2) {
		return null;
	}
	return (
		<nav aria-label="Filter posts by tag" className="min-w-0">
			<ul className="flex min-w-0 gap-2 overflow-x-auto py-1 [scrollbar-width:none] max-md:-mx-6 max-md:px-6 md:flex-wrap max-md:[mask-image:linear-gradient(to_right,black_85%,transparent)]">
				{chips.map((chip) => {
					const isActive =
						(chip.value ?? undefined) === (activeTag || undefined);
					const url = chip.value
						? `${baseUrl}?tag=${encodeURIComponent(chip.value)}`
						: baseUrl;
					return (
						<li className="shrink-0" key={chip.label}>
							<Link
								aria-current={isActive ? "page" : undefined}
								className={cn(
									"inline-flex items-center gap-2 whitespace-nowrap rounded-full border px-3.5 py-1.5 font-medium text-sm outline-offset-4 transition-colors focus-visible:outline-2 focus-visible:outline-ring max-md:min-h-10",
									isActive
										? "border-foreground bg-foreground text-background"
										: "border-border text-foreground hover:bg-muted"
								)}
								data-tag-chip={chip.value ?? "all"}
								href={
									/* SAFETY: built from the /blog route family (or an author's /blog/author/<slug>) with an encoded tag query; Next documents this cast for nonliteral hrefs. */ url as Route
								}
							>
								{chip.label}
								<span
									className={cn(
										"tabular-nums",
										isActive ? "text-background/70" : "text-muted-foreground"
									)}
									data-slot="tag-count"
								>
									{chip.count}
								</span>
							</Link>
						</li>
					);
				})}
			</ul>
		</nav>
	);
}

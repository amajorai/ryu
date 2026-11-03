"use client";

import Link from "next/link";
import { BlogAuthor } from "../blog.tsx";
import {
	BlogIndexImage,
	BlogIndexMeta,
	blogPostHref,
} from "./blog-index-card.tsx";
import type { BlogIndexPost } from "./blog-index-model.ts";

/**
 * The index's lead story as a large split card: the banner on one side; the
 * tag, date, title, summary, and authors on the other. Its title is the
 * page's first h2, directly under the hero's h1.
 */
export function BlogLeadPost({ post }: { post: BlogIndexPost }) {
	return (
		<article
			aria-labelledby="blog-lead-title"
			className="group relative grid gap-6 md:gap-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-center lg:gap-12"
			data-lead-slug={post.slug}
		>
			<BlogIndexImage post={post} priority />
			<div className="flex flex-col gap-4">
				<p className="font-medium text-muted-foreground text-sm">
					{post.pinned ? "Pinned" : "Latest"}
				</p>
				<BlogIndexMeta post={post} />
				<h2
					className="text-balance font-heading font-medium text-3xl text-foreground leading-tight tracking-tight lg:text-4xl"
					id="blog-lead-title"
				>
					<Link
						className="underline-offset-4 outline-offset-4 after:absolute after:inset-0 after:content-[''] group-hover:underline"
						href={blogPostHref(post)}
					>
						{post.title}
					</Link>
				</h2>
				{post.description ? (
					<p className="mt-0 text-pretty text-base text-muted-foreground leading-relaxed md:text-lg">
						{post.description}
					</p>
				) : null}
				<BlogAuthor
					authors={post.authors}
					avatarSize="medium"
					className="relative z-10 pt-2 text-foreground text-sm"
				/>
			</div>
		</article>
	);
}

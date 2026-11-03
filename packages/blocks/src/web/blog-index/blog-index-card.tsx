"use client";

import { useOptionalI18n } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import type { Route } from "next";
import Link from "next/link";
import { BlogAuthor } from "../blog.tsx";
import { formatPublicationDate } from "../publication-date.ts";
import { ThemedImage } from "../themed-image.tsx";
import type { BlogIndexPost } from "./blog-index-model.ts";

/** Banners and the generated social cards are both 1200x630. */
const IMAGE_FRAME_CLASS =
	"relative aspect-[1200/630] w-full overflow-hidden rounded-lg bg-muted";

/** The post's page; a typed-route cast because the block cannot see the app's routes. */
export function blogPostHref(post: { slug: string }): Route {
	// SAFETY: the host app serves /blog/[slug]; this shared block cannot see that app's generated typedRoutes list.
	return `/blog/${post.slug}` as Route;
}

/**
 * The post's banner (with its dark-mode copy), or the post's generated social
 * card when it has none. Decorative: the title beside it names the post.
 */
export function BlogIndexImage({
	post,
	priority = false,
}: {
	post: BlogIndexPost;
	priority?: boolean;
}) {
	const banner = safeMediaUrl(post.banner);
	return (
		<div className={IMAGE_FRAME_CLASS}>
			<ThemedImage
				alt=""
				className="h-full w-full object-cover transition-transform duration-300 motion-safe:group-hover:scale-[1.03]"
				darkSrc={banner ? safeMediaUrl(post.bannerDark) : null}
				height={630}
				priority={priority}
				src={banner ?? `/blog/${post.slug}/opengraph-image`}
				unoptimized
				width={1200}
			/>
		</div>
	);
}

/** Tag chip and publication date, the line above every title. */
export function BlogIndexMeta({ post }: { post: BlogIndexPost }) {
	const locale = useOptionalI18n()?.locale;
	return (
		<p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-sm">
			{post.tag ? (
				<Badge data-slot="post-tag" variant="outline">
					{post.tag}
				</Badge>
			) : null}
			<time className="tabular-nums" dateTime={post.date}>
				{formatPublicationDate(post.date, "short", locale)}
			</time>
		</p>
	);
}

/**
 * One post in the index grid: image, tag and date, title, summary, author.
 * The title link stretches over the whole card; the author links sit above it
 * so they stay their own targets without nesting anchors.
 */
export function BlogIndexCard({ post }: { post: BlogIndexPost }) {
	return (
		<article
			className="group relative flex h-full flex-col gap-4"
			data-post-slug={post.slug}
		>
			<BlogIndexImage post={post} />
			<div className="flex flex-1 flex-col gap-3">
				<BlogIndexMeta post={post} />
				<h3 className="text-balance font-heading font-medium text-foreground text-lg leading-snug">
					<Link
						className="underline-offset-4 outline-offset-4 after:absolute after:inset-0 after:content-[''] group-hover:underline"
						href={blogPostHref(post)}
					>
						{post.title}
					</Link>
				</h3>
				{post.description ? (
					<p className="line-clamp-3 text-muted-foreground text-sm leading-relaxed">
						{post.description}
					</p>
				) : null}
				<BlogAuthor
					authors={post.authors}
					avatarSize="medium"
					className="relative z-10 mt-auto pt-2 text-muted-foreground text-sm"
				/>
			</div>
		</article>
	);
}

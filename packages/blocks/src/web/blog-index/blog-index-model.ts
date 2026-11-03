import type { BlogPostData } from "../blog.tsx";
import { BLOG_TAGS } from "./blog-tag-list.ts";

/**
 * A post as the blog index shows it: the block's post shape plus the post's
 * frontmatter `description`, the one-line summary its cards print. Without one
 * the cards show no summary rather than a slice of the body.
 */
export interface BlogIndexPost extends BlogPostData {
	description?: string;
}

/** One tag filter chip: its label, the `?tag=` value, and how many posts carry it. */
export interface BlogTagChip {
	count: number;
	label: string;
	value?: string;
}

function timeOf(post: BlogPostData): number {
	const time = Date.parse(post.date);
	return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/** Newest first; a stable sort keeps same-day posts in their given order. */
export function newestFirst<T extends BlogPostData>(posts: readonly T[]): T[] {
	return [...posts].sort((a, b) => timeOf(b) - timeOf(a));
}

/**
 * The post the index leads with: the newest one marked `pinned: true` in its
 * frontmatter, otherwise the newest post. `undefined` for an empty list.
 */
export function pickLeadPost<T extends BlogPostData>(
	posts: readonly T[]
): T | undefined {
	const ordered = newestFirst(posts);
	return ordered.find((post) => post.pinned) ?? ordered[0];
}

/** How many posts carry each tag; untagged posts count toward no tag. */
export function countPostsByTag(
	posts: readonly BlogPostData[]
): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const post of posts) {
		if (post.tag) {
			counts[post.tag] = (counts[post.tag] ?? 0) + 1;
		}
	}
	return counts;
}

/**
 * The chips the filter row shows: "All" with the total, then every tag that
 * has posts. Known tags keep the BLOG_TAGS order (most used first); a tag the
 * list does not know yet follows them alphabetically, so no post is unreachable.
 */
export function buildTagChips(
	counts: Readonly<Record<string, number>>,
	total: number
): BlogTagChip[] {
	const known = new Set<string>();
	const chips: BlogTagChip[] = [{ count: total, label: "All" }];
	for (const tag of BLOG_TAGS) {
		if (tag.value) {
			known.add(tag.value);
			const count = counts[tag.value] ?? 0;
			if (count > 0) {
				chips.push({ count, label: tag.label, value: tag.value });
			}
		}
	}
	const unknown = Object.keys(counts)
		.filter((tag) => !known.has(tag) && (counts[tag] ?? 0) > 0)
		.sort((a, b) => a.localeCompare(b));
	for (const tag of unknown) {
		chips.push({ count: counts[tag] ?? 0, label: tag, value: tag });
	}
	return chips;
}

/** True when the post's title, summary, body text, tag, or an author matches. */
export function postMatchesQuery(post: BlogIndexPost, query: string): boolean {
	const needle = query.trim().toLowerCase();
	if (!needle) {
		return true;
	}
	return [
		post.title,
		post.description,
		post.content,
		post.tag,
		...(post.authors ?? []).map((author) => author.name),
	].some((field) => field?.toLowerCase().includes(needle));
}

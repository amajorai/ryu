import { expect, it } from "bun:test";
import { BLOG_TAGS as fromBlog } from "../blog.tsx";
import { BLOG_TAGS } from "./blog-tag-list.ts";

it("starts with All and keeps blog.tsx's export the same list", () => {
	expect(BLOG_TAGS[0]).toEqual({ label: "All", value: undefined });
	expect(fromBlog).toBe(BLOG_TAGS);
	const values = BLOG_TAGS.flatMap((tag) => (tag.value ? [tag.value] : []));
	expect(new Set(values).size).toBe(values.length);
});

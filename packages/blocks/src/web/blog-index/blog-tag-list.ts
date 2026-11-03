/**
 * The tags posts in apps/web/content/blog actually carry, most used first.
 * Kept out of the client `blog.tsx` module so server code (the blog index
 * page's tag counts) can read it as data rather than a client reference.
 */
export const BLOG_TAGS: readonly { label: string; value?: string }[] = [
	{ label: "All", value: undefined },
	{ label: "Comparisons", value: "Comparisons" },
	{ label: "Explainers", value: "Explainers" },
	{ label: "How-to", value: "How-to" },
	{ label: "Product", value: "Product" },
	{ label: "Company", value: "Company" },
	{ label: "Research", value: "Research" },
];

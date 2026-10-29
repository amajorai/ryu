import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type {
	MarketplaceReviewsPage,
	MarketplaceReviewsService,
} from "../../host.tsx";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { default: ReviewsPanel } = await import("./reviews-panel.tsx");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(() => root.unmount());
	container.remove();
});

function service(
	list: MarketplaceReviewsService["list"]
): MarketplaceReviewsService {
	return {
		canWrite: () => false,
		list,
		post: () => Promise.reject(new Error("Unexpected review write")),
		remove: () => Promise.reject(new Error("Unexpected review delete")),
	};
}

function page(
	title?: string,
	nextCursor: string | null = null
): MarketplaceReviewsPage {
	return {
		nextCursor,
		ratingAverage: title ? 4 : 0,
		ratingCount: title ? 1 : 0,
		reviews: title
			? [
					{
						id: title,
						title,
						body: "A real response",
						rating: 4,
						userName: "Reviewer",
						verifiedPurchase: false,
						createdAt: "2026-09-22T00:00:00Z",
					},
				]
			: [],
	};
}

async function click(label: string) {
	const button = [...container.querySelectorAll("button")].find((item) =>
		item.textContent?.includes(label)
	);
	if (button === undefined) {
		throw new Error(`Review action button not found: ${label}`);
	}
	await act(async () => {
		button.click();
		await Promise.resolve();
	});
}

async function renderReviews(reviews: MarketplaceReviewsService, id: string) {
	await act(async () => {
		root.render(<ReviewsPanel id={id} kind="app" service={reviews} />);
		await Promise.resolve();
	});
}

test("a failed read offers retry without claiming there are no reviews", async () => {
	let attempts = 0;
	const reviews = service(() =>
		++attempts === 1
			? Promise.reject(new Error("Service unavailable"))
			: Promise.resolve(page())
	);
	await renderReviews(reviews, "one");
	expect(container.querySelector('[role="alert"]')?.textContent).toContain(
		"Could not load reviews"
	);
	expect(container.textContent).not.toContain("No reviews yet");
	expect(container.textContent).not.toContain("Write the first review");
	await click("Try again");
	expect(attempts).toBe(2);
	expect(container.textContent).toContain("No reviews yet");
	expect(container.querySelector('[role="alert"]')).toBeNull();
});

test("a failed next page preserves the loaded reviews and retries its cursor", async () => {
	let attempts = 0;
	const cursors: (string | null | undefined)[] = [];
	const reviews = service(({ cursor }) => {
		cursors.push(cursor);
		if (!cursor) {
			return Promise.resolve(page("First review", "next"));
		}
		return ++attempts === 1
			? Promise.reject(new Error("Next page failed"))
			: Promise.resolve(page("Second review"));
	});
	await renderReviews(reviews, "one");
	await click("Load more reviews");
	expect(container.textContent).toContain("First review");
	expect(container.querySelector('[role="alert"]')?.textContent).toContain(
		"Next page failed"
	);
	await click("Load more reviews");
	expect(cursors).toEqual([null, "next", "next"]);
	expect(container.textContent).toContain("First review");
	expect(container.textContent).toContain("Second review");
});

test("a previous listing's response cannot replace the selected listing", async () => {
	const old = Promise.withResolvers<MarketplaceReviewsPage>();
	const reviews = service(({ id }) =>
		id === "old" ? old.promise : Promise.resolve(page("Current review"))
	);
	await renderReviews(reviews, "old");
	await renderReviews(reviews, "current");
	await act(async () => {
		old.resolve(page("Wrong listing"));
		await Promise.resolve();
	});
	expect(container.textContent).toContain("Current review");
	expect(container.textContent).not.toContain("Wrong listing");
});

test("a previous listing's pending save cannot reload its reviews into the current panel", async () => {
	const saving = Promise.withResolvers<{
		ratingAverage: number;
		ratingCount: number;
	}>();
	const reviews = service(({ id }) =>
		Promise.resolve(page(id === "old" ? "Old review" : "Current review"))
	);
	reviews.canWrite = () => true;
	reviews.post = () => saving.promise;
	await renderReviews(reviews, "old");
	await click("Write a review");
	const rating = container.querySelector<HTMLButtonElement>(
		'[aria-label="4 stars"]'
	);
	expect(rating).not.toBeNull();
	await act(async () => {
		rating?.click();
		await Promise.resolve();
	});
	await click("Post review");
	await renderReviews(reviews, "current");
	await act(async () => {
		saving.resolve({ ratingAverage: 4, ratingCount: 2 });
		await Promise.resolve();
	});
	expect(container.textContent).toContain("Current review");
	expect(container.textContent).not.toContain("Old review");
});

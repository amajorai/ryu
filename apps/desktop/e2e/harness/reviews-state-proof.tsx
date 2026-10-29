import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/inter";
import { createRoot } from "react-dom/client";
import ReviewsPanel from "../../../../packages/marketplace/src/catalog/detail/reviews-panel.tsx";
import type { MarketplaceReviewsService } from "../../../../packages/marketplace/src/host.tsx";
import "../../src/index.css";

let attempts = 0;
const service: MarketplaceReviewsService = {
	canWrite: () => false,
	list: () => {
		attempts++;
		if (attempts === 1) {
			return Promise.reject(
				new Error("The review service is unavailable. Please try again.")
			);
		}
		return Promise.resolve({
			reviews: [],
			ratingCount: 0,
			ratingAverage: 0,
			nextCursor: null,
		});
	},
	post: () => Promise.reject(new Error("Review writes are outside this proof")),
	remove: () =>
		Promise.reject(new Error("Review deletes are outside this proof")),
};
const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing review proof root");
}
document.documentElement.classList.toggle(
	"dark",
	new URLSearchParams(location.search).get("theme") === "dark"
);
createRoot(root).render(
	<main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 bg-background p-8 text-foreground">
		<header className="border-b pb-5">
			<p className="text-muted-foreground text-sm">Marketplace</p>
			<h1 className="mt-2 font-semibold text-2xl">Reviews</h1>
		</header>
		<ReviewsPanel id="review-proof" kind="app" service={service} />
	</main>
);

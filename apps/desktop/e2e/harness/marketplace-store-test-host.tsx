import {
	type MarketplaceHost,
	MarketplaceHostProvider,
	type MarketplaceReviewsService,
} from "@ryu/marketplace/host";
import type { ReactNode } from "react";
import { z } from "zod";

const api = (path: string) =>
	`${window.location.origin}/api/marketplace${path}`;

const likeSchema = z.object({
	count: z.number(),
	liked: z.boolean(),
	namespace: z.string(),
});
const reviewPageSchema = z.object({
	nextCursor: z.string().nullable(),
	ratingAverage: z.number(),
	ratingCount: z.number(),
	reviews: z.array(
		z.object({
			body: z.string().nullable(),
			createdAt: z.string(),
			id: z.string(),
			mine: z.boolean().optional(),
			rating: z.number(),
			title: z.string().nullable(),
			userName: z.string().nullable(),
			verifiedPurchase: z.boolean(),
		})
	),
});
async function readJson<T>(
	response: Response,
	schema: z.ZodType<T>
): Promise<T> {
	const body = await response.json();
	if (!response.ok) {
		const error = z.object({ error: z.string() }).safeParse(body);
		throw new Error(
			error.success
				? error.data.error
				: `Fixture request failed: ${response.status}`
		);
	}
	return schema.parse(body);
}

const reviews: MarketplaceReviewsService = {
	canWrite: () =>
		window.localStorage.getItem("fixture-marketplace-reviews-signed-out") !==
		"true",
	onSignIn: () => {
		window.dispatchEvent(
			new CustomEvent("marketplace-store:external", {
				detail: "https://fixture.invalid/login",
			})
		);
	},
	list: async ({ cursor, id, kind, limit }) => {
		const params = new URLSearchParams({ id, kind });
		if (cursor) {
			params.set("cursor", cursor);
		}
		if (limit) {
			params.set("limit", String(limit));
		}
		const response = await fetch(api(`/reviews?${params.toString()}`));
		// SAFETY: Controlled Store Home review GET publishes complete authored ReviewFixture rows, numeric aggregates and string-or-null nextCursor; readJson rejects failed responses before this view.
		return await readJson(response, reviewPageSchema);
	},
	post: async (input) => {
		const response = await fetch(api("/reviews"), {
			body: JSON.stringify(input),
			method: "POST",
		});
		// SAFETY: Controlled Store Home review POST parses storeReviewRequestSchema and publishes numeric ratingAverage/ratingCount; readJson excludes the fixture failure branch.
		return await readJson(
			response,
			z.object({ ratingAverage: z.number(), ratingCount: z.number() })
		);
	},
	remove: async ({ id, kind }) => {
		const params = new URLSearchParams({ id, kind });
		const response = await fetch(api(`/reviews?${params.toString()}`), {
			method: "DELETE",
		});
		await readJson(response, z.json());
	},
};

const host: MarketplaceHost = {
	guardPurchase: async (action) => action(),
	reviews,
	likes: {
		canLike: () => true,
		fetchCounts: async (namespaces) => {
			const response = await fetch(api("/likes/batch"), {
				body: JSON.stringify({ namespaces }),
				method: "POST",
			});
			const body = await readJson(
				response,
				z.object({ items: z.array(likeSchema) })
			);
			return body.items;
		},
		like: async (namespace) => {
			const response = await fetch(api("/likes"), {
				body: JSON.stringify({ namespace }),
				method: "POST",
			});
			// SAFETY: Controlled Store Home/Interactions like handlers serialize the parsed or mounted string namespace and authored numeric counter/boolean toggle state; readJson excludes failed responses.
			return await readJson(response, likeSchema);
		},
		unlike: async (namespace) => {
			const response = await fetch(api("/likes"), {
				body: JSON.stringify({ namespace }),
				method: "DELETE",
			});
			// SAFETY: Controlled Store Home/Interactions like handlers serialize the parsed or mounted string namespace and authored numeric counter/boolean toggle state; readJson excludes failed responses.
			return await readJson(response, likeSchema);
		},
	},
	openExternal: (url) => {
		window.dispatchEvent(
			new CustomEvent("marketplace-store:external", { detail: url })
		);
	},
	startPurchase: async (input) => {
		const response = await fetch(api("/purchase"), {
			body: JSON.stringify(input),
			method: "POST",
		});
		// SAFETY: Controlled Store Interactions purchase publishes the complete authored false/null/sessionId/url JSON object; readJson excludes failed responses before this fixture-only view.
		return await readJson(
			response,
			z.object({
				alreadyLicensed: z.boolean(),
				license: z.null(),
				sessionId: z.string(),
				url: z.string(),
			})
		);
	},
	useLicenses: () => ({
		authed: true,
		error: null,
		isLicensed: () => false,
		licenses: [],
		loading: false,
		refresh: () => undefined,
	}),
	useSellerStatus: () => ({
		authed: true,
		error: null,
		loading: false,
		onboard: async () => "",
		onboarding: false,
		refresh: () => undefined,
		status: null,
	}),
};

export function DesktopMarketplaceHost({ children }: { children: ReactNode }) {
	return (
		<MarketplaceHostProvider host={host}>{children}</MarketplaceHostProvider>
	);
}

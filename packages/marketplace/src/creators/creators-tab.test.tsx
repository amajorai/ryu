import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { MarketplaceHost } from "../host.tsx";
import type {
	MarketplaceCreator,
	MarketplaceCreatorProfile,
	MarketplaceCreatorSort,
	MarketplaceCreatorsService,
} from "./creator-types.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);

const { MarketplaceHostProvider } = await import("../host.tsx");
const { CreatorsTab } = await import("./creators-tab.tsx");
const { SellTab } = await import("../sell-tab.tsx");

function creator(over: Partial<MarketplaceCreator> = {}): MarketplaceCreator {
	return {
		bio: "Agents for finance teams.",
		featuredCount: 0,
		firstPublishedAt: "2026-03-01T00:00:00.000Z",
		followerCount: 12,
		githubHandle: "acme-labs",
		id: "64b7f0c2a1b2c3d4e5f60001",
		kinds: ["agent", "skill"],
		lastPublishedAt: "2026-09-01T00:00:00.000Z",
		listingCount: 3,
		logo: null,
		name: "Acme Labs",
		publisherTrust: "blue",
		publisherVerification: null,
		ratingAverage: 4.5,
		ratingCount: 8,
		slug: "acme",
		website: "https://acme.dev",
		xHandle: null,
		...over,
	};
}

function profile(): MarketplaceCreatorProfile {
	return {
		creator: creator(),
		listings: [
			{
				communityStats: { downloads: 40, instances: 3, runs: 9 },
				description: "Closes the books.",
				featured: true,
				iconUrl: null,
				id: "@acme/ledger",
				kind: "agent",
				name: "Ledger Agent",
				priceLabel: "Free",
				ratingAverage: 5,
				ratingCount: 2,
			},
			{
				communityStats: null,
				description: null,
				featured: false,
				iconUrl: null,
				id: "@acme/reconcile",
				kind: "skill",
				name: "Reconcile",
				priceLabel: "$9",
				ratingAverage: 0,
				ratingCount: 0,
			},
		],
	};
}

function makeHost(creators?: MarketplaceCreatorsService): MarketplaceHost {
	return {
		creators,
		openExternal: () => undefined,
		startPurchase: () => Promise.resolve({ alreadyLicensed: false, url: "" }),
		useLicenses: () => {
			throw new Error("unused");
		},
		useSellerStatus: () => ({
			authed: true,
			error: null,
			loading: false,
			onboard: () => Promise.resolve(""),
			onboarding: false,
			refresh: () => undefined,
			status: null,
		}),
	};
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 300));
	});
}

describe("CreatorsTab", () => {
	test("explains itself when the surface has no creators service", async () => {
		await act(async () => {
			root.render(
				<MarketplaceHostProvider host={makeHost()}>
					<CreatorsTab />
				</MarketplaceHostProvider>
			);
		});
		expect(container.textContent).toContain("Creators are not available here");
	});

	test("lists creators, re-queries on sort, and opens a profile", async () => {
		const listCalls: Array<{ query: string; sort: MarketplaceCreatorSort }> =
			[];
		const opened: string[] = [];
		const service: MarketplaceCreatorsService = {
			get: (handle) => Promise.resolve(handle === "acme" ? profile() : null),
			list: ({ query, sort }) => {
				listCalls.push({ query, sort });
				return Promise.resolve([
					creator(),
					creator({
						bio: null,
						id: "64b7f0c2a1b2c3d4e5f60002",
						kinds: ["mcp"],
						name: "Solo Dev",
						slug: null,
					}),
				]);
			},
			openListing: (listing) => opened.push(listing.id),
			renderFollow: (item) => (
				<button data-follow={item.id} type="button">
					Follow
				</button>
			),
		};

		await act(async () => {
			root.render(
				<MarketplaceHostProvider host={makeHost(service)}>
					<CreatorsTab />
				</MarketplaceHostProvider>
			);
		});
		await flush();

		const cards = container.querySelectorAll(
			"[data-testid='marketplace-creator-card']"
		);
		expect(cards).toHaveLength(2);
		expect(container.textContent).toContain("@acme");
		expect(container.textContent).toContain("Agents for finance teams.");
		expect(container.textContent).toContain("Publishes MCP");
		expect(container.querySelectorAll("[data-follow]")).toHaveLength(2);
		expect(listCalls.at(-1)).toEqual({ query: "", sort: "popular" });

		const select = container.querySelector<HTMLSelectElement>(
			"select[aria-label='Sort creators']"
		);
		await act(async () => {
			if (!select) {
				throw new Error("Expected the creator sort select");
			}
			select.value = "rating";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await flush();
		expect(listCalls.at(-1)?.sort).toBe("rating");

		const openButton = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "Acme Labs"
		);
		await act(async () => {
			openButton?.click();
		});
		await flush();

		const header = container.querySelector(
			"[data-testid='marketplace-creator-profile']"
		);
		expect(header?.textContent).toContain("Acme Labs");
		expect(header?.textContent).toContain("Publishing since Mar 2026");
		expect(header?.textContent).toContain("acme.dev");
		expect(header?.textContent).toContain("Downloads40");
		const website = header?.querySelector("a[href='https://acme.dev/']");
		expect(website?.getAttribute("rel")).toBe("noopener noreferrer");
		expect(container.textContent).toContain("Ledger Agent");
		expect(container.textContent).toContain("Reconcile");

		const agentFilter = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "Agent Templates"
		);
		await act(async () => {
			agentFilter?.click();
		});
		expect(container.textContent).toContain("Ledger Agent");
		expect(container.textContent).not.toContain("Reconcile");

		const back = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("All creators")
		);
		await act(async () => {
			back?.click();
		});
		await flush();
		expect(
			container.querySelectorAll("[data-testid='marketplace-creator-card']")
		).toHaveLength(2);
		expect(opened).toEqual([]);
	});

	test("shows not found for an unknown controlled handle", async () => {
		const handles: Array<string | null> = [];
		const service: MarketplaceCreatorsService = {
			get: () => Promise.resolve(null),
			list: () => Promise.resolve([]),
		};
		await act(async () => {
			root.render(
				<MarketplaceHostProvider host={makeHost(service)}>
					<CreatorsTab
						handle="ghost"
						onHandleChange={(next) => handles.push(next)}
					/>
				</MarketplaceHostProvider>
			);
		});
		await flush();
		expect(container.textContent).toContain("Creator not found");
		const back = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("All creators")
		);
		await act(async () => {
			back?.click();
		});
		expect(handles).toEqual([null]);
	});
});

describe("CreatorProfileEditor in the Sell tab", () => {
	test("is hidden without an ownProfile service", async () => {
		await act(async () => {
			root.render(
				<MarketplaceHostProvider host={makeHost()}>
					<SellTab />
				</MarketplaceHostProvider>
			);
		});
		expect(
			container.querySelector("[data-testid='creator-profile-editor']")
		).toBeNull();
	});

	test("loads and saves the organization's profile", async () => {
		const saved: unknown[] = [];
		const service: MarketplaceCreatorsService = {
			get: () => Promise.resolve(null),
			list: () => Promise.resolve([]),
			ownProfile: {
				load: () =>
					Promise.resolve({
						name: "Acme Labs",
						organizationId: "64b7f0c2a1b2c3d4e5f60001",
						profile: {
							bio: "Old bio",
							githubHandle: null,
							website: null,
							xHandle: null,
						},
						slug: "acme",
					}),
				save: (fields) => {
					saved.push(fields);
					return Promise.resolve(fields);
				},
			},
		};
		await act(async () => {
			root.render(
				<MarketplaceHostProvider host={makeHost(service)}>
					<SellTab />
				</MarketplaceHostProvider>
			);
		});
		await flush();

		const editor = container.querySelector(
			"[data-testid='creator-profile-editor']"
		);
		expect(editor?.textContent).toContain("Acme Labs (@acme)");
		const bio = editor?.querySelector("textarea");
		if (!bio) {
			throw new Error("Expected the creator biography textarea");
		}
		expect(bio.value).toBe("Old bio");

		const form = editor?.querySelector("form");
		await act(async () => {
			if (!form) {
				throw new Error("Expected the creator profile form");
			}
			form.dispatchEvent(
				new Event("submit", { bubbles: true, cancelable: true })
			);
		});
		expect(saved).toEqual([
			{ bio: "Old bio", githubHandle: null, website: null, xHandle: null },
		]);
	});
});

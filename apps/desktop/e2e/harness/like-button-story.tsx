// Standalone browser story for the REAL `ItemLikeButton` — the heart on every
// store card and listing detail.
//
// It needs a real browser because everything load-bearing about this control is
// a property of RESOLVED CSS and of animation lifecycle, neither of which
// happy-dom can answer:
//
//   - the pop scale must be on the `.t-like-icon` WRAPPER and NOT on the <svg>
//     (transforming an inline SVG makes Chromium rasterise it at 1x, so the
//     heart goes pixelated on hi-DPI). Only `getComputedStyle` can say which
//     element actually carries the animation.
//   - `.is-bursting` must be added and then REMOVED, or a second like fires no
//     burst at all. That is a timing fact.
//   - the reduced-motion block must actually suppress both animations.
//
// The transport is faked (no control plane here), but it is faked at the SEAM
// the real surfaces use — `MarketplaceHostProvider`'s `likes` service — so the
// store, the provider, the batching and the component are all the real ones.

import StoreCatalogCard from "@ryu/marketplace/catalog/chrome/store-catalog-card";
import {
	type MarketplaceHost,
	MarketplaceHostProvider,
} from "@ryu/marketplace/host";
import ItemLikeButton from "@ryu/marketplace/likes/like-button";
import type { LikeSnapshot } from "@ryu/marketplace/likes/store";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

/** Server-side truth for the story, mutated by the fake transport so the
 *  round-trip behaves like the real one (authoritative count comes back). */
const counts = new Map<string, number>([
	["@ryu/crm", 12],
	["@ryu/news", 3],
	["@ryu/fails", 7],
	["@ryu/anon", 5],
	["@ryu/blueprint", 208],
	["@ryu/harbor", 4],
]);

/** Sign-in prompts the anonymous row triggered, read by the spec. */
const authPrompts: string[] = [];
/* SAFETY: This module publishes its own authPrompts string array on the native browser Window; its sole mutation appends the authored prompted string. The view claims only this private capture slot. */ (
	window as typeof window & { __likeAuthPrompts: string[] }
).__likeAuthPrompts = authPrompts;
const mine = new Set<string>();

/** Resolve after a beat, so the OPTIMISTIC state is observable before the
 *  server answers — the whole point of the first assertion. */
const slow = <T,>(value: T): Promise<T> =>
	new Promise((resolve) => setTimeout(() => resolve(value), 250));

const host: MarketplaceHost = {
	likes: {
		canLike: () => true,
		fetchCounts: (namespaces: string[]): Promise<LikeSnapshot[]> =>
			Promise.resolve(
				namespaces.map((namespace) => ({
					namespace,
					count: counts.get(namespace) ?? 0,
					liked: mine.has(namespace),
				}))
			),
		like: (namespace: string): Promise<LikeSnapshot> => {
			// `@ryu/fails` always rejects — the rollback column.
			if (namespace === "@ryu/fails") {
				return new Promise((_resolve, reject) =>
					setTimeout(() => reject(new Error("nope")), 250)
				);
			}
			if (!mine.has(namespace)) {
				mine.add(namespace);
				counts.set(namespace, (counts.get(namespace) ?? 0) + 1);
			}
			return slow({
				namespace,
				count: counts.get(namespace) ?? 0,
				liked: true,
			});
		},
		unlike: (namespace: string): Promise<LikeSnapshot> => {
			if (mine.delete(namespace)) {
				counts.set(namespace, Math.max(0, (counts.get(namespace) ?? 0) - 1));
			}
			return slow({
				namespace,
				count: counts.get(namespace) ?? 0,
				liked: false,
			});
		},
	},
	openExternal: () => undefined,
	startPurchase: () => Promise.resolve({ alreadyLicensed: false, url: "" }),
	useLicenses: () => ({
		authed: false,
		error: null,
		isLicensed: () => false,
		licenses: [],
		loading: false,
		refresh: () => undefined,
	}),
	useSellerStatus: () => ({
		authed: false,
		error: null,
		loading: false,
		onboard: () => Promise.resolve(""),
		onboarding: false,
		refresh: () => undefined,
		status: null,
	}),
};

/** The SIGNED-OUT surface. Same everything, except no session — so the control
 *  still renders with its real count and a click must prompt rather than like.
 *  A separate provider because `canLike` is a property of the host, and the two
 *  states must be observable side by side in one page. */
const signedInLikes = host.likes;
if (!signedInLikes) {
	throw new Error("Like proof requires its authored service");
}
const signedOutHost: MarketplaceHost = {
	...host,
	likes: {
		...signedInLikes,
		canLike: () => false,
		onRequireAuth: () => authPrompts.push("prompted"),
	},
};

function Story() {
	return (
		<MarketplaceHostProvider host={host}>
			<main className="flex flex-col gap-6 bg-background p-8 text-foreground">
				<section className="flex items-center gap-6" data-testid="row-ok">
					<span className="text-sm">Harbor CRM</span>
					<ItemLikeButton namespace="@ryu/crm" />
				</section>
				<section className="flex items-center gap-6" data-testid="row-seeded">
					<span className="text-sm">Wire (seeded, already liked)</span>
					<ItemLikeButton
						namespace="@ryu/news"
						seed={{ count: 99, liked: true }}
					/>
				</section>
				<section className="flex items-center gap-6" data-testid="row-fails">
					<span className="text-sm">Always fails</span>
					<ItemLikeButton namespace="@ryu/fails" />
				</section>
				{/* The control INSIDE the real card row, which is where it actually
				    ships. The card's right-hand cluster already carries the lifecycle
				    action, and this is the only way to see whether a row with an
				    icon, a truncating description, an action and a heart still reads
				    as ONE row. */}
				<section className="w-[420px]" data-testid="row-card">
					<StoreCatalogCard
						action={
							<button
								className="rounded-md border px-2 py-1 text-xs"
								type="button"
							>
								Add
							</button>
						}
						description="Visual plans your agents can publish and you can review before anything runs."
						likeNamespace="@ryu/blueprint"
						name="Blueprint"
						onClick={() => undefined}
						seedId="@ryu/blueprint"
					/>
					<StoreCatalogCard
						action={
							<button
								className="rounded-md border px-2 py-1 text-xs"
								type="button"
							>
								Add
							</button>
						}
						description="A CRM that lives beside the chat."
						likeNamespace="@ryu/harbor"
						likeSeed={{ count: 4, liked: true }}
						name="Harbor CRM"
						onClick={() => undefined}
						seedId="@ryu/harbor"
					/>
				</section>
			</main>
		</MarketplaceHostProvider>
	);
}

/** The signed-out half, mounted under its own host below the signed-in one. */
function SignedOutStory() {
	return (
		<MarketplaceHostProvider host={signedOutHost}>
			<main className="flex flex-col gap-6 bg-background p-8 text-foreground">
				<section className="flex items-center gap-6" data-testid="row-anon">
					<span className="text-sm">Signed out</span>
					<ItemLikeButton namespace="@ryu/anon" />
				</section>
			</main>
		</MarketplaceHostProvider>
	);
}

const container = document.getElementById("root");
if (container) {
	createRoot(container).render(
		<>
			<Story />
			<SignedOutStory />
		</>
	);
}

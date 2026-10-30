// Render tests for THE Store catalog card, pinned on the two things about its
// layout that a type error cannot catch.
//
// 1. The heart renders BESIDE THE TITLE, and is not nested inside another
//    <button>. That nesting is invalid HTML: browsers repair it by dropping the
//    inner control, so the heart would silently disappear at runtime while
//    typecheck, `bun test` and the production build all stayed green. The assert
//    below is structural — it walks the emitted markup and fails if the like
//    button's opening tag is inside an unclosed <button>.
//
// 2. A card given an `href` emits a real <a href> and not a JS-only click target.
//    The web marketplace's item links are its crawlable surface, so losing the
//    anchor is an SEO regression that nothing else here would notice.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LikesProvider } from "../../likes/likes-provider.tsx";
import type {
	LikeSnapshot,
	MarketplaceLikesService,
} from "../../likes/likes-store.ts";
import StoreCatalogCard from "./store-catalog-card.tsx";

function snapshot(
	namespace: string,
	count: number,
	liked: boolean
): LikeSnapshot {
	return { count, liked, namespace };
}

const LIKES: MarketplaceLikesService = {
	canLike: () => true,
	fetchCounts: () => Promise.resolve<LikeSnapshot[]>([]),
	like: (namespace) => Promise.resolve(snapshot(namespace, 1, true)),
	unlike: (namespace) => Promise.resolve(snapshot(namespace, 0, false)),
};

function render(node: React.ReactNode): string {
	return renderToStaticMarkup(
		<LikesProvider service={LIKES}>{node}</LikesProvider>
	);
}

/** Where the like button's own `<button` opening tag starts. The testid sits a
 *  few attributes INTO that tag, so nesting must be measured from the tag, not
 *  from the attribute — measuring from the attribute counts the control's own
 *  opening tag as an enclosing one and reports every card as nested. */
function likeButtonTagStart(html: string): number {
	const at = html.indexOf('data-testid="item-like-button"');
	return at === -1 ? -1 : html.lastIndexOf("<button", at);
}

/** Is `index` inside an unclosed <button> in `html`? Counts opening and closing
 *  button tags up to that point — the exact check a nested-button bug fails. */
function insideButton(html: string, index: number): boolean {
	const before = html.slice(0, index);
	const opens = before.match(/<button\b/g)?.length ?? 0;
	const closes = before.match(/<\/button>/g)?.length ?? 0;
	return opens > closes;
}

describe("StoreCatalogCard", () => {
	test("renders the heart, outside any button", () => {
		const html = render(
			<StoreCatalogCard
				description="A thing"
				likeNamespace="@ryu/crm"
				likeSeed={{ count: 12, liked: false }}
				name="Harbor"
				onClick={() => undefined}
				seedId="@ryu/crm"
			/>
		);
		const at = likeButtonTagStart(html);
		expect(at).toBeGreaterThan(-1);
		expect(insideButton(html, at)).toBe(false);
	});

	test("puts the heart with the title, ahead of the action", () => {
		const html = render(
			<StoreCatalogCard
				action={
					<button data-testid="add" type="button">
						Add
					</button>
				}
				likeNamespace="@ryu/crm"
				likeSeed={{ count: 12, liked: false }}
				name="Harbor"
				onClick={() => undefined}
			/>
		);
		const heart = html.indexOf('data-testid="item-like-button"');
		const title = html.indexOf("Harbor</span>");
		const action = html.indexOf('data-testid="add"');
		expect(title).toBeGreaterThan(-1);
		expect(heart).toBeGreaterThan(title);
		expect(heart).toBeLessThan(action);
	});

	// The count itself is seeded from an EFFECT (`useItemLike` calls `store.seed`
	// there, so a render stays pure), and effects do not run under
	// renderToStaticMarkup — the number is deliberately not asserted here.
	// `likes-store.test.ts` owns seeding.

	test("omits the heart when the listing has no namespace", () => {
		const html = render(
			<StoreCatalogCard name="Harbor" onClick={() => undefined} />
		);
		expect(html).not.toContain('data-testid="item-like-button"');
	});

	test("emits a crawlable anchor when given an href", () => {
		const html = render(
			<StoreCatalogCard href="/marketplace/plugins/%40ryu/crm" name="Harbor" />
		);
		expect(html).toContain('href="/marketplace/plugins/%40ryu/crm"');
	});

	test("falls back to a button target when there is no href", () => {
		const html = render(
			<StoreCatalogCard name="Harbor" onClick={() => undefined} />
		);
		expect(html).not.toContain("<a ");
		expect(html).toContain('aria-label="Harbor"');
	});

	test("keeps layer badges off the row (they live in the detail pane)", () => {
		const html = render(
			<StoreCatalogCard
				external
				layers={[
					{ capability: "browser.control", title: "Browser", toolkit: true },
				]}
				name="Cloudflare Browser Run"
				onClick={() => undefined}
			/>
		);
		expect(html).not.toContain("External");
		expect(html).not.toContain("Browser toolkit");
	});

	test("distinguishes community apps from apps reviewed by Ryu", () => {
		const community = render(
			<StoreCatalogCard communityApp name="Trail Log" reviewed={false} />
		);
		const reviewed = render(<StoreCatalogCard name="Field Notes" reviewed />);

		expect(community).toContain("Community app");
		expect(community).not.toContain("Verified by Ryu");
		expect(reviewed).toContain("Verified by Ryu");
		expect(reviewed).not.toContain("Community app");
	});

	test("badges deprecated listings and leaves current ones bare", () => {
		const deprecated = render(<StoreCatalogCard deprecated name="Old Tool" />);
		const current = render(<StoreCatalogCard name="New Tool" />);

		expect(deprecated).toContain('data-testid="deprecated-badge"');
		expect(deprecated).toContain("Deprecated");
		expect(current).not.toContain('data-testid="deprecated-badge"');
	});

	test("shows the A Major Pass ticket only for eligible listings", () => {
		const eligible = render(
			<StoreCatalogCard
				membershipIncluded
				name="Harbor"
				onClick={() => undefined}
			/>
		);
		const excluded = render(
			<StoreCatalogCard name="Harbor" onClick={() => undefined} />
		);

		expect(eligible).toContain('data-slot="marketplace-access-trigger"');
		expect(eligible).toContain("Get this with A Major Pass");
		expect(excluded).not.toContain('data-slot="marketplace-access-trigger"');
	});
});

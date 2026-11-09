import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { LanguagePack } from "@ryu/i18n";
import { I18nProvider } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// Keep Bun's own network stack across DOM registration: the review talks to a
// real HTTP peer below, not a mocked API module. A sibling suite may have left
// the DOM registered, so start from Bun's globals and restore them afterwards.
if (GlobalRegistrator.isRegistered) {
	await GlobalRegistrator.unregister();
}
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
globalThis.fetch = nativeFetch;
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { MemoryDreamReview } = await import("./MemoryDreamReview.tsx");

const pack: LanguagePack = {
	baseLocale: "en",
	direction: "ltr",
	id: "test/en",
	locale: "en",
	messages: {},
	name: "English",
	schemaVersion: 1,
	version: "1.0.0",
};

const calls: string[] = [];
// Changes undone from another window: Core no longer lists them, and refuses
// to undo them again.
const undoneElsewhere = new Set<string>();

// Core's review: one pending new memory, plus two accepted changes that can
// still be undone. Rolling back `blocked-1` is refused, as Core does once a
// later revision builds on it.
const core = Bun.serve({
	port: 0,
	fetch(request) {
		const { pathname } = new URL(request.url);
		if (pathname === "/api/memory/dream/review/settings") {
			return NativeResponse.json({ settings: {} });
		}
		if (pathname === "/api/memory/dream/review") {
			return NativeResponse.json({
				review: {
					generated_at: 1,
					mode: "manual",
					proposals: [
						{
							current: null,
							id: "create-1",
							operation: "create",
							proposed: { content: "Prefers window seats", id: "p-1" },
						},
					],
					recent: [
						{
							current: { content: "Prefers aisle seats", id: "memory-1" },
							id: "revise-1",
							operation: "revise",
							proposed: { content: "Prefers exit rows", id: "p-2" },
							status: "applied",
						},
						{
							current: null,
							id: "blocked-1",
							operation: "create",
							proposed: { content: "Drinks green tea", id: "p-3" },
							status: "applied",
						},
					].filter((change) => !undoneElsewhere.has(change.id)),
				},
			});
		}
		if (pathname === "/api/preferences/chat-memory-enabled") {
			// The review screen also shows the Remember chats setting.
			return NativeResponse.json({ value: "true" });
		}
		if (pathname === "/api/gateway/org-features") {
			// The settings card checks whether the node is organization-bound.
			return NativeResponse.json({ features: {}, managed: false });
		}
		calls.push(`${request.method} ${pathname}`);
		if (
			[...undoneElsewhere].some((id) => pathname.endsWith(`/${id}/rollback`))
		) {
			return NativeResponse.json(
				{ error: "only an accepted proposal can be undone" },
				{ status: 409 }
			);
		}
		if (pathname.endsWith("/blocked-1/rollback")) {
			return NativeResponse.json(
				{ error: "revision has itself been revised" },
				{ status: 409 }
			);
		}
		if (pathname.endsWith("/rollback")) {
			return NativeResponse.json({ success: true });
		}
		if (pathname.endsWith("/accept")) {
			return NativeResponse.json({
				memory: { content: "Prefers window seats", id: "memory-2" },
			});
		}
		return new NativeResponse("not found", { status: 404 });
	},
});

afterAll(async () => {
	core.stop(true);
	await GlobalRegistrator.unregister();
});

async function waitFor(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50 && !check(); attempt += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
	}
}

function recentItems(container: HTMLElement): HTMLElement[] {
	return Array.from(
		container.querySelectorAll<HTMLElement>("[data-testid=dream-recent-item]")
	);
}

function buttonIn(element: Element | undefined, label: string) {
	return Array.from(element?.querySelectorAll("button") ?? []).find((button) =>
		button.textContent?.includes(label)
	);
}

describe("MemoryDreamReview recently accepted", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(async () => {
		calls.length = 0;
		undoneElsewhere.clear();
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		await act(async () => {
			root.render(
				<I18nProvider
					autoLocalizeDom={false}
					initialPackId={pack.id}
					manageDocument={false}
					packs={[pack]}
				>
					<MemoryDreamReview target={{ token: null, url: core.url.origin }} />
				</I18nProvider>
			);
		});
		await waitFor(() => recentItems(container).length === 2);
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
	});

	it("lists accepted changes and undoes one through Core", async () => {
		const [revision, blocked] = recentItems(container);
		expect(container.textContent).toContain("Recently accepted");
		expect(revision?.textContent).toContain("Prefers exit rows");
		expect(revision?.textContent).toContain("Updated");
		expect(blocked?.textContent).toContain("Saved");

		await act(async () => {
			buttonIn(revision, "Undo")?.click();
		});
		await waitFor(() => recentItems(container).length === 1);
		expect(calls).toEqual([
			"POST /api/memory/dream/review/proposals/revise-1/rollback",
		]);
		expect(container.textContent).not.toContain("Prefers exit rows");
	});

	it("keeps a change Core refuses to undo", async () => {
		const [, blocked] = recentItems(container);
		await act(async () => {
			buttonIn(blocked, "Undo")?.click();
		});
		await waitFor(() => calls.length > 0);
		await waitFor(() => !buttonIn(recentItems(container)[1], "Undo")?.disabled);
		expect(calls).toEqual([
			"POST /api/memory/dream/review/proposals/blocked-1/rollback",
		]);
		expect(recentItems(container).map((item) => item.textContent)).toEqual([
			expect.stringContaining("Prefers exit rows"),
			expect.stringContaining("Drinks green tea"),
		]);
	});

	it("drops a change that was already undone elsewhere", async () => {
		// Another window undid the revision after this list loaded.
		undoneElsewhere.add("revise-1");
		const [revision] = recentItems(container);
		await act(async () => {
			buttonIn(revision, "Undo")?.click();
		});
		await waitFor(() => recentItems(container).length === 1);
		expect(calls).toEqual([
			"POST /api/memory/dream/review/proposals/revise-1/rollback",
		]);
		// Core's own list replaces the stale entry; nothing asks the user to
		// undo a later change that does not exist.
		expect(recentItems(container).map((item) => item.textContent)).toEqual([
			expect.stringContaining("Drinks green tea"),
		]);
	});

	it("adds a proposal accepted now to the list so it can be undone", async () => {
		const card = container.querySelector("[data-testid=dream-proposal]");
		await act(async () => {
			buttonIn(card ?? undefined, "Accept memory")?.click();
		});
		await waitFor(() => recentItems(container).length === 3);
		expect(calls).toEqual([
			"POST /api/memory/dream/review/proposals/create-1/accept",
		]);
		const [accepted] = recentItems(container);
		expect(accepted?.textContent).toContain("Prefers window seats");
		expect(accepted?.textContent).toContain("Saved");
		expect(container.querySelector("[data-testid=dream-proposal]")).toBe(null);
	});
});

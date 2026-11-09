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
// real HTTP peer below, not a mocked API module.
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

const STALE_REASON =
	"This event is more than 90 days old and no chat has used it in the last 90 days.";
const accepted: string[] = [];

// Core's review: one archive of an old event, beside one new memory.
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
							current: {
								category: "event",
								content: "Flew to Lisbon on 3 March",
								id: "memory-1",
								importance: 3,
								scope: "user",
								tags: ["travel"],
							},
							id: "archive-1",
							operation: "archive",
							proposed: { content: "", id: "proposal-memory-archive-1" },
							reason: STALE_REASON,
							target_memory_id: "memory-1",
						},
						{
							current: null,
							id: "create-1",
							operation: "create",
							proposed: { content: "Prefers window seats", id: "p-2" },
						},
					],
				},
			});
		}
		if (pathname.endsWith("/accept")) {
			accepted.push(pathname);
			return NativeResponse.json({
				memory: { content: "Flew to Lisbon on 3 March", id: "memory-1" },
			});
		}
		return new NativeResponse("not found", { status: 404 });
	},
});

afterAll(() => {
	core.stop(true);
});

async function waitFor(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50 && !check(); attempt += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
	}
}

describe("MemoryDreamReview archive proposals", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
	});

	it("shows the memory to retire and archives it on accept", async () => {
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
		await waitFor(
			() =>
				container.querySelectorAll("[data-testid=dream-proposal]").length > 1
		);

		const [archiveCard, createCard] = Array.from(
			container.querySelectorAll("[data-testid=dream-proposal]")
		);
		const archiveText = archiveCard?.textContent ?? "";
		expect(archiveText).toContain("Retire this memory");
		expect(archiveText).toContain("Current memory");
		expect(archiveText).toContain("Flew to Lisbon on 3 March");
		expect(archiveText).toContain(STALE_REASON);
		expect(archiveText).toContain("It is not deleted.");
		expect(archiveText).not.toContain("Proposed");
		expect(archiveCard?.querySelector("[data-testid=dream-archive]")).not.toBe(
			null
		);
		// A new memory keeps the usual framing.
		expect(createCard?.textContent).toContain("Proposed memory");
		expect(createCard?.textContent).toContain("Accept memory");

		const archiveButton = Array.from(
			archiveCard?.querySelectorAll("button") ?? []
		).find((button) => button.textContent?.includes("Archive memory"));
		expect(archiveButton).toBeDefined();
		await act(async () => {
			archiveButton?.click();
		});
		await waitFor(() => accepted.length > 0);
		expect(accepted).toEqual([
			"/api/memory/dream/review/proposals/archive-1/accept",
		]);
		await waitFor(
			() =>
				container.querySelectorAll("[data-testid=dream-proposal]").length === 1
		);
		const cards = container.querySelectorAll("[data-testid=dream-proposal]");
		expect(cards[0]?.textContent).not.toContain("Flew to Lisbon on 3 March");
		// The archive moves to Recently accepted, where it can be undone.
		const recent = container.querySelector("[data-testid=dream-recent]");
		expect(recent?.textContent).toContain("Flew to Lisbon on 3 March");
		expect(recent?.textContent).toContain("Archived");
	});
});

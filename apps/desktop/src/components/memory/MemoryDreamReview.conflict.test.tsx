import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
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

// The toasts are what the reader sees; record them instead of rendering.
const errors: { description?: string; title: string }[] = [];
mock.module("sileo", () => ({
	sileo: {
		error: (options: { description?: string; title: string }) => {
			errors.push({ description: options.description, title: options.title });
		},
		success: () => undefined,
	},
	Toaster: () => null,
}));

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

interface Refusal {
	body: Record<string, string>;
	status: number;
}

// What Core answers to an accept or reject, by proposal id.
const refusals = new Map<string, Refusal>();
// Proposals Core no longer lists as pending.
const handled = new Set<string>();
let reviewReads = 0;
let reviewFailsAfterFirstRead = false;

const core = Bun.serve({
	port: 0,
	fetch(request) {
		const { pathname } = new URL(request.url);
		if (pathname === "/api/memory/dream/review/settings") {
			return NativeResponse.json({ settings: {} });
		}
		if (pathname === "/api/preferences/chat-memory-enabled") {
			return NativeResponse.json({ value: "true" });
		}
		if (pathname === "/api/memory/dream/review") {
			reviewReads += 1;
			if (reviewFailsAfterFirstRead && reviewReads > 1) {
				return NativeResponse.json({ error: "down" }, { status: 500 });
			}
			return NativeResponse.json({
				review: {
					generated_at: 1,
					mode: "manual",
					proposals: [
						{
							current: { content: "Prefers aisle seats", id: "memory-1" },
							id: "revise-1",
							operation: "revise",
							proposed: { content: "Prefers window seats", id: "p-1" },
							target_memory_id: "memory-1",
						},
					].filter((proposal) => !handled.has(proposal.id)),
					recent: [],
				},
			});
		}
		const refusal = refusals.get("revise-1");
		if (refusal) {
			return NativeResponse.json(refusal.body, { status: refusal.status });
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

function cards(container: HTMLElement): Element[] {
	return Array.from(container.querySelectorAll("[data-testid=dream-proposal]"));
}

function conflict(code: string | null): Refusal {
	const body: Record<string, string> = { error: "refused" };
	if (code) {
		body.code = code;
	}
	return { body, status: 409 };
}

describe("MemoryDreamReview when Core refuses a review", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(async () => {
		errors.length = 0;
		refusals.clear();
		handled.clear();
		reviewReads = 0;
		reviewFailsAfterFirstRead = false;
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
		await waitFor(() => cards(container).length === 1);
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
	});

	async function press(label: string): Promise<void> {
		const button = Array.from(
			cards(container)[0]?.querySelectorAll("button") ?? []
		).find((candidate) => candidate.textContent?.includes(label));
		if (!button) {
			throw new Error(`no ${label} button on the proposal`);
		}
		await act(async () => {
			button.click();
		});
		await waitFor(() => errors.length > 0);
	}

	it("keeps a proposal whose memory was edited since, and says so", async () => {
		refusals.set("revise-1", conflict("target_changed"));
		await press("Accept");
		expect(errors).toEqual([
			{
				description:
					"The memory it changes was edited or archived since. Reject it, or run Dream again.",
				title: "Couldn't accept this memory",
			},
		]);
		expect(reviewReads).toBe(2);
		expect(cards(container)).toHaveLength(1);
	});

	it("drops a proposal whose memory was deleted after re-reading Core", async () => {
		refusals.set("revise-1", conflict("target_deleted"));
		handled.add("revise-1");
		await press("Accept");
		await waitFor(() => cards(container).length === 0);
		expect(errors[0]?.description).toBe(
			"The memory it changes was deleted, so it was closed automatically."
		);
		expect(reviewReads).toBe(2);
		expect(cards(container)).toHaveLength(0);
	});

	it("says an accept lost to a rejection elsewhere", async () => {
		refusals.set("revise-1", conflict("already_rejected"));
		handled.add("revise-1");
		await press("Accept");
		expect(errors[0]?.description).toBe("It was already rejected elsewhere.");
		await waitFor(() => cards(container).length === 0);
		expect(cards(container)).toHaveLength(0);
	});

	it("says a reject lost to an acceptance elsewhere", async () => {
		refusals.set("revise-1", conflict("already_accepted"));
		handled.add("revise-1");
		await press("Reject");
		expect(errors).toEqual([
			{
				description: "It was already accepted elsewhere.",
				title: "Couldn't reject this proposal",
			},
		]);
		await waitFor(() => cards(container).length === 0);
		expect(cards(container)).toHaveLength(0);
	});

	it("says a reject came after the change was accepted and undone", async () => {
		refusals.set("revise-1", conflict("already_undone"));
		handled.add("revise-1");
		await press("Reject");
		expect(errors[0]?.description).toBe(
			"It was accepted and then undone elsewhere."
		);
	});

	it("treats a 409 without a code as handled and drops it when Core can't be re-read", async () => {
		refusals.set("revise-1", conflict(null));
		reviewFailsAfterFirstRead = true;
		await press("Accept");
		expect(errors[0]?.description).toBe("It was already handled elsewhere.");
		await waitFor(() => cards(container).length === 0);
		expect(cards(container)).toHaveLength(0);
	});

	it("keeps the waiting message for a failure that is not a conflict", async () => {
		refusals.set("revise-1", { body: { error: "boom" }, status: 500 });
		await press("Accept");
		expect(errors).toEqual([
			{
				description: "The proposal is still waiting for review.",
				title: "Couldn't accept this memory",
			},
		]);
		expect(reviewReads).toBe(1);
		expect(cards(container)).toHaveLength(1);
	});
});

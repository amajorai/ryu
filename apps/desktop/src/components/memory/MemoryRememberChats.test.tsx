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
// The prompt and card render inside the review; importing them here keeps the
// module under test explicit for the pre-commit companion check.
await import("./MemoryRememberChats.tsx");

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

const PREF_PATH = "/api/preferences/chat-memory-enabled";
const REVIEW_PATH = "/api/memory/dream/review";

// A Core that, like the real one, refuses Dream runs (409) while Remember
// chats is off and records every preference write.
const node = { chatMemory: "false", runs: 0, writes: [] as string[] };

const core = Bun.serve({
	port: 0,
	async fetch(request) {
		const { pathname } = new URL(request.url);
		if (pathname === PREF_PATH) {
			if (request.method === "PUT") {
				const body = (await request.json()) as { value: string };
				node.writes.push(body.value);
				node.chatMemory = body.value;
				return NativeResponse.json({ success: true });
			}
			return NativeResponse.json({
				key: "chat-memory-enabled",
				value: node.chatMemory,
			});
		}
		if (pathname === `${REVIEW_PATH}/settings`) {
			return NativeResponse.json({ settings: {} });
		}
		if (pathname === REVIEW_PATH && request.method === "POST") {
			node.runs += 1;
			if (node.chatMemory !== "true") {
				return NativeResponse.json(
					{ error: "turn on Remember chats before running Dream review" },
					{ status: 409 }
				);
			}
			return NativeResponse.json({
				review: {
					generated_at: 2,
					mode: "manual",
					proposals: [
						{
							current: null,
							id: "create-1",
							operation: "create",
							proposed: { content: "Prefers window seats", id: "p-1" },
						},
					],
				},
			});
		}
		if (pathname === REVIEW_PATH) {
			return NativeResponse.json({
				review: { generated_at: 0, proposals: [] },
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

describe("Remember chats on the Dream screen", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(async () => {
		node.chatMemory = "false";
		node.runs = 0;
		node.writes = [];
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
		await waitFor(
			() => rememberSwitch()?.hasAttribute("data-disabled") === false
		);
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
	});

	function rememberSwitch(): Element | null {
		return container.querySelector(
			"[data-testid=memory-remember-chats] [role=switch]"
		);
	}

	function button(label: string): HTMLButtonElement | undefined {
		return Array.from(container.querySelectorAll("button")).find((item) =>
			item.textContent?.includes(label)
		);
	}

	function prompt(): Element | null {
		return container.querySelector("[data-testid=dream-remember-chats-prompt]");
	}

	it("shows the saved setting as a switch that writes the preference", async () => {
		const card = container.querySelector("[data-testid=memory-remember-chats]");
		expect(card?.textContent).toContain("Remember chats");
		expect(rememberSwitch()?.getAttribute("aria-checked")).toBe("false");

		await act(async () => {
			(rememberSwitch() as HTMLElement).click();
		});
		await waitFor(() => node.writes.length > 0);
		expect(node.writes).toEqual(["true"]);
		await waitFor(
			() => rememberSwitch()?.getAttribute("aria-checked") === "true"
		);
		expect(rememberSwitch()?.getAttribute("aria-checked")).toBe("true");

		await act(async () => {
			(rememberSwitch() as HTMLElement).click();
		});
		await waitFor(() => node.writes.length > 1);
		expect(node.writes).toEqual(["true", "false"]);
	});

	it("asks before turning Remember chats on when Dream is refused", async () => {
		expect(prompt()).toBe(null);
		await act(async () => {
			button("Run Dream now")?.click();
		});
		await waitFor(() => prompt() !== null);

		expect(node.runs).toBe(1);
		expect(prompt()?.textContent).toContain("Dream needs Remember chats");
		expect(container.textContent).not.toContain("Dream couldn't load");
		// The refusal alone never changes the setting.
		expect(node.writes).toEqual([]);
		expect(node.chatMemory).toBe("false");

		await act(async () => {
			button("Turn on Remember chats")?.click();
		});
		await waitFor(() => prompt() === null);
		expect(node.writes).toEqual(["true"]);
		expect(rememberSwitch()?.getAttribute("aria-checked")).toBe("true");

		await act(async () => {
			button("Run Dream now")?.click();
		});
		await waitFor(
			() => container.querySelector("[data-testid=dream-proposal]") !== null
		);
		expect(container.textContent).toContain("Prefers window seats");
		expect(node.runs).toBe(2);
	});

	it("asks again when Remember chats was turned off from elsewhere", async () => {
		await act(async () => {
			(rememberSwitch() as HTMLElement).click();
		});
		await waitFor(
			() => rememberSwitch()?.getAttribute("aria-checked") === "true"
		);
		// Another window or client turns it off; this one hears nothing.
		node.chatMemory = "false";

		await act(async () => {
			button("Run Dream now")?.click();
		});
		await waitFor(() => prompt() !== null);
		expect(node.runs).toBe(1);
		expect(prompt()?.textContent).toContain("Dream needs Remember chats");
		expect(rememberSwitch()?.getAttribute("aria-checked")).toBe("false");
		// Only the switch click above wrote the setting.
		expect(node.writes).toEqual(["true"]);
	});

	it("drops the prompt once the switch turns Remember chats on", async () => {
		await act(async () => {
			button("Run Dream now")?.click();
		});
		await waitFor(() => prompt() !== null);

		await act(async () => {
			(rememberSwitch() as HTMLElement).click();
		});
		await waitFor(() => prompt() === null);
		expect(prompt()).toBe(null);
		expect(node.writes).toEqual(["true"]);
	});
});

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

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
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { setFriendlyMode } = await import("@/src/hooks/useFriendlyMode.ts");
const { MemoryDreamReview } = await import("./MemoryDreamReview.tsx");

const JA: Record<string, string> = {
	"About me": "私について",
	"Just me": "自分だけ",
	"User fact": "ユーザーの事実",
	User: "ユーザー",
};

// Core's Dream review: one pending proposal carrying raw category/scope ids.
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
					proposals: [
						{
							id: "proposal-1",
							proposed: {
								category: "user_fact",
								content: "Prefers metric units.",
								id: "memory-1",
								importance: 3,
								scope: "user",
								tags: [],
							},
							status: "pending",
						},
					],
					summary: null,
				},
			});
		}
		return new NativeResponse("not found", { status: 404 });
	},
});

afterAll(() => {
	core.stop(true);
});

let container: HTMLDivElement;
let unmount: () => Promise<void>;

beforeEach(() => {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
});

afterEach(async () => {
	await unmount();
	container.remove();
	registerLiteralCatalogLoader(null);
	setFriendlyMode(true);
});

async function mountInJapanese(): Promise<void> {
	container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	unmount = () => act(async () => root.unmount());
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="ja"
				initialPackId={null}
				manageDocument={false}
			>
				<MemoryDreamReview target={{ token: null, url: core.url.origin }} />
			</I18nProvider>
		);
	});
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (container.querySelector('[data-testid="dream-proposal"]')) {
			break;
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
	}
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
}

test("a proposal shows its category and scope as translated friendly labels", async () => {
	setFriendlyMode(true);
	await mountInJapanese();
	const text = container.textContent ?? "";
	expect(text).toContain("私について");
	expect(text).toContain("自分だけ");
	expect(text).not.toContain("user fact");
	expect(text).not.toContain("user_fact");
});

test("a proposal shows the technical labels translated when friendly names are off", async () => {
	setFriendlyMode(false);
	await mountInJapanese();
	const text = container.textContent ?? "";
	expect(text).toContain("ユーザーの事実");
	expect(text).toContain("ユーザー");
	expect(text).not.toContain("user fact");
});

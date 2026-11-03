import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// The page's network and native seams are stand-ins; the queue is a two-button
// stub so the test can type a handle and press Reserve. The page's own
// reservation flow and its success toast are the shipping ones.
mock.module("@/lib/auth-client.ts", () => ({
	authClient: {
		isUsernameAvailable: async () => ({ data: { available: true } }),
		updateUser: async () => ({ error: null }),
	},
	clearSessionToken: async () => undefined,
	FRONTEND_URL: "https://ryu.test",
	signOut: async () => undefined,
}));
mock.module("@/lib/tauri-bridge.ts", () => ({ openExternal: () => undefined }));
mock.module("@/src/lib/api/waitlist.ts", () => ({
	fetchWaitlistMe: async () => null,
	// biome-ignore lint/correctness/useYield: an empty stream that never emits.
	async *openWaitlistStream() {
		await new Promise(() => undefined);
	},
	releaseWaitlistUsername: async () => undefined,
}));
mock.module("@ryu/blocks/web/waitlist-share-dialog.tsx", () => ({
	WaitlistShareDialog: () => null,
}));
mock.module("@ryu/ui/components/waitlist-queue.tsx", () => ({
	WaitlistQueue: ({
		onChangeHandle,
		onReserve,
	}: {
		onChangeHandle: (next: string) => void;
		onReserve: () => void;
	}) => (
		<div>
			<button onClick={() => onChangeHandle("ryu_fan")} type="button">
				type
			</button>
			<button onClick={onReserve} type="button">
				reserve
			</button>
		</div>
	),
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { sileo } = await import("sileo");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { default: WaitlistPage } = await import("./WaitlistPage.tsx");

const roots: Root[] = [];

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	registerLiteralCatalogLoader(null);
});

test("confirms a reserved handle with one German message", async () => {
	const successTitles: string[] = [];
	spyOn(sileo, "success").mockImplementation((options) => {
		successTitles.push(String(options.title));
		return "toast";
	});
	const german: Record<string, string> = {
		"@{handle} is reserved": "@{handle} ist reserviert",
	};
	registerLiteralCatalogLoader((locale) =>
		locale.startsWith("de") ? german : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="de"
				initialPackId={null}
			>
				<WaitlistPage userName="Ryu" />
			</I18nProvider>
		);
	});
	await act(async () => {
		await Bun.sleep(50);
	});
	const [typeButton, reserveButton] = container.querySelectorAll("button");
	await act(async () => {
		typeButton?.click();
	});
	await act(async () => {
		reserveButton?.click();
		await Bun.sleep(20);
	});
	expect(successTitles).toEqual(["@ryu_fan ist reserviert"]);
});

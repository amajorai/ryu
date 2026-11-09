import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { ChatSearchBar } = await import("./ChatSearchBar.tsx");

// The match counter is one whole message, so Japanese word order applies
// instead of an English "of" between the two numbers.
const JA: Record<string, string> = {
	"{current} of {total}": "{total} 件中 {current} 件",
	"No project folder": "プロジェクトフォルダーがありません",
	"Search messages": "メッセージを検索",
};

afterEach(() => {
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

test("the chat match counter reads in the UI language", async () => {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const match = {
		anchorMessageId: "m",
		content: "atlas",
		messageId: "m",
		role: "user",
	};
	await act(async () => {
		root.render(
			<I18nProvider initialLocale="ja" initialPackId={null}>
				<ChatSearchBar
					activeMatchIndex={1}
					folderAvailable={false}
					matches={[match, match, match]}
					mode="chat"
					onClose={() => undefined}
					onModeChange={() => undefined}
					onNextMatch={() => undefined}
					onPreviousMatch={() => undefined}
					onQueryChange={() => undefined}
					query="atlas"
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	const status = container.querySelector('[data-testid="chat-search-status"]');
	expect(status?.textContent).toBe("3 件中 2 件");
	await act(async () => root.unmount());
	container.remove();
});

test("the idle status hint reads in the UI language", async () => {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	const container = document.createElement("div");
	// Only the bar's own translation counts, not the DOM localizer's pass.
	container.setAttribute("data-ryu-i18n", "off");
	document.body.append(container);
	const root = createRoot(container);
	const render = (mode: "chat" | "files") =>
		root.render(
			<I18nProvider initialLocale="ja" initialPackId={null}>
				<ChatSearchBar
					activeMatchIndex={0}
					folderAvailable={false}
					matches={[]}
					mode={mode}
					onClose={() => undefined}
					onModeChange={() => undefined}
					onNextMatch={() => undefined}
					onPreviousMatch={() => undefined}
					onQueryChange={() => undefined}
					query=""
				/>
			</I18nProvider>
		);
	await act(async () => render("chat"));
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	await act(async () => render("chat"));
	const status = () =>
		container.querySelector('[data-testid="chat-search-status"]')?.textContent;
	expect(status()).toBe("メッセージを検索");
	await act(async () => render("files"));
	expect(status()).toBe("プロジェクトフォルダーがありません");
	await act(async () => root.unmount());
	container.remove();
});

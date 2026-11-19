import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ApiTarget } from "@/src/lib/api/client.ts";

// The Clips recorder captures the screen: its start and stop buttons read in
// the video sense (ja 録画), while the bare "Start recording" and "Stop
// recording" are audio recording (ja 録音) for the voice and dictation inputs.

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const node: ApiTarget = { url: "https://node.test", token: "token" };
mock.module("@/lib/auth-client.ts", () => ({
	TOKEN_KEY: "ryu_session_token",
	getActiveToken: () => null,
}));
mock.module("@/src/lib/realtime/jwt.ts", () => ({
	getRealtimeJwt: () => null,
}));
mock.module("@/src/store/useNodeStore.ts", () => ({
	useNodeStore: <TResult,>(
		select: (state: { getActiveNode: () => ApiTarget }) => TResult
	) => select({ getActiveNode: () => node }),
}));
const { I18nProvider } = await import("@ryu/i18n/react");
const { RecordingControls } = await import("./RecordingControls.tsx");
const { useClipStore, recordingScope } = await import(
	"@/src/store/useClipStore.ts"
);
const { toTarget } = await import("@/src/lib/api/client.ts");

const mounted: { container: HTMLDivElement; unmount: () => void }[] = [];
afterEach(async () => {
	for (const { container, unmount } of mounted.splice(0)) {
		await act(async () => unmount());
		container.remove();
	}
	useClipStore.getState().resetRecording();
});

async function renderJapanese(): Promise<HTMLDivElement> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted.push({ container, unmount: () => root.unmount() });
	await act(async () =>
		root.render(
			createElement(I18nProvider, {
				autoLocalizeDom: false,
				children: createElement(RecordingControls, {
					onClipReady: () => undefined,
				}),
				initialLocale: "ja",
				initialPackId: "official/ja",
				manageDocument: false,
			})
		)
	);
	return container;
}

test("the idle recorder offers to start a screen recording", async () => {
	const container = await renderJapanese();
	const titles = [...container.querySelectorAll("button")].map((button) =>
		button.getAttribute("title")
	);
	expect(titles).toContain("録画を開始");
});

test("a running recording offers to stop the screen recording", async () => {
	useClipStore.setState({
		sessionScope: recordingScope(toTarget(node)),
		status: "recording",
	});
	const container = await renderJapanese();
	const labels = [...container.querySelectorAll("button")].map((button) =>
		button.getAttribute("aria-label")
	);
	expect(labels).toContain("録画を停止");
});

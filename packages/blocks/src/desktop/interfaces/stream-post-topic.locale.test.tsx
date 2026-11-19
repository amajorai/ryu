import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import type { StreamPost } from "./stream-model.ts";

// A post filed under a topic tells screen readers "in {topic}" as one
// sentence. The old lone sr-only "in" matched a catalog fragment that some
// locales translate as an environment label (ja "· 環境:").

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { StreamPostItem } = await import("./stream-post.tsx");

const OVERLAYS = {
	ja: { in: "· 環境:", "in {topic}": "トピック {topic} 内" },
};

const POST: StreamPost = {
	author: undefined,
	body: "Ship the release notes.",
	bodyRole: "user",
	faces: [],
	participants: [],
	pinned: false,
	replyCount: 0,
	runState: null,
	status: "quiet",
	threadId: "thread-1",
	title: "Release notes",
	topic: "Design Review",
	updatedAt: "2026-11-01T10:00:00.000Z",
};

let mounted: { container: HTMLElement; root: Root } | undefined;
afterEach(async () => {
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => root.unmount());
		container.remove();
		mounted = undefined;
	}
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

test("the topic reads as one Japanese sentence for screen readers", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="ja"
				initialPackId={null}
				manageDocument={false}
				overlays={OVERLAYS}
			>
				<StreamPostItem
					actions={{
						onNewThread: () => undefined,
						onOpen: () => undefined,
						onProfile: () => undefined,
					}}
					post={POST}
				/>
			</I18nProvider>
		);
	});
	const spoken = [...container.querySelectorAll(".sr-only")].map(
		(node) => node.textContent
	);
	expect(spoken).toContain("トピック Design Review 内");
	expect(spoken).not.toContain("· 環境:");
});

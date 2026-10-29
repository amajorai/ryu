import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { CommandAction } from "@ryu/command/types";
import type { ApiTarget } from "@/src/lib/api/client.ts";

if (!("document" in globalThis)) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
type Children = import("react").ReactNode;
let node: ApiTarget = {
	url: "https://old-node.test",
	token: "node-token",
	userJwt: "old-delegation",
};
const openTab = mock(
	<TOptions,>(_path: string, _options: TOptions) => undefined
);
const requestScrollToMessage = mock(
	(_conversation: string, _message: string) => undefined
);
const setActiveConversationId = mock((_id: string | null) => undefined);
mock.module("@/lib/auth-client.ts", () => ({
	BACKEND_URL: "http://backend.test",
	FRONTEND_URL: "http://frontend.test",
	getActiveUserId: () => null,
	TOKEN_KEY: "ryu_session_token",
	getActiveToken: () =>
		globalThis.localStorage?.getItem("ryu_session_token") ?? null,
}));
mock.module("@/src/lib/realtime/jwt.ts", () => ({
	getRealtimeJwt: () => null,
}));
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => node,
}));
mock.module("@/src/contexts/TabsContext.tsx", () => ({
	useTabSelector: <TResult,>(
		select: (state: {
			openTab: typeof openTab;
			requestScrollToMessage: typeof requestScrollToMessage;
		}) => TResult
	) => select({ openTab, requestScrollToMessage }),
}));
mock.module("@/src/contexts/ChatHistoryContext.tsx", () => ({
	useChatHistoryContext: () => ({ setActiveConversationId }),
}));
mock.module("@/contexts/auth-context.tsx", () => ({
	useAuthContext: () => ({
		handleSignOut: () => undefined,
		isSigningOut: false,
	}),
}));
mock.module("next-themes", () => ({
	useTheme: () => ({ theme: "system", setTheme: () => undefined }),
}));
mock.module("@ryu/hotkeys/react", () => ({ useHotkey: () => undefined }));
mock.module("@/src/hooks/useCommandSearchSections.ts", () => ({
	useCommandSearchSections: () => ({ agents: [], sections: [] }),
}));
mock.module("@/src/hooks/usePluginContributions.ts", () => ({
	usePluginContributions: () => ({
		slash_commands: [],
		sidebar_buttons: [],
		sidebar_sections: [],
	}),
}));
mock.module("@/src/hooks/useContributedCommands.ts", () => ({
	useContributedSectionItems: () => [],
}));
mock.module("@/src/contributions/use-companion-alias.ts", () => ({
	useCompanionAlias: () => null,
}));
mock.module("@/src/contributions/registry.ts", () => ({
	contributionRegistry: { listCommands: () => [] },
}));
mock.module("@/src/lib/tauri-ready.ts", () => ({
	listenWhenReady: () => Promise.resolve(() => undefined),
}));
mock.module("@/src/lib/api/shadow.ts", () => ({
	searchShadow: () => Promise.resolve([]),
}));
mock.module("@/src/lib/api/spaces.ts", () => ({
	searchSpaceDocuments: () => Promise.resolve([]),
}));
mock.module("@/src/lib/api/marketplace.ts", () => ({
	searchMarketplaceCatalog: () => Promise.resolve([]),
	formatPricingLabel: () => "",
}));
mock.module("@/src/lib/api/memory.ts", () => ({
	createMemory: () => Promise.resolve(),
}));
mock.module("@/src/lib/api/plugins.ts", () => ({
	fireActivationEvent: () => Promise.resolve(),
}));
mock.module("@/src/lib/route-prefetch.ts", () => ({
	prefetchRoute: () => undefined,
}));
mock.module("@/src/lib/fullscreen.ts", () => ({
	toggleFullscreen: () => Promise.resolve(),
}));
mock.module("@/src/components/chat/ImportSetupDialog.tsx", () => ({
	ImportSetupDialog: () => null,
}));
mock.module("@/src/components/chat/ImportThreadsDialog.tsx", () => ({
	ImportThreadsDialog: () => null,
}));
mock.module("@/src/components/settings/LazySettingsDialog.tsx", () => ({
	SettingsDialog: () => null,
}));
// Only presentation and unrelated provider lanes are replaced. The production
// CommandPalette owns query state, debounce, result publication and handoffs;
// searchConversations and its authenticated HTTP client remain real.
mock.module("@ryu/command/CommandPalette", () => ({
	CommandPalette: ({
		open,
		search,
		onSearchChange,
		actions,
		composeContent,
	}: {
		open: boolean;
		search: string;
		onSearchChange: (value: string) => void;
		actions: CommandAction[];
		composeContent: Children;
	}) =>
		open
			? createElement(
					"div",
					null,
					createElement("input", {
						"aria-label": "Search",
						value: search,
						onInput: (event: import("react").FormEvent<HTMLInputElement>) =>
							onSearchChange(event.currentTarget.value),
					}),
					...actions
						.filter((action) => action.resultType === "messages")
						.map((action) =>
							createElement(
								"button",
								{ key: action.id, onClick: action.onSelect },
								action.title
							)
						),
					composeContent
				)
			: null,
}));
mock.module("@ryu/blocks/desktop/agent-elements/input-bar", () => ({
	InputBar: ({
		value,
		onChange,
		onSend,
	}: {
		value: string;
		onChange: (value: string) => void;
		onSend: (value: { content: string }) => void;
	}) =>
		createElement(
			"div",
			null,
			createElement("input", {
				"aria-label": "Compose",
				value,
				onInput: (event: import("react").FormEvent<HTMLInputElement>) =>
					onChange(event.currentTarget.value),
			}),
			createElement(
				"button",
				{ onClick: () => onSend({ content: value }) },
				"Send draft"
			)
		),
}));
const { CommandPalette } = await import("./CommandPalette.tsx");
const originalFetch = globalThis.fetch;
const reads: Array<{
	url: string;
	init?: RequestInit;
	finish: <TBody>(body: TBody) => void;
}> = [];
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
async function render() {
	await act(async () => root.render(createElement(CommandPalette)));
}
async function input(label: string, value: string) {
	const field = container.querySelector<HTMLInputElement>(
		`input[aria-label="${label}"]`
	);
	if (!field) {
		throw new Error(`Missing ${label} input`);
	}
	await act(async () => {
		field.value = value;
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
async function debounce() {
	await act(async () => {
		await Bun.sleep(300);
	});
}
async function finish(index: number, content: string, conversation: string) {
	await act(async () => {
		reads[index].finish({
			indexed: true,
			hits: [
				{
					content,
					conversation_id: conversation,
					message_id: `${conversation}-message`,
					role: "user",
					created_at: Date.now(),
					score: 1,
				},
			],
		});
	});
}
beforeEach(async () => {
	node = {
		url: "https://old-node.test",
		token: "node-token",
		userJwt: "old-delegation",
	};
	reads.length = 0;
	openTab.mockClear();
	requestScrollToMessage.mockClear();
	setActiveConversationId.mockClear();
	globalThis.fetch = Object.assign(
		mock((url: RequestInfo | URL, init?: RequestInit) => {
			if (!String(url).includes("/api/conversations/search?")) {
				throw new Error(`Unexpected HTTP request: ${url}`);
			}
			// The response has arrived, but decoding is pending. Aborting transport
			// cannot undo work after this boundary; caller identity must guard publish.
			const response = Response.json({});
			const body = new Promise<unknown>((resolve) =>
				reads.push({ url: String(url), init, finish: resolve })
			);
			response.text = async () => JSON.stringify(await body);
			return Promise.resolve(response);
		}),
		{ preconnect: originalFetch.preconnect }
	);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await render();
	await act(async () => {
		window.dispatchEvent(new Event("ryu:open-command-palette"));
	});
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	globalThis.fetch = originalFetch;
});

for (const change of ["node", "delegation"] as const) {
	test(`message search discards late previous ${change} result and opens only the current conversation`, async () => {
		await input("Search", "private notes");
		await debounce();
		expect(reads).toHaveLength(1);
		node =
			change === "node"
				? {
						...node,
						url: "https://new-node.test",
						token: "new-token",
						userJwt: "new-delegation",
					}
				: { ...node, userJwt: "new-delegation" };
		await render();
		await debounce();
		expect(reads).toHaveLength(2);
		expect(reads[0].init?.signal?.aborted).toBe(true);
		expect(new URL(reads[1].url).origin).toBe(node.url);
		expect(new URL(reads[1].url).searchParams.get("q")).toBe("private notes");
		expect(new Headers(reads[1].init?.headers).get("x-ryu-user-jwt")).toBe(
			"new-delegation"
		);
		await finish(1, "Current private notes", "current-conversation");
		await finish(0, "Previous private notes", "previous-conversation");
		expect(container.textContent).toContain("Current private notes");
		expect(container.textContent).not.toContain("Previous private notes");
		const result = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent === "Current private notes"
		);
		if (!result) {
			throw new Error("Current result missing");
		}
		await act(async () => result.click());
		expect(openTab.mock.calls).toEqual([
			["/chat", { conversationId: "current-conversation" }],
		]);
		expect(setActiveConversationId.mock.calls).toEqual([
			["current-conversation"],
		]);
		expect(requestScrollToMessage.mock.calls).toEqual([
			["current-conversation", "current-conversation-message"],
		]);
	});
}

test("compose sends the exact draft once to a fresh chat and clears it before reopening", async () => {
	await input("Compose", "  Review these notes with me  ");
	const send = Array.from(container.querySelectorAll("button")).find(
		(button) => button.textContent === "Send draft"
	);
	if (!send) {
		throw new Error("Compose send missing");
	}
	await act(async () => send.click());
	expect(openTab.mock.calls).toEqual([
		[
			"/chat",
			{
				forceNew: true,
				initialPrompt: "Review these notes with me",
				initialSubmit: true,
				initialImages: undefined,
			},
		],
	]);
	expect(setActiveConversationId.mock.calls).toEqual([[null]]);
	await act(async () => {
		window.dispatchEvent(new Event("ryu:open-command-palette"));
	});
	expect(
		container.querySelector<HTMLInputElement>('input[aria-label="Compose"]')
			?.value
	).toBe("");
	expect(reads).toHaveLength(0);
});

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const target: ApiTarget = {
	url: "https://paid-key-notice.fixture",
	token: "notice-token",
	userJwt: null,
};
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => target,
}));
const { createRoot } = await import("react-dom/client");
const { sileo } = await import("sileo");
const { usePaidKeyNotice } = await import("./usePaidKeyNotice.ts");

const SETTINGS_PATH = "/api/pi-config/providers/claude-pro-max/credentials";
const originalFetch = globalThis.fetch;
const originalWarning = sileo.warning;
const roots: Root[] = [];
const client = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

/** What the user was shown: one entry per warning toast. */
let shown: { description: unknown; title: unknown }[];
let calls: string[];
/** Whether the user turned the fallback on. */
let fallbackOn: boolean;
/** Conversations a paid key served and Core has not told about yet. */
let waiting: Map<string, string>;

beforeEach(() => {
	shown = [];
	calls = [];
	fallbackOn = true;
	waiting = new Map();
	client.clear();
	sileo.warning = (options) => {
		shown.push({ title: options.title, description: options.description });
		return "toast";
	};
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const path = new URL(String(input)).pathname;
			calls.push(`${init?.method ?? "GET"} ${path}`);
			if (path === SETTINGS_PATH) {
				return Response.json({
					providerId: "claude-pro-max",
					credentials: [],
					apiKeyFallback: {
						supported: true,
						enabled: fallbackOn,
						keyProviderId: "anthropic",
						keys: [],
					},
				});
			}
			const conversation =
				/^\/api\/conversations\/([^/]+)\/paid-key-notice$/.exec(path)?.[1];
			if (!conversation) {
				return new Response("not found", { status: 404 });
			}
			// Core hands a notice out once.
			const label = waiting.get(conversation);
			waiting.delete(conversation);
			return Response.json({
				notice: label
					? {
							providerId: "claude-pro-max",
							keyProviderId: "anthropic",
							accountId: "key-work",
							label,
						}
					: null,
			});
		},
		{ preconnect: originalFetch.preconnect }
	);
});

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	client.clear();
	document.body.replaceChildren();
	globalThis.fetch = originalFetch;
	sileo.warning = originalWarning;
});

function Probe({
	active,
	conversationId,
}: {
	active: boolean;
	conversationId: string | null;
}) {
	usePaidKeyNotice(conversationId, active);
	return null;
}
const view = (conversationId: string | null, active = true) => (
	<QueryClientProvider client={client}>
		<Probe active={active} conversationId={conversationId} />
	</QueryClientProvider>
);
async function settle() {
	// Two reads follow each other: the setting, then the notice.
	for (let round = 0; round < 3; round += 1) {
		await act(async () => {
			await Bun.sleep(20);
		});
	}
}
async function mount(conversationId: string | null, active = true) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () => root.render(view(conversationId, active)));
	await settle();
	return root;
}
const noticeCalls = () =>
	calls.filter((call) => call.endsWith("/paid-key-notice"));

test("while the fallback is off, no notice is asked for and nothing is shown", async () => {
	fallbackOn = false;
	waiting.set("conversation-a", "Work");
	await mount("conversation-a");
	expect(calls).toEqual([`GET ${SETTINGS_PATH}`]);
	expect(shown).toEqual([]);
});

test("a conversation a paid key now serves is told once, naming the key by label", async () => {
	waiting.set("conversation-a", "Work");
	const root = await mount("conversation-a");
	expect(noticeCalls()).toEqual([
		"POST /api/conversations/conversation-a/paid-key-notice",
	]);
	expect(shown).toEqual([
		{
			title: "A paid API key is now in use",
			description:
				"Your subscription accounts ran out, so this conversation now uses the API key Work. API keys are billed per request.",
		},
	]);
	// Rendering again, also after leaving and coming back, tells nothing new.
	await act(async () => root.render(view("conversation-a")));
	await settle();
	await act(async () => root.render(view(null)));
	await act(async () => root.render(view("conversation-a")));
	await settle();
	expect(shown).toHaveLength(1);
});

test("each conversation gets its own notice, and one with nothing waiting gets none", async () => {
	waiting.set("conversation-a", "Work");
	waiting.set("conversation-b", "Spare");
	const root = await mount("conversation-a");
	await act(async () => root.render(view("conversation-quiet")));
	await settle();
	await act(async () => root.render(view("conversation-b")));
	await settle();
	expect(shown.map((toast) => toast.description)).toEqual([
		"Your subscription accounts ran out, so this conversation now uses the API key Work. API keys are billed per request.",
		"Your subscription accounts ran out, so this conversation now uses the API key Spare. API keys are billed per request.",
	]);
});

test("a background tab and a page with no conversation ask nothing", async () => {
	waiting.set("conversation-a", "Work");
	await mount("conversation-a", false);
	await mount(null);
	expect(calls).toEqual([]);
	expect(shown).toEqual([]);
	// The notice is still there for the tab that shows the conversation.
	expect(waiting.get("conversation-a")).toBe("Work");
});

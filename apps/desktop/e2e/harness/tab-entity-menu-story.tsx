declare const window: Window;

import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
// Standalone browser story for the REAL `TabEntityMenuSection` — the entity half
// of a tab's right-click menu, rendered inside a real `ContextMenu` exactly the
// way `TitleBar`'s tab pills and the sidebar's vertical tab rows render it.
//
// What it certifies, none of which a type-check can see:
//   • the section is ANCHOR-scoped: a chat tab shows the app row declared for
//     `anchor: "conversation"` and never the one declared for `"space"`, and the
//     reverse for a space tab. Both rows come from one contributions payload, so
//     an anchor filter that silently passed everything would look identical in
//     the source and obvious here;
//   • nothing app-specific is hardcoded — both rows arrive over
//     `GET /api/plugins/contributions` and are rendered by label alone;
//   • the shell built-ins are LIVE, not labels: clicking "Pin chat" flips it to
//     "Unpin chat" through the shared conversation-flags store;
//   • a contributed row dispatches through the plugin host seam with the id keyed
//     BY ANCHOR (`conversation_id` vs `space_id`) — the failure mode that made
//     this worth a browser test, since handing a space capability a
//     `conversation_id` is a silent no-op, not an error.
//
// Stubs are the two seams a menu cannot supply itself: `fetch` (no Core here)
// and nothing else. The section, the menu, the store and the dispatch path are
// all the shipping code.

import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { TabEntityMenuSection } from "../../src/components/layout/tab-entity-menu.tsx";
import { ChatHistoryProvider } from "../../src/contexts/ChatHistoryContext.tsx";
import type { Tab } from "../../src/contexts/TabsContext.tsx";
import "../../src/index.css";

/** Two apps, two anchors, one payload — the whole point of the anchor filter. */
const CONTRIBUTIONS = {
	context_menu_items: [
		{
			id: "make-skill",
			plugin: "@ryu/learning",
			anchor: "conversation",
			label: "Make a skill from this chat",
			capability: "skill.create",
			order: 1,
		},
		{
			id: "publish",
			plugin: "@example/publisher",
			anchor: "space",
			label: "Publish this space",
			capability: "space.publish",
			order: 1,
		},
	],
};

// The packaging proof serves a real SDK-produced bundle projected through the
// same plugin ownership field as Core. Other menu stories keep their fixtures.
if (new URLSearchParams(location.search).has("packed")) {
	const response = await fetch("/__packed-chat-title");
	if (!response.ok) {
		throw new Error("Packed contribution fixture is unavailable");
	}
	Object.assign(CONTRIBUTIONS, await response.json());
}

const CHAT_TAB: Tab = {
	id: "tab-chat",
	path: "/chat",
	conversationId: "conv-1",
	title: "Fix the flaky auth test",
};

const SPACE_TAB: Tab = {
	id: "tab-space",
	path: "/spaces/space-1",
	title: "Design notes",
};

const SETTINGS_TAB: Tab = {
	id: "tab-settings",
	path: "/settings",
	title: "Settings",
};

/** Record the plugin-host dispatch so the spec can read the anchor-keyed args. */
function recordDispatch(pluginId: string, body: string) {
	const out = document.getElementById("dispatched");
	if (out) {
		out.textContent = `${pluginId} :: ${body}`;
	}
}

// Stand in for Core: serve the contributions payload, accept a host dispatch,
// and answer the conversation list `ChatHistoryProvider` asks for on mount.
const realFetch = window.fetch.bind(globalThis);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = input instanceof Request ? input.url : String(input);
	const json = <FixturePayload,>(value: FixturePayload) =>
		new Response(JSON.stringify(value), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	if (url.includes("/api/plugins/contributions")) {
		return json(CONTRIBUTIONS);
	}
	const host = url.match(/\/api\/plugins\/(.+)\/host$/);
	if (host) {
		recordDispatch(
			decodeURIComponent(host[1]),
			isNativeText(init?.body) ? init.body : ""
		);
		return json({ ok: true });
	}
	if (url.includes("/api/conversations")) {
		return json({ conversations: [] });
	}
	return realFetch(input, init);
};

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

/** One tab pill carrying the same menu shape a real pill has: tab verbs, then
    the entity section, then the rest. The leading "Pin tab" is deliberate — it
    is what "Pin chat" must stay distinguishable from. */
function TabPill({ label, tab }: { label: string; tab: Tab }) {
	return (
		<ContextMenu>
			<ContextMenuTrigger
				render={
					<button
						className="rounded-full bg-muted px-4 py-2 text-sm"
						data-testid={`pill-${tab.id}`}
						type="button"
					>
						{label}
					</button>
				}
			/>
			<ContextMenuContent>
				<ContextMenuItem>Pin tab</ContextMenuItem>
				<TabEntityMenuSection tab={tab} />
				<ContextMenuSeparator />
				<ContextMenuItem>Close tab</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

function Story() {
	return (
		<QueryClientProvider client={queryClient}>
			<ChatHistoryProvider>
				<div className="flex min-h-screen flex-col items-start gap-6 bg-background p-10">
					<TabPill label="Chat tab" tab={CHAT_TAB} />
					<TabPill label="Space tab" tab={SPACE_TAB} />
					{/* No entity — the section must render NOTHING, not a stray
					    separator between "Pin tab" and "Close tab". */}
					<TabPill label="Settings tab" tab={SETTINGS_TAB} />
					<pre data-testid="dispatched" id="dispatched" />
				</div>
				<Toaster position="bottom-right" />
			</ChatHistoryProvider>
		</QueryClientProvider>
	);
}

const container = document.getElementById("root");
if (container) {
	const root = createRoot(container);
	root.render(<Story />);
	import.meta.hot?.dispose(() => {
		root.unmount();
		queryClient.clear();
		window.fetch = realFetch;
	});
}

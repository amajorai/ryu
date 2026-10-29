import { afterAll, beforeEach, expect, test } from "bun:test";
import type { PluginDockPanel } from "@/src/lib/api/plugins.ts";
import {
	CONTRIBUTED_LINK_OPENED_EVENT,
	openContributedLink,
} from "./contributed-link-handler.ts";

// `openContributedLink` dispatches on `window`; a bare EventTarget is enough.
if (typeof globalThis.window === "undefined") {
	Reflect.set(globalThis, "window", new EventTarget());
}

interface Call {
	body: unknown;
	method: string;
	path: string;
	token: string | null;
}
const calls: Call[] = [];
const opened: unknown[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const text = await request.text();
		calls.push({
			body: text ? JSON.parse(text) : null,
			method: request.method,
			path: new URL(request.url).pathname,
			token: request.headers.get("authorization"),
		});
		return Response.json({ ok: true });
	},
});
const onOpened = (event: Event) => {
	opened.push(event instanceof CustomEvent ? event.detail : null);
};
window.addEventListener(CONTRIBUTED_LINK_OPENED_EVENT, onOpened);
afterAll(() => {
	window.removeEventListener(CONTRIBUTED_LINK_OPENED_EVENT, onOpened);
	server.stop(true);
});
const target = { url: server.url.toString(), token: "node-token" };
beforeEach(() => {
	calls.length = 0;
	opened.length = 0;
});

function panel(
	plugin: string,
	linkHandler: Record<string, unknown>,
	id = "viewer"
): PluginDockPanel {
	return {
		id,
		panel: "companion",
		placement: "right",
		plugin,
		spec: { linkHandler },
		title: `${plugin} viewer`,
	};
}

test("a handler path outside the panel's own ext mount is refused without any request", async () => {
	for (const path of [
		"/api/ext/@ryu/other/open",
		"/api/node/token/rotate",
		"/api/ext/@ryu/notes-evil/open",
		"/api/ext/@ryu/notes",
		// Dot segments pass a raw prefix check but fetch resolves them away.
		"/api/ext/@ryu/notes/../../../node/token/rotate",
		"/api/ext/@ryu/notes/%2e%2e/%2E%2E/%2e%2e/node/token/rotate",
		"/api/ext/@ryu/notes/./../other/open",
	]) {
		const result = await openContributedLink(
			target,
			[panel("@ryu/notes", { path, schemes: ["notes"] })],
			"notes://page/1"
		);
		expect(result).toBeNull();
	}
	expect(calls).toEqual([]);
	expect(opened).toEqual([]);
});

test("unparsable hrefs and unmatched schemes resolve to null without a request", async () => {
	const panels = [
		panel("@ryu/notes", {
			path: "/api/ext/@ryu/notes/open",
			schemes: ["notes"],
		}),
	];
	expect(await openContributedLink(target, panels, "not a url")).toBeNull();
	expect(await openContributedLink(target, panels, "")).toBeNull();
	expect(
		await openContributedLink(target, panels, "https://example.com/")
	).toBeNull();
	expect(
		await openContributedLink(target, panels, "notesx://page/1")
	).toBeNull();
	expect(calls).toEqual([]);
	expect(opened).toEqual([]);
});

test("a matching owned handler posts the URL, announces it and returns the panel tab", async () => {
	const panels = [
		panel("@ryu/other", { path: "/api/ext/@ryu/other/open", schemes: ["web"] }),
		panel("@ryu/notes", {
			path: "/api/ext/@ryu/notes/open",
			schemes: ["notes", "note"],
		}),
	];
	const result = await openContributedLink(target, panels, "note://page/1?x=1");
	expect(result).toEqual({
		kind: "plugin:@ryu/notes:viewer",
		label: "@ryu/notes viewer",
	});
	expect(calls).toEqual([
		{
			body: { url: "note://page/1?x=1" },
			method: "POST",
			path: "/api/ext/@ryu/notes/open",
			token: "Bearer node-token",
		},
	]);
	expect(opened).toEqual([{ plugin: "@ryu/notes", url: "note://page/1?x=1" }]);
});

test("the declared method and body key are honoured", async () => {
	const result = await openContributedLink(
		target,
		[
			panel(
				"@ryu/notes",
				{
					bodyKey: "href",
					method: "PUT",
					path: "/api/ext/@ryu/notes/links",
					schemes: ["notes"],
				},
				"links"
			),
		],
		"notes://a"
	);
	expect(result?.kind).toBe("plugin:@ryu/notes:links");
	expect(calls).toEqual([
		{
			body: { href: "notes://a" },
			method: "PUT",
			path: "/api/ext/@ryu/notes/links",
			token: "Bearer node-token",
		},
	]);
});

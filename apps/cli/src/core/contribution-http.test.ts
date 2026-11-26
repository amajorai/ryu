// The terminal's declarative HTTP gate (Security finding SA-10).
//
// A WHATWG URL parser drops every tab, line feed and carriage return and only
// then resolves dot segments, so a path that looks like it stays under an app's
// own mount can be sent to another Core route. Nothing here makes a request. The
// address in the parser test is only text.

import { expect, test } from "bun:test";
import {
	viewActionRequest,
	viewHostDispatchRequest,
	viewSourceRequest,
} from "./contribution-http.ts";
import { contributedViewsFromResponse } from "./contributions.ts";

const OWNER = "com.example.app";
const community = { plugin: OWNER, httpPolicy: "owner" } as const;
const firstParty = { plugin: "@ryu/meetings", httpPolicy: "core" } as const;
const SEPARATORS = ["\t", "\n", "\r"];

/** Looks like a path under the owner's mount. A parser sends it elsewhere. */
function smuggled(separator: string): string {
	return `/api/ext/${OWNER}/.${separator}./.${separator}./conversations?preview=1`;
}

test("a URL parser sends the smuggled path to another route", () => {
	for (const separator of SEPARATORS) {
		const url = new URL(`http://127.0.0.1:7980${smuggled(separator)}`);
		expect(url.pathname).toBe("/api/conversations");
	}
});

test("a view source with a tab, line feed or carriage return in its path is refused", () => {
	for (const separator of SEPARATORS) {
		const source = { http: { path: smuggled(separator) } };
		expect(viewSourceRequest(community, source)).toBeNull();
		// A view Core did not stamp is treated as a Community view.
		expect(viewSourceRequest({ plugin: OWNER }, source)).toBeNull();
	}
});

test("an action with a tab, line feed or carriage return in its path is refused", () => {
	for (const separator of SEPARATORS) {
		expect(() =>
			viewActionRequest(
				community,
				{ method: "DELETE", path: smuggled(separator), body: { all: true } },
				{}
			)
		).toThrow();
	}
});

test("a Community view reaches its own mount and nothing else", () => {
	const owned = `/api/ext/${OWNER}/items?window=today`;
	expect(viewSourceRequest(community, { http: { path: owned } })).toEqual({
		method: "GET",
		path: owned,
	});
	for (const path of [
		"/api/conversations",
		"/api/ext/other.app/items",
		`/api/ext/${OWNER}.other/items`,
		`/api/ext/${OWNER}/../other.app/items`,
		`/api/ext/${OWNER}/%2e%2e/other.app/items`,
		`https://evil.example/api/ext/${OWNER}/items`,
	]) {
		expect(viewSourceRequest(community, { http: { path } })).toBeNull();
		expect(() =>
			viewActionRequest(community, { method: "POST", path }, {})
		).toThrow();
	}
	expect(
		viewSourceRequest({ plugin: "" }, { http: { path: "/api/ext//items" } })
	).toBeNull();
	expect(viewSourceRequest(community, undefined)).toBeNull();
});

test("a substituted value stays one path segment", () => {
	const http = {
		method: "POST" as const,
		path: `/api/ext/${OWNER}/items/{{item.id}}/done`,
		body: { note: "{{name}}" },
	};
	expect(
		viewActionRequest(community, http, {
			item: { id: "a/b" },
			values: { name: "Ada" },
		})
	).toEqual({
		method: "POST",
		path: `/api/ext/${OWNER}/items/a%2Fb/done`,
		body: { note: "Ada" },
	});
	expect(() =>
		viewActionRequest(community, http, { item: { id: ".." } })
	).toThrow();
});

test("a first-party view keeps Core routes, without control characters", () => {
	expect(
		viewSourceRequest(firstParty, { http: { path: "/api/meetings" } })
	).toEqual({ method: "GET", path: "/api/meetings" });
	for (const separator of SEPARATORS) {
		const path = `/api/.${separator}./.${separator}./health`;
		expect(viewSourceRequest(firstParty, { http: { path } })).toBeNull();
		expect(() =>
			viewActionRequest(firstParty, { method: "POST", path }, {})
		).toThrow();
	}
});

test("only the policy Core stamped is kept, anything else falls back to the owner mount", () => {
	const views = contributedViewsFromResponse({
		views: [
			{ id: "a", plugin: OWNER, view: "list-detail", http_policy: "core" },
			{ id: "b", plugin: OWNER, view: "list-detail", http_policy: "owner" },
			{ id: "c", plugin: OWNER, view: "list-detail", http_policy: "root" },
			{ id: "d", plugin: OWNER, view: "list-detail" },
		],
	});
	expect(views.map((view) => view.httpPolicy)).toEqual([
		"core",
		"owner",
		undefined,
		undefined,
	]);
	const unstamped = { plugin: OWNER, httpPolicy: views[3]?.httpPolicy };
	expect(
		viewSourceRequest(unstamped, { http: { path: "/api/conversations" } })
	).toBeNull();
});

test("the host dispatch route is fixed and holds the plugin id as one segment", () => {
	expect(viewHostDispatchRequest({ plugin: "@acme/notes" }, { n: 1 })).toEqual({
		method: "POST",
		path: "/api/plugins/%40acme%2Fnotes/host",
		body: { method: "view.action", args: { n: 1 } },
	});
	expect(viewHostDispatchRequest({ plugin: "" }, {})).toBeNull();
	expect(viewHostDispatchRequest({ plugin: ".." }, {})).toBeNull();
});

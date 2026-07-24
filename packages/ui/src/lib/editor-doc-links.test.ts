// Unit tests for the swappable doc-link provider registry. The module holds a
// singleton (module-level state). Because `bun test src` runs every file in one
// process, each test resets the provider (`setDocLinkProvider(null)`) so the
// mutation never leaks to another file the glob loads.

import { afterEach, describe, expect, test } from "bun:test";
import {
	type DocLinkProvider,
	getDocLinkProvider,
	setDocLinkProvider,
} from "./editor-doc-links.ts";

afterEach(() => {
	setDocLinkProvider(null);
});

describe("doc-link provider registry", () => {
	test("defaults to a no-op provider (standalone editor)", async () => {
		const p = getDocLinkProvider();
		expect(await p.search("anything")).toEqual([]);
		expect(p.resolveByTitle("Home")).toBeNull();
		expect(await p.createPage("New")).toEqual({ id: "", title: "New" });
		// openDoc is a no-op and must not throw.
		expect(() => p.openDoc("x")).not.toThrow();
	});

	test("a registered host provider takes over", async () => {
		const host: DocLinkProvider = {
			search: (q) => Promise.resolve([{ id: "1", title: q }]),
			resolveByTitle: (title) => ({ id: "r", title }),
			createPage: (title) => Promise.resolve({ id: "c", title }),
			openDoc: () => undefined,
		};
		setDocLinkProvider(host);
		const p = getDocLinkProvider();
		expect(await p.search("q")).toEqual([{ id: "1", title: "q" }]);
		expect(p.resolveByTitle("T")).toEqual({ id: "r", title: "T" });
		expect(await p.createPage("N")).toEqual({ id: "c", title: "N" });
	});

	test("passing null resets back to the default no-op provider", async () => {
		setDocLinkProvider({
			search: () => Promise.resolve([{ id: "9", title: "x" }]),
			resolveByTitle: () => ({ id: "9", title: "x" }),
			createPage: (title) => Promise.resolve({ id: "9", title }),
			openDoc: () => undefined,
		});
		setDocLinkProvider(null);
		expect(getDocLinkProvider().resolveByTitle("x")).toBeNull();
		expect(await getDocLinkProvider().search("x")).toEqual([]);
	});
});

import { expect, test } from "bun:test";
import { parseTitlebarSession } from "./titlebar-fixture-contract.ts";

test("session decoder retains tab owner fields and nested split geometry", () => {
	const raw = JSON.stringify({
		activeIndex: 0,
		tabs: [
			{
				path: "/artifact/notes",
				title: "Notes",
				pinned: true,
				id: "tab-1",
				workspaceSession: { nodeName: "remote" },
			},
		],
		splits: [
			{
				o: "columns",
				s: [60, 40],
				c: [{ i: 0 }, { o: "rows", s: [50, 50], c: [{ i: 1 }, { i: 2 }] }],
			},
		],
	});
	const session = parseTitlebarSession(raw);
	expect(session).toEqual(JSON.parse(raw));
	expect(session?.splits?.[0]?.c?.[1]?.o).toBe("rows");
	expect(session?.tabs[0]?.pinned).toBe(true);
	expect(parseTitlebarSession(null)).toBeNull();
});

test("session decoder rejects malformed tab and recursive split fields", () => {
	expect(() =>
		parseTitlebarSession(
			'{"activeIndex":0,"tabs":[],"splits":[{"i":0,"c":["unchecked"]}]}'
		)
	).toThrow();
	expect(() =>
		parseTitlebarSession(
			'{"activeIndex":0,"tabs":[],"splits":[{"i":0,"o":"invalid"}]}'
		)
	).toThrow();
	expect(() =>
		parseTitlebarSession(
			'{"activeIndex":0,"tabs":[],"splits":[{"o":"rows","c":[]}]}'
		)
	).toThrow();
	expect(() =>
		parseTitlebarSession(
			'{"activeIndex":0,"tabs":[{"path":4,"title":"Notes"}]}'
		)
	).toThrow();
	expect(() =>
		parseTitlebarSession(
			'{"activeIndex":0,"tabs":[],"splits":[{"o":"rows","s":[50,50],"c":[{"i":"0"}]}]}'
		)
	).toThrow();
	expect(() =>
		parseTitlebarSession(
			'{"activeIndex":0,"tabs":[],"splits":[{"o":"invalid","s":[1],"c":[]}]}'
		)
	).toThrow();
	expect(() =>
		parseTitlebarSession(
			'{"activeIndex":0,"tabs":[],"splits":[{"o":"rows","s":["50"],"c":[]}]}'
		)
	).toThrow();
});

test("session decoder preserves original own JSON keys instead of normalized objects", () => {
	const raw =
		'{"activeIndex":0,"tabs":[{"path":"/artifact/notes","title":"Notes","__proto__":{"fixture":"retained"}}],"__proto__":{"owner":"retained"}}';
	const session = parseTitlebarSession(raw);
	expect(session).toEqual(JSON.parse(raw));
	expect(Object.hasOwn(session ?? {}, "__proto__")).toBe(true);
	expect(Object.hasOwn(session?.tabs[0] ?? {}, "__proto__")).toBe(true);
});

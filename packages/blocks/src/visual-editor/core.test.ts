import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { VISUAL_BLOCKS } from "./blocks.ts";
import { canvasDocument } from "./canvas.ts";
import { buildVisualEditPrompt, parseVisualEditResponse } from "./chat.ts";
import {
	cleanHtml,
	dropPositionFor,
	editHtml,
	findNode,
	outline,
	prepareHtml,
	resolveDrop,
	siblingPosition,
} from "./core.ts";

const ownsDomRegistration = !GlobalRegistrator.isRegistered;
if (ownsDomRegistration) {
	GlobalRegistrator.register();
}
afterAll(async () => {
	if (ownsDomRegistration) {
		await GlobalRegistrator.unregister();
	}
});

const parser = new DOMParser();
const parse = (html: string) => parser.parseFromString(html, "text/html");

const SITE =
	"<!doctype html><html><head><title>Site</title><style>h1{color:red}</style></head><body><header><h1>Hello</h1><p>Intro</p></header><main><section><h2>One</h2></section><section><h2>Two</h2></section></main><script>window.x=1</script></body></html>";

function ids(html: string) {
	return outline(parse(html)).map((node) => `${node.id}:${node.tag}`);
}

describe("visual editor core", () => {
	test("annotates visual nodes only and keeps ids stable", () => {
		const prepared = prepareHtml(SITE, parser);
		expect(ids(prepared)).toEqual([
			"root:body",
			"n1:header",
			"n2:h1",
			"n3:p",
			"n4:main",
			"n5:section",
			"n6:h2",
			"n7:section",
			"n8:h2",
		]);
		expect(prepareHtml(prepared, parser)).toBe(prepared);
		expect(prepared).not.toMatch(/<script data-ryu-node/);
	});

	test("clean output has no editor ids and keeps scripts and head", () => {
		const clean = cleanHtml(prepareHtml(SITE, parser), parser);
		expect(clean).not.toContain("data-ryu-node");
		expect(clean.startsWith("<!doctype html>")).toBe(true);
		expect(clean).toContain("<script>window.x=1</script>");
		expect(clean).toContain("<style>h1{color:red}</style>");
	});

	test("applies text, style, attribute, duplicate, and move operations", () => {
		const prepared = prepareHtml(SITE, parser);
		const result = editHtml(
			prepared,
			[
				{ kind: "setText", nodeId: "n2", text: "Welcome" },
				{ kind: "setStyle", nodeId: "n1", property: "padding", value: "24px" },
				{ kind: "setAttribute", nodeId: "n3", name: "title", value: "intro" },
				{ kind: "duplicate", nodeId: "n5" },
				{ kind: "move", nodeId: "n7", parentId: "n4", index: 0 },
			],
			parser
		);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		const document = parse(result.html);
		expect(findNode(document, "n2")?.textContent).toBe("Welcome");
		expect(findNode(document, "n1")?.getAttribute("style")).toBe(
			"padding: 24px;"
		);
		expect(findNode(document, "n3")?.getAttribute("title")).toBe("intro");
		const headings = [...document.querySelectorAll("main h2")].map(
			(node) => node.textContent
		);
		expect(headings).toEqual(["Two", "One", "One"]);
		const allIds = [...document.querySelectorAll("[data-ryu-node]")].map(
			(node) => node.getAttribute("data-ryu-node")
		);
		expect(new Set(allIds).size).toBe(allIds.length);
	});

	test("is atomic: a failing operation leaves nothing applied", () => {
		const prepared = prepareHtml(SITE, parser);
		const result = editHtml(
			prepared,
			[
				{ kind: "setText", nodeId: "n2", text: "Changed" },
				{ kind: "setText", nodeId: "n1", text: "would flatten the header" },
			],
			parser
		);
		expect(result).toEqual({
			ok: false,
			error:
				"Edit 2 (setText): Only elements without child elements can have their text replaced",
		});
	});

	test("rejects unsafe content", () => {
		const prepared = prepareHtml(SITE, parser);
		const insert = editHtml(
			prepared,
			[
				{
					kind: "insertHtml",
					parentId: "root",
					index: 99,
					html: '<div onclick="alert(1)"><a href="javascript:alert(1)">x</a><script>alert(1)</script><iframe src="https://x"></iframe></div>',
				},
			],
			parser
		);
		expect(insert.ok).toBe(true);
		if (insert.ok) {
			expect(insert.html).not.toContain("onclick");
			expect(insert.html).not.toContain("javascript:");
			expect(insert.html).not.toContain("alert(1)</script>");
			expect(insert.html).not.toContain("<iframe");
		}
		expect(
			editHtml(
				prepared,
				[
					{
						kind: "setAttribute",
						nodeId: "n3",
						name: "onmouseover",
						value: "x()",
					},
				],
				parser
			).ok
		).toBe(false);
		expect(
			editHtml(
				prepared,
				[
					{
						kind: "setAttribute",
						nodeId: "n3",
						name: "data-ryu-node",
						value: "n9",
					},
				],
				parser
			).ok
		).toBe(false);
		expect(
			editHtml(
				prepared,
				[
					{
						kind: "setStyle",
						nodeId: "n3",
						property: "background",
						value: "url(https://tracker.example/p.gif)",
					},
				],
				parser
			).ok
		).toBe(false);
		expect(
			editHtml(prepared, [{ kind: "remove", nodeId: "root" }], parser).ok
		).toBe(false);
		expect(
			editHtml(
				prepared,
				[{ kind: "move", nodeId: "n4", parentId: "n5", index: 0 }],
				parser
			).ok
		).toBe(false);
		expect(
			editHtml(prepared, [{ kind: "remove", nodeId: "#evil" }], parser).ok
		).toBe(false);
	});

	test("rejects script URLs the URL parser would still run", () => {
		const prepared = prepareHtml(SITE, parser);
		const insert = editHtml(
			prepared,
			[
				{
					kind: "insertHtml",
					parentId: "root",
					index: 99,
					html: '<div><a href="java&#9;script:alert(1)">a</a><a href="&#1;javascript:alert(2)">b</a><svg><a><set attributeName="href" to="javascript:alert(3)"></set><animate attributeName="href" values="javascript:alert(4)"></animate></a></svg></div>',
				},
			],
			parser
		);
		expect(insert.ok).toBe(true);
		if (insert.ok) {
			expect(insert.html).not.toContain("alert(1)");
			expect(insert.html).not.toContain("alert(2)");
			expect(insert.html).not.toContain("alert(3)");
			expect(insert.html).not.toContain("alert(4)");
			expect(insert.html).toContain(">a</a>");
		}
		expect(
			editHtml(
				prepared,
				[
					{
						kind: "setAttribute",
						nodeId: "n3",
						name: "href",
						value: "java\tscript:alert(1)",
					},
				],
				parser
			).ok
		).toBe(false);
		expect(
			editHtml(
				prepared,
				[
					{
						kind: "setAttribute",
						nodeId: "n3",
						name: "href",
						value: "https://example.com/pricing",
					},
				],
				parser
			).ok
		).toBe(true);
	});

	test("resolves drops like the canvas and layers panel expect", () => {
		const document = parse(prepareHtml(SITE, parser));
		expect(resolveDrop(document, "n7", "n5", "before")).toEqual({
			parentId: "n4",
			index: 0,
		});
		expect(resolveDrop(document, "n5", "n7", "after")).toEqual({
			parentId: "n4",
			index: 1,
		});
		expect(resolveDrop(document, null, "n5", "inside")).toEqual({
			parentId: "n5",
			index: 1,
		});
		expect(resolveDrop(document, "n4", "n6", "before")).toBeNull();
		expect(resolveDrop(document, "n5", "n5", "after")).toBeNull();
		expect(resolveDrop(document, null, "root", "before")).toEqual({
			parentId: "root",
			index: 2,
		});
		expect(siblingPosition(document, "n7")).toEqual({
			parentId: "n4",
			index: 1,
			count: 2,
		});
		expect(dropPositionFor(5, 100, true)).toBe("before");
		expect(dropPositionFor(50, 100, true)).toBe("inside");
		expect(dropPositionFor(50, 100, false)).toBe("after");
	});

	test("every palette block inserts cleanly", () => {
		const prepared = prepareHtml(SITE, parser);
		for (const block of VISUAL_BLOCKS) {
			const result = editHtml(
				prepared,
				[{ kind: "insertHtml", parentId: "n4", index: 0, html: block.html }],
				parser
			);
			expect(result.ok).toBe(true);
		}
	});

	test("canvas copy removes scripts and handlers and blocks the network", () => {
		const canvas = canvasDocument(
			prepareHtml(
				SITE.replace("<p>Intro</p>", '<p onclick="x()">Intro</p>'),
				parser
			),
			parser
		);
		expect(canvas).not.toContain("<script>");
		expect(canvas).not.toContain("onclick");
		expect(canvas).toContain("script-src 'none'");
		expect(canvas).toContain('draggable="true"');
	});
});

describe("visual editor chat", () => {
	test("builds a bounded prompt with outline and selection", () => {
		const document = parse(prepareHtml(SITE, parser));
		const prompt = buildVisualEditPrompt({
			outline: outline(document),
			request: "Make the intro bold",
			selectedId: "n3",
			selectedHtml: "<p>Intro</p>",
		});
		expect(prompt).toContain('n3 <p> "Intro"');
		expect(prompt).toContain("Selected: n3");
	});

	test("parses fenced replies and rejects invalid ones", () => {
		const good = parseVisualEditResponse(
			'```json\n{"operations":[{"kind":"setStyle","nodeId":"n3","property":"font-weight","value":"700"}],"summary":"Bolded the intro."}\n```'
		);
		expect(good).toEqual({
			ok: true,
			summary: "Bolded the intro.",
			operations: [
				{
					kind: "setStyle",
					nodeId: "n3",
					property: "font-weight",
					value: "700",
				},
			],
		});
		expect(parseVisualEditResponse("Sure! I made it bold.").ok).toBe(false);
		expect(
			parseVisualEditResponse('{"operations":[{"kind":"eval","code":"x"}]}').ok
		).toBe(false);
		expect(
			parseVisualEditResponse(
				'{"operations":[],"summary":"That needs a server."}'
			)
		).toEqual({
			ok: false,
			error: "That needs a server.",
		});
	});
});

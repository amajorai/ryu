import { beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!("localStorage" in globalThis)) {
	GlobalRegistrator.register();
}

const {
	clearLinkAddedNode,
	isLinkAddedNode,
	markLinkAddedNode,
	saveLinkAddedNode,
} = await import("./link-added-nodes.ts");

const STORAGE_KEY = "ryu:node-added-by-link";

beforeEach(() => {
	localStorage.removeItem(STORAGE_KEY);
});

describe("link-added nodes", () => {
	test("a server is not link-added until a link saves it", () => {
		expect(isLinkAddedNode("https://node.example.com")).toBe(false);
		markLinkAddedNode("https://node.example.com");
		expect(isLinkAddedNode("https://node.example.com")).toBe(true);
		expect(isLinkAddedNode("https://other.example.com")).toBe(false);
	});

	test("the mark follows the server, not the spelling of its URL", () => {
		markLinkAddedNode("https://Node.Example.com:443/");
		expect(isLinkAddedNode("https://node.example.com")).toBe(true);
		expect(isLinkAddedNode("https://node.example.com/base")).toBe(true);
		expect(isLinkAddedNode("http://node.example.com")).toBe(false);
		expect(isLinkAddedNode("https://node.example.com:7980")).toBe(false);
	});

	test("adding the server by hand clears the mark", () => {
		markLinkAddedNode("https://node.example.com");
		clearLinkAddedNode("https://node.example.com/");
		expect(isLinkAddedNode("https://node.example.com")).toBe(false);
	});

	test("the mark is stored, so another window and a restart see it", () => {
		markLinkAddedNode("https://node.example.com");
		expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")).toEqual([
			"https://node.example.com",
		]);
		// Another window wrote the storage: the next read picks it up.
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify(["https://elsewhere.example.com"])
		);
		expect(isLinkAddedNode("https://node.example.com")).toBe(false);
		expect(isLinkAddedNode("https://elsewhere.example.com")).toBe(true);
	});

	test("a link's node is marked before it is saved", async () => {
		let markedWhileSaving = false;
		await saveLinkAddedNode("https://node.example.com", [], async () => {
			markedWhileSaving = isLinkAddedNode("https://node.example.com");
		});
		expect(markedWhileSaving).toBe(true);
		expect(isLinkAddedNode("https://node.example.com")).toBe(true);
	});

	test("a failed save takes the mark back", async () => {
		const failure = new Error("Core refused the node");
		await expect(
			saveLinkAddedNode("https://node.example.com", [], async () => {
				throw failure;
			})
		).rejects.toBe(failure);
		expect(isLinkAddedNode("https://node.example.com")).toBe(false);
	});

	test("a link cannot mark a server the user already has", async () => {
		await saveLinkAddedNode(
			"https://NODE.example.com/other",
			["http://127.0.0.1:7980", "https://node.example.com/"],
			async () => undefined
		);
		expect(isLinkAddedNode("https://node.example.com")).toBe(false);
	});

	test("unreadable storage and unreadable URLs answer no", () => {
		localStorage.setItem(STORAGE_KEY, "{not json");
		expect(isLinkAddedNode("https://node.example.com")).toBe(false);
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ a: 1 }));
		expect(isLinkAddedNode("https://node.example.com")).toBe(false);
		markLinkAddedNode("https://trusted@evil.example");
		expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify({ a: 1 }));
		expect(isLinkAddedNode("not a url")).toBe(false);
	});
});

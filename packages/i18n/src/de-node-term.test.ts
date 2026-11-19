import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// German glossary: a Ryu node (the machine that runs Core and Gateway) is a
// "Knoten" (Knotens, Ryu-Knoten, Cloud-Knoten, Knoten-Token …), never the
// English "Node". "Node" stays only for the Node.js runtime and for the nodes
// of a visual graph, such as the Chat and Speech nodes on a media board.

const NODE_SOURCE = /\bnodes?\b/i;
const NODE_RUNTIME_SOURCE =
	/Node\.js|\bNode (?:app|MCP|on PATH)\b|\bBun, Node\b|^Node, Docker|node package manager/;
const GRAPH_NODE_SOURCE = /\bnode board\b|\b(?:Chat|Speech) node\b/i;
const PLACEHOLDER = /\{[^{}]*\}/g;
const ENGLISH_NODE = /Node(?!\.js)/;

const nodeTermViolation = (source: string, value: string): boolean =>
	NODE_SOURCE.test(source) &&
	!NODE_RUNTIME_SOURCE.test(source) &&
	!GRAPH_NODE_SOURCE.test(source) &&
	ENGLISH_NODE.test(value.replace(PLACEHOLDER, ""));

const nodeTermViolations = (catalog: Record<string, unknown>): string[] => {
	const violations: string[] = [];
	for (const [source, value] of Object.entries(catalog)) {
		if (typeof value === "string" && nodeTermViolation(source, value)) {
			violations.push(`${source} -> ${value}`);
		}
	}
	return violations;
};

const LOCALES_DIR = new URL("../locales/", import.meta.url);

const readCatalog = async (path: string) =>
	(await Bun.file(new URL(path, LOCALES_DIR)).json()) as Record<
		string,
		unknown
	>;

describe("de node term rule", () => {
	test("a Ryu node left as English Node is flagged", () => {
		expect(
			nodeTermViolations({
				"Managed nodes": "Verwaltete Nodes",
				"Node offline.": "Node offline.",
				"Run your node in the EU or Singapore.":
					"Den Node in der EU oder in Singapur betreiben.",
				"Unsplash (node key)": "Unsplash (Node-Schlüssel)",
			})
		).toEqual([
			"Managed nodes -> Verwaltete Nodes",
			"Node offline. -> Node offline.",
			"Run your node in the EU or Singapore. -> Den Node in der EU oder in Singapur betreiben.",
			"Unsplash (node key) -> Unsplash (Node-Schlüssel)",
		]);
	});

	test("Knoten forms and placeholder names pass", () => {
		expect(
			nodeTermViolations({
				"Managed node transfer started":
					"Übertragung des verwalteten Knotens gestartet",
				"Managed nodes": "Verwaltete Knoten",
				"Node name must be {fleetNodeNameMaxLength} characters or fewer.":
					"Der Knotenname darf höchstens {fleetNodeNameMaxLength} Zeichen lang sein.",
				"Unsplash (node key)": "Unsplash (Knotenschlüssel)",
			})
		).toEqual([]);
	});

	test("Node.js and graph nodes keep Node", () => {
		expect(
			nodeTermViolations({
				"Bun, Node, Next.js, Hono, the MCP SDK, rustls, undici, and Wasmtime, all patched.":
					"Bun, Node, Next.js, Hono, das MCP SDK, rustls, undici und Wasmtime – alle gepatcht.",
				"Node.js (npm)": "Node.js (npm)",
				"Text to speak (or wire a Chat node in)…":
					"Zu sprechender Text (oder einen Chat-Node verbinden)…",
				"Upload audio, or wire in a Speech node":
					"Audio hochladen oder einen Sprach-Node verbinden",
				"node package manager · for JS agents/tools":
					"Node-Paketmanager · für JS-Agenten/-Tools",
			})
		).toEqual([]);
	});
});

describe("de catalogs use Knoten for the Ryu node", () => {
	test("the root de catalog uses Knoten", async () => {
		const catalog = await readCatalog("de.json");
		expect(nodeTermViolations(catalog)).toEqual([]);
		expect(catalog["Managed nodes"]).toBe("Verwaltete Knoten");
		expect(catalog["Node offline."]).toBe("Knoten offline.");
		expect(catalog["Managed node transfer started"]).toBe(
			"Übertragung des verwalteten Knotens gestartet"
		);
		expect(catalog["Node.js (npm)"]).toBe("Node.js (npm)");
	});

	test("every generated de subset uses Knoten", async () => {
		const violations: string[] = [];
		const glob = new Bun.Glob("*/**/de.json");
		for await (const path of glob.scan(fileURLToPath(LOCALES_DIR))) {
			for (const violation of nodeTermViolations(await readCatalog(path))) {
				violations.push(`${path}: ${violation}`);
			}
		}
		expect(violations).toEqual([]);
	});
});

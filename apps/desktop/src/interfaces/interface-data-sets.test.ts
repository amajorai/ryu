import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	INTERFACE_RENDERERS,
	KIT_GAME_RENDERERS,
} from "@ryuhq/protocol/interfaces";

const SURFACE_SOURCE = readFileSync(
	join(import.meta.dir, "InterfaceSurface.tsx"),
	"utf8"
);
const RENDERER_SOURCES = join(
	import.meta.dir,
	"../../../../packages/blocks/src/desktop/interfaces"
);
const SOURCE_FILE = /\.tsx?$/;
const TEST_FILE = /\.test\.tsx?$/;
const EVENTS_READ = /\bsnapshot\.events\b/;
const ACCOUNT_READ = /\bsnapshot\.account\b/;

/**
 * Reads a `const NAME: ReadonlySet<string> = new Set([...])` from the surface
 * source. Importing `InterfaceSurface.tsx` here would load browser-only stores.
 */
function surfaceSet(name: string): ReadonlySet<string> {
	const declaration = new RegExp(
		`const ${name}: ReadonlySet<string> = new Set\\(\\[([^\\]]*)\\]\\)`
	).exec(SURFACE_SOURCE);
	if (!declaration?.[1]) {
		throw new Error(`InterfaceSurface.tsx no longer declares ${name}`);
	}
	return new Set(
		[...declaration[1].matchAll(/"([^"]+)"/g)].map(([, id]) => id ?? "")
	);
}

const ACCOUNT_RENDERERS = surfaceSet("ACCOUNT_RENDERERS");
const EVENT_RENDERERS = surfaceSet("EVENT_RENDERERS");

/** The renderer a source file belongs to: the longest id its name starts with. */
function rendererOf(fileName: string): string | null {
	let match: string | null = null;
	for (const renderer of INTERFACE_RENDERERS) {
		const owns =
			fileName.startsWith(`${renderer}-`) ||
			fileName.startsWith(`${renderer}.`);
		if (owns && renderer.length > (match?.length ?? 0)) {
			match = renderer;
		}
	}
	return match;
}

/** Renderer sources (or unowned files) whose code matches `pattern`. */
function readersOf(pattern: RegExp): Map<string, string> {
	const readers = new Map<string, string>();
	for (const fileName of readdirSync(RENDERER_SOURCES)) {
		if (!SOURCE_FILE.test(fileName) || TEST_FILE.test(fileName)) {
			continue;
		}
		const source = readFileSync(join(RENDERER_SOURCES, fileName), "utf8");
		if (pattern.test(source)) {
			readers.set(fileName, rendererOf(fileName) ?? `unowned:${fileName}`);
		}
	}
	return readers;
}

describe("interface snapshot data sets", () => {
	test("every renderer that reads snapshot.events is requested events", () => {
		const readers = readersOf(EVENTS_READ);
		expect(readers.size).toBeGreaterThan(0);
		// The 3D game kit (`game3d-*`) reads events for every kit game.
		const kitFile = /^game3d-/;
		const missing = [...readers]
			.flatMap(([fileName, renderer]): [string, string][] =>
				kitFile.test(fileName)
					? KIT_GAME_RENDERERS.map((kit) => [fileName, kit])
					: [[fileName, renderer]]
			)
			.filter(([, renderer]) => !EVENT_RENDERERS.has(renderer))
			.map(([fileName, renderer]) => `${renderer} (${fileName})`);
		expect(missing).toEqual([]);
	});

	test("every renderer that reads snapshot.account is requested the wallet", () => {
		const readers = readersOf(ACCOUNT_READ);
		expect(readers.size).toBeGreaterThan(0);
		const missing = [...readers]
			.filter(([, renderer]) => !ACCOUNT_RENDERERS.has(renderer))
			.map(([fileName, renderer]) => `${renderer} (${fileName})`);
		expect(missing).toEqual([]);
	});

	test("Town gets both its schedule and its funds readout", () => {
		expect(EVENT_RENDERERS.has("town")).toBe(true);
		expect(ACCOUNT_RENDERERS.has("town")).toBe(true);
	});
});

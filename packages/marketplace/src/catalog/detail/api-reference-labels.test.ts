// Every hook phase, composer control type and view target the bundled store
// manifests declare has a translated label, and unknown tokens return null so
// the panel can show them verbatim in a code chip.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	API_REFERENCE_TOKENS,
	composerControlLabel,
	hookEventFallbackLabel,
	hookEventLabel,
	viewSurfaceLabel,
} from "./api-reference-labels.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const MANIFEST_GLOBS = [
	"apps-store/*/manifest.json",
	"plugins-store/**/manifest.json",
	"plugins-store/**/plugin.json",
];

interface ManifestTokens {
	controlTypes: Set<string>;
	hookEvents: Set<string>;
	viewSurfaces: Set<string>;
}

function asRecords(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value)
		? value.filter(
				(item): item is Record<string, unknown> =>
					typeof item === "object" && item !== null
			)
		: [];
}

function addString(target: Set<string>, value: unknown) {
	if (typeof value === "string" && value.trim()) {
		target.add(value);
	}
}

function collectManifestTokens(): ManifestTokens {
	const tokens: ManifestTokens = {
		controlTypes: new Set(),
		hookEvents: new Set(),
		viewSurfaces: new Set(),
	};
	for (const pattern of MANIFEST_GLOBS) {
		for (const path of new Bun.Glob(pattern).scanSync(REPO_ROOT)) {
			if (path.includes("node_modules")) {
				continue;
			}
			let manifest: unknown;
			try {
				manifest = JSON.parse(readFileSync(`${REPO_ROOT}${path}`, "utf8"));
			} catch {
				continue;
			}
			const contributes = (manifest as { contributes?: unknown })?.contributes;
			if (typeof contributes !== "object" || contributes === null) {
				continue;
			}
			const c = contributes as Record<string, unknown>;
			for (const hook of asRecords(c.turn_hooks)) {
				addString(tokens.hookEvents, hook.event ?? hook.on);
			}
			for (const control of asRecords(c.composer_controls)) {
				addString(tokens.controlTypes, control.type);
			}
			for (const view of asRecords(c.views)) {
				addString(tokens.viewSurfaces, view.surface);
			}
		}
	}
	return tokens;
}

describe("api-reference labels", () => {
	const tokens = collectManifestTokens();

	test("the bundled manifests declare hooks and composer controls", () => {
		expect(tokens.hookEvents.size).toBeGreaterThan(0);
		expect(tokens.controlTypes.size).toBeGreaterThan(0);
	});

	test("every bundled hook phase has a translated sentence", () => {
		// `<plugin>#<event>` subscriptions are app-event identifiers; they render
		// verbatim beside a generic sentence (see the fallback test below).
		const missing = [...tokens.hookEvents].filter(
			(event) => !event.includes("#") && hookEventLabel(event) === null
		);
		expect(missing).toEqual([]);
	});

	test("every bundled composer control type has a translated badge", () => {
		const missing = [...tokens.controlTypes].filter(
			(type) => composerControlLabel(type) === null
		);
		expect(missing).toEqual([]);
	});

	test("every bundled view target has a translated badge", () => {
		const missing = [...tokens.viewSurfaces].filter(
			(surface) => viewSurfaceLabel(surface) === null
		);
		expect(missing).toEqual([]);
	});

	test("each table entry renders a non-empty English phrase", () => {
		for (const event of API_REFERENCE_TOKENS.hookEvents) {
			expect(hookEventLabel(event)).toMatch(/^Runs /);
		}
		for (const type of API_REFERENCE_TOKENS.composerControlTypes) {
			expect(composerControlLabel(type)).toMatch(/^Composer /);
		}
		for (const region of API_REFERENCE_TOKENS.viewRegions) {
			expect(viewSurfaceLabel(region)).toMatch(/ view$/);
		}
		expect(viewSurfaceLabel("desktop")).toBe("Desktop view");
	});

	test("an unlabelled hook gets a generic sentence for its code chip", () => {
		expect(hookEventLabel("@ryu/meetings#meeting.ended")).toBeNull();
		expect(hookEventFallbackLabel("@ryu/meetings#meeting.ended")).toBe(
			"Runs when another app emits an event"
		);
		expect(hookEventFallbackLabel("before_turn")).toBe("Runs on a hook event");
	});

	test("unknown or prototype tokens return null instead of a guess", () => {
		expect(hookEventLabel("before_turn")).toBeNull();
		expect(hookEventLabel("constructor")).toBeNull();
		expect(composerControlLabel("slider")).toBeNull();
		expect(viewSurfaceLabel("unknown")).toBeNull();
		expect(viewSurfaceLabel("toString")).toBeNull();
		expect(viewSurfaceLabel(null)).toBeNull();
	});
});

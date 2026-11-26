// The scope model of the settings: every entry has a level, section ids are
// canonical and unique, and the removed section ids are gone from the source.

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GATEWAY_NAV_GROUPS } from "../components/gateway/gateway-dialog/gateway-nav.ts";
import { GATEWAY_SECTIONS } from "../components/gateway/gateway-dialog/gateway-sections.ts";
import { SETTINGS_ENTRIES } from "./settings-index.ts";
import {
	APP_SECTION_LEVELS,
	canonicalGatewaySection,
	canonicalSectionId,
	GATEWAY_SECTION_ALIASES,
	GATEWAY_SECTION_LEVELS,
	listCanonicalSectionIds,
	REMOVED_APP_SECTION_IDS,
	SETTINGS_LEVELS,
	sectionLevel,
} from "./settings-levels.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");
const APP_NAV = join(SRC, "components", "settings", "settings-dialog-nav.tsx");
const APP_SECTIONS_BODY = join(
	SRC,
	"components",
	"settings",
	"settings-dialog-sections.tsx"
);

/**
 * Rows whose level differs from the level of the section they sit in. Each one
 * is pinned to where its value is stored (see the evidence table in the PR).
 * A change here must come with a new storage path, not a new dialog.
 */
const LEVEL_EXCEPTIONS: Record<string, string> = {
	// App dialog rows that read and write the Core or Gateway API.
	"general.chats.resume-interrupted-chats": "computer",
	"general.chats.gaming-detection": "computer",
	"general.chats.gaming-free-models": "computer",
	"general.chats.gaming-processes": "computer",
	"general.chats.gaming-ignored": "computer",
	"general.chats.streaming-detection": "computer",
	"general.chats.streaming-apps": "computer",
	"general.system.prevent-sleep-while-running": "computer",
	"keyboard.global": "computer",
	"voice.voice-input.model": "computer",
	"voice.read-back-responses.always-read-back-responses": "computer",
	// App dialog rows stored on the account by the cloud API.
	"sync.last-sync": "account",
	"sync.delete-cloud-copy": "account",
	"updates.extend-updates": "account",
	// Gateway dialog rows that ask the OS for a permission of the desktop app.
	"desktop.privacy.device-permissions.microphone": "app",
	"desktop.privacy.device-permissions.screen-recording": "app",
	"desktop.privacy.device-permissions.accessibility": "app",
	"desktop.privacy.device-permissions.input-monitoring": "app",
};

function listSourceFiles(dir: string): string[] {
	return readdirSync(dir, { recursive: true, encoding: "utf8" })
		.filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
		.map((f) => join(dir, f));
}

describe("settings levels", () => {
	it("gives every search index entry a known level", () => {
		expect(SETTINGS_ENTRIES.length).toBeGreaterThan(200);
		const missing = SETTINGS_ENTRIES.filter(
			(entry) => !SETTINGS_LEVELS.includes(entry.level)
		).map((entry) => entry.id);
		expect(missing).toEqual([]);
	});

	it("keeps entry ids unique", () => {
		const seen = new Set<string>();
		const duplicates: string[] = [];
		for (const entry of SETTINGS_ENTRIES) {
			if (seen.has(entry.id)) {
				duplicates.push(entry.id);
			}
			seen.add(entry.id);
		}
		expect(duplicates).toEqual([]);
	});

	it("puts every entry in a canonical section of its dialog", () => {
		const unknown = SETTINGS_ENTRIES.filter(
			(entry) => sectionLevel(entry.dialog, entry.section) === null
		).map((entry) => `${entry.id} -> ${entry.dialog}:${entry.section}`);
		expect(unknown).toEqual([]);
	});

	it("differs from the section level only for the pinned storage exceptions", () => {
		const differing: Record<string, string> = {};
		for (const entry of SETTINGS_ENTRIES) {
			if (entry.level !== sectionLevel(entry.dialog, entry.section)) {
				differing[entry.id] = entry.level;
			}
		}
		expect(differing).toEqual(LEVEL_EXCEPTIONS);
	});

	it("never marks an App dialog row as computer unless it is pinned", () => {
		const computerRows = SETTINGS_ENTRIES.filter(
			(entry) => entry.dialog === "app" && entry.level === "computer"
		).map((entry) => entry.id);
		for (const id of computerRows) {
			expect(LEVEL_EXCEPTIONS[id]).toBe("computer");
		}
	});

	it("uses only known levels in the section tables", () => {
		for (const level of [
			...Object.values(APP_SECTION_LEVELS),
			...Object.values(GATEWAY_SECTION_LEVELS),
		]) {
			expect(SETTINGS_LEVELS).toContain(level);
		}
	});
});

describe("canonical section ids", () => {
	it("are unique across both dialogs", () => {
		const ids = listCanonicalSectionIds();
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toContain(canonicalSectionId("app", "updates"));
		expect(ids).toContain(canonicalSectionId("gateway", "updates"));
	});

	it("resolve aliases and leave other ids alone", () => {
		expect(canonicalGatewaySection("access")).toBe("connections");
		expect(canonicalGatewaySection("connections")).toBe("connections");
		expect(canonicalGatewaySection("app:memory")).toBe("app:memory");
		expect(canonicalGatewaySection("toString")).toBe("toString");
		expect(listCanonicalSectionIds()).not.toContain("gateway:access");
		for (const target of Object.values(GATEWAY_SECTION_ALIASES)) {
			expect(Object.hasOwn(GATEWAY_SECTION_LEVELS, target)).toBe(true);
		}
	});

	it("match the Gateway dialog sections and every one has a nav row", () => {
		const declared: string[] = GATEWAY_SECTIONS.map((s) => s.value).sort();
		expect(declared).toEqual(Object.keys(GATEWAY_SECTION_LEVELS).sort());
		const inNav = new Set(GATEWAY_NAV_GROUPS.flatMap((g) => g.items));
		const orphans = listCanonicalSectionIds()
			.filter((id) => id.startsWith("gateway:"))
			.map((id) => id.slice("gateway:".length))
			.filter((section) => !inNav.has(section as never));
		expect(orphans).toEqual([]);
	});

	it("match the App Settings nav rows one to one", () => {
		const nav = readFileSync(APP_NAV, "utf8");
		const values = [...nav.matchAll(/\bvalue:\s*"([a-z-]+)"/g)].map(
			(m) => m[1]
		);
		expect([...new Set(values)].sort()).toEqual(
			Object.keys(APP_SECTION_LEVELS).sort()
		);
	});

	it("have a rendered pane for every App Settings section", () => {
		const body = readFileSync(APP_SECTIONS_BODY, "utf8");
		for (const section of Object.keys(APP_SECTION_LEVELS)) {
			expect(body).toContain(`case "${section}":`);
		}
	});
});

describe("removed section ids", () => {
	it("are not App Settings sections any more", () => {
		for (const id of REMOVED_APP_SECTION_IDS) {
			expect(sectionLevel("app", id)).toBeNull();
		}
	});

	it("are not opened or rendered anywhere in the desktop source", () => {
		const removed = REMOVED_APP_SECTION_IDS.join("|");
		const opener = new RegExp(`openSettings\\(\\s*"(${removed})"`);
		const appCase = new RegExp(`case "(${removed})":`);
		const hits: string[] = [];
		for (const file of listSourceFiles(SRC)) {
			const text = readFileSync(file, "utf8");
			if (opener.test(text)) {
				hits.push(file);
			}
		}
		const body = readFileSync(APP_SECTIONS_BODY, "utf8");
		if (appCase.test(body)) {
			hits.push(APP_SECTIONS_BODY);
		}
		const store = readFileSync(
			join(SRC, "store", "useSettingsDialog.ts"),
			"utf8"
		);
		for (const id of REMOVED_APP_SECTION_IDS) {
			if (store.includes(`| "${id}"`)) {
				hits.push(`useSettingsDialog.ts: ${id}`);
			}
		}
		expect(hits).toEqual([]);
	});
});

// The allowlist is the security boundary of settings sync, so it gets the kind
// of test a security boundary needs: not "does the list parse" but "is anything
// on it that must never leave the machine", and "does everything on it still
// exist in the app".

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	currentPlatform,
	groupForKey,
	isKeybindingsKey,
	isSyncableKey,
	keybindingsKey,
	labelForKey,
	platformOfKeybindingsKey,
	SYNCABLE_KEYS,
} from "./keys.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "..");

/** Concatenated desktop source, for "does this key still exist" checks. */
function readAllSource(): string {
	const parts: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) {
				walk(path);
				continue;
			}
			if (name.endsWith(".ts") || name.endsWith(".tsx")) {
				parts.push(readFileSync(path, "utf8"));
			}
		}
	};
	walk(SRC);
	return parts.join("\n");
}

/**
 * Keys that must never be syncable. Not an exhaustive denylist — the allowlist
 * is what enforces the boundary — but a tripwire for the specific mistakes that
 * would be worst: shipping a credential, or a value that is meaningless on
 * another machine.
 */
const MUST_NEVER_SYNC = [
	// Credentials / identity
	"ryu_session_token",
	"ryu_accounts",
	"ryu_active_user_id",
	"ryu_oidc_user",
	"ryu_waitlist_approved",
	"composio-api-key",
	"replicate-api-key",
	"fal-api-key",
	"hf-token",
	"aa-api-key",
	// Machine-local facts
	"ryu_workspace_folder",
	"ryu_workspace_recents",
	"ryu_workspace_projects_v1",
	"ryu_default_microphone",
	"ryu_default_speaker",
	"ryu_session_tabs",
	"ryu_pinned_dock_tabs",
	"ryu_client_id",
	"ryu:analytics-install-id",
	// State, not settings
	"ryu:archived-convs",
	"ryu:pinned-convs",
	"ryu:unread-convs",
	"ryu:auto-imported-thread-ids",
	"ryu_picker_recents",
	"ryu_desktop_onboarding_complete",
	"ryu_onboarding_complete",
];

describe("the sync allowlist", () => {
	it("carries no credential, machine-local fact, or transient state", () => {
		const leaked = MUST_NEVER_SYNC.filter((key) => isSyncableKey(key));
		expect(leaked).toEqual([]);
	});

	it("has no duplicate keys", () => {
		const keys = SYNCABLE_KEYS.map((k) => k.key);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("gives every key a human label", () => {
		for (const entry of SYNCABLE_KEYS) {
			expect(entry.label.length).toBeGreaterThan(0);
			expect(entry.label).not.toBe(entry.key);
		}
	});

	it("only lists keys the app actually writes", () => {
		const source = readAllSource();
		const missing = SYNCABLE_KEYS.filter(
			(entry) => !source.includes(`"${entry.key}"`)
		).map((entry) => entry.key);
		expect(missing).toEqual([]);
	});

	it("does not treat the sync engine's own bookkeeping as syncable", () => {
		// These describe THIS machine's relationship to the server. Syncing them
		// would let one machine turn sync off everywhere, or hand every device the
		// same stale cursor.
		for (const key of [
			"ryu:settings-sync-enabled",
			"ryu:settings-sync-policy",
			"ryu:settings-sync-cursor",
			"ryu:settings-sync-meta",
			"ryu:settings-sync-last",
		]) {
			expect(isSyncableKey(key)).toBe(false);
		}
	});

	it("includes the composer send shortcut in chat sync", () => {
		expect(isSyncableKey("ryu:composer-send-shortcut")).toBe(true);
		expect(groupForKey("ryu:composer-send-shortcut")).toBe("chat");
	});
});

describe("per-OS shortcut slots", () => {
	it("round-trips a platform through its wire key", () => {
		for (const platform of ["darwin", "win32", "linux"] as const) {
			const key = keybindingsKey(platform);
			expect(isKeybindingsKey(key)).toBe(true);
			expect(platformOfKeybindingsKey(key)).toBe(platform);
		}
	});

	it("rejects an unknown platform suffix", () => {
		expect(platformOfKeybindingsKey("keybindings:solaris")).toBeNull();
	});

	it("names the OS in the label so a conflict row is unambiguous", () => {
		expect(labelForKey("keybindings:darwin")).toContain("macOS");
		expect(labelForKey("keybindings:win32")).toContain("Windows");
	});

	it("groups shortcut keys under shortcuts", () => {
		expect(groupForKey("keybindings:darwin")).toBe("shortcuts");
	});

	it("detects a platform from the user agent", () => {
		// Whatever the test runner reports, it must be one of the three slots —
		// an unrecognized platform silently sharing another's shortcuts would be
		// the bug this guards.
		expect(["darwin", "win32", "linux"]).toContain(currentPlatform());
	});
});

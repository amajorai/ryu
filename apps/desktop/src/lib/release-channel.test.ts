// apps/desktop/src/lib/release-channel.test.ts
//
// Tests for the non-reactive release-channel read used by the updater install
// path (outside React). The validation is load-bearing: a bogus or legacy
// stored value must fall back to "stable" so an unset/corrupted install checks
// the stable feed rather than a nonexistent one. The `useReleaseChannel` hook
// (useSyncExternalStore + cross-window sync) needs a render harness and is out
// of scope for lib-only logic tests.
//
// A real DOM (localStorage) is required; register happy-dom before importing.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof globalThis.window === "undefined") {
	GlobalRegistrator.register();
}
import { beforeEach, describe, expect, test } from "bun:test";
import {
	DEFAULT_RELEASE_CHANNEL,
	getReleaseChannel,
	RELEASE_CHANNEL_KEY,
	RELEASE_CHANNELS,
} from "./release-channel.ts";

beforeEach(() => {
	localStorage.clear();
});

describe("getReleaseChannel", () => {
	test("defaults to stable when nothing is stored", () => {
		expect(getReleaseChannel()).toBe(DEFAULT_RELEASE_CHANNEL);
		expect(DEFAULT_RELEASE_CHANNEL).toBe("stable");
	});

	test("returns each valid stored channel verbatim", () => {
		for (const { channel } of RELEASE_CHANNELS) {
			localStorage.setItem(RELEASE_CHANNEL_KEY, channel);
			expect(getReleaseChannel()).toBe(channel);
		}
	});

	test("falls back to the default for a bogus/legacy stored value", () => {
		localStorage.setItem(RELEASE_CHANNEL_KEY, "experimental");
		expect(getReleaseChannel()).toBe(DEFAULT_RELEASE_CHANNEL);
	});

	test("falls back to the default for a non-string-ish empty value", () => {
		localStorage.setItem(RELEASE_CHANNEL_KEY, "");
		expect(getReleaseChannel()).toBe(DEFAULT_RELEASE_CHANNEL);
	});
});

describe("RELEASE_CHANNELS metadata", () => {
	test("lists all four channels most-bleeding-edge first, ending at stable", () => {
		expect(RELEASE_CHANNELS.map((c) => c.channel)).toEqual([
			"canary",
			"nightly",
			"beta",
			"stable",
		]);
	});

	test("gives every channel a human label and description", () => {
		for (const c of RELEASE_CHANNELS) {
			expect(c.label.length).toBeGreaterThan(0);
			expect(c.description.length).toBeGreaterThan(0);
		}
	});
});

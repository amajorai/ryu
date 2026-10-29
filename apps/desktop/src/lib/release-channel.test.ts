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

// `isRegistered` is the registrator's OWN state, and it is the only thing
// `register()` actually checks before throwing. The previous guard tested
// `globalThis.window`, which is a different question: bun runs every file in this
// package in ONE process, so the registrator module — and its private
// `#registered` flag — is shared across files while `globalThis.window` is not a
// reliable proxy for it. The result was "Happy DOM has already been globally
// registered" thrown from whichever file happened to be evaluated second,
// failing 25 tests across 9 files that all pass individually.
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { beforeEach, describe, expect, test } from "bun:test";
import {
	AVAILABLE_RELEASE_CHANNELS,
	DEFAULT_RELEASE_CHANNEL,
	getReleaseChannel,
	RELEASE_CHANNEL_KEY,
	RELEASE_CHANNELS,
	releaseChannelsFor,
	resolveReleaseChannel,
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

describe("Ryu Bot channels", () => {
	// The Bot updater has no nightly/canary feed and refuses those channels, so
	// the picker must not offer them and a stored choice must not keep them.
	test("the Bot picker offers beta and stable only", () => {
		expect(releaseChannelsFor("bot").map((c) => c.channel)).toEqual([
			"beta",
			"stable",
		]);
		expect(releaseChannelsFor("build")).toEqual(RELEASE_CHANNELS);
		expect(releaseChannelsFor("app")).toEqual(RELEASE_CHANNELS);
	});

	test("a stored nightly or canary choice falls back to stable in Bot", () => {
		expect(resolveReleaseChannel("nightly", "bot")).toBe("stable");
		expect(resolveReleaseChannel("canary", "bot")).toBe("stable");
		expect(resolveReleaseChannel("beta", "bot")).toBe("beta");
		expect(resolveReleaseChannel("nightly", "build")).toBe("nightly");
		expect(resolveReleaseChannel("bogus", "build")).toBe(
			DEFAULT_RELEASE_CHANNEL
		);
	});

	test("this non-Bot test build offers every channel", () => {
		expect(AVAILABLE_RELEASE_CHANNELS).toEqual(RELEASE_CHANNELS);
	});
});

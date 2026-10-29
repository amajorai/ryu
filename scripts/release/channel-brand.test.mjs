// Unit tests for the channel branding stamp (scripts/release/channel-brand.mjs).
//
// Two properties are load-bearing:
//
//   1. CHANNEL DERIVATION. `channelOfVersion` is a third implementation of the
//      rule `apps/core/src/update/mod.rs::channel_of` owns and the desktop's
//      `channel-brand.ts` mirrors. The cases below are copied from that Rust
//      test verbatim, so a drift in any one of the three fails here.
//   2. LABEL COVERAGE. Every channel the release train can actually produce must
//      have a label in `release-channels.json`. A missing one does not crash —
//      it Title-Cases the id — but it silently ships "Ryu (Stable)" instead of
//      the intended "Ryu (Research Preview)", which is exactly the gap this
//      whole mechanism exists to close.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	applyProfileIdentity,
	channelOfVersion,
	labelFor,
} from "./channel-brand.mjs";

test("each channel bundle owns only its profile scheme and app identity", () => {
	for (const channel of ["stable", "dev", "beta", "nightly", "canary"]) {
		const profile = channel === "stable" ? "release" : channel;
		const scheme = channel === "stable" ? "ryu" : `ryu-${channel}`;
		const config = applyProfileIdentity(
			{ plugins: { updater: { pubkey: "keep" } } },
			channel
		);
		assert.equal(
			config.identifier,
			profile === "release"
				? "ai.amajor.ryu.desktop"
				: `ai.amajor.ryu.desktop.${profile}`
		);
		assert.deepEqual(config.plugins["deep-link"].desktop.schemes, [scheme]);
		assert.equal(config.plugins.updater.pubkey, "keep");
	}
});

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const TABLE = JSON.parse(
	readFileSync(join(REPO, "apps/desktop/src/lib/release-channels.json"), "utf8")
);

test("channelOfVersion reads the first prerelease identifier", () => {
	// Mirrors channel_of_reads_the_first_prerelease_identifier in Core.
	assert.equal(channelOfVersion("0.0.13"), "stable");
	assert.equal(channelOfVersion("v0.0.13"), "stable");
	assert.equal(channelOfVersion("0.0.13-beta.1"), "beta");
	assert.equal(channelOfVersion("0.0.13-nightly.20260728.932"), "nightly");
	assert.equal(channelOfVersion("0.0.13-canary.20260728.932"), "canary");
	// Unparseable falls back to stable rather than inventing a channel.
	assert.equal(channelOfVersion("garbage"), "stable");
	assert.equal(channelOfVersion(null), "stable");
	assert.equal(channelOfVersion(""), "stable");
});

test("build metadata never names the channel", () => {
	// Semver §10: `+build` is not precedence-bearing, and it is not a channel.
	assert.equal(channelOfVersion("0.1.4+ci.42"), "stable");
	assert.equal(channelOfVersion("0.1.4-nightly.3+ci.42"), "nightly");
});

test("every shipping channel has a brand label", () => {
	for (const channel of ["stable", "beta", "canary", "nightly", "dev"]) {
		assert.ok(TABLE[channel]?.label, `no label for "${channel}"`);
		assert.match(
			TABLE[channel].tile,
			/^#[\da-f]{6}$/i,
			`bad tile colour for "${channel}"`
		);
	}
	// The current stable train ships as Research Preview — the one label that is
	// NOT just a Title-Cased channel id, and the reason `labelFor` reads a table
	// rather than deriving the name.
	assert.equal(labelFor("stable", TABLE), "Research Preview");
	assert.equal(labelFor("nightly", TABLE), "Nightly");
});

test("an unknown channel still announces itself", () => {
	// A future prerelease id must not silently read as stable.
	assert.equal(labelFor("rc", TABLE), "Rc");
});

test("branding never installs a CLI from the registry", () => {
	const source = readFileSync(join(HERE, "channel-brand.mjs"), "utf8");
	assert.doesNotMatch(source, /\bnpx\b/);
	assert.match(source, /--no-install/);
});

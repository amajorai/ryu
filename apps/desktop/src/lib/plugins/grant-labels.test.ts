// apps/desktop/src/lib/plugins/grant-labels.test.ts
//
// Tests for the permission-grant humanizer shown in the app enable-consent
// dialog and the per-app permissions view. Load-bearing behaviours: known grants
// map to their curated plain-English label/description (so a user approving
// `hook:run-agent` reads "Run AI agents", not the raw id); lookup is
// case-insensitive; and an UNKNOWN grant degrades gracefully — the label
// humanizes the identifier (splitting on `._:-/`, capitalizing) rather than
// leaking a raw token, while the description returns null so the caller can fall
// back to the raw id as a tooltip. Pure module, no DOM.

import { describe, expect, it } from "bun:test";
import { grantDescription, grantLabel } from "./grant-labels.ts";

describe("grantLabel — known grants", () => {
	it("maps host-bridge capabilities to their curated labels", () => {
		expect(grantLabel("hook:run-agent")).toBe("Run AI agents");
		expect(grantLabel("hook:side-model")).toBe("Use AI models");
		expect(grantLabel("spaces:docs")).toBe("Manage its Space documents");
		expect(grantLabel("storage:kv")).toBe("Store app data on this device");
	});

	it("is case-insensitive on the identifier", () => {
		expect(grantLabel("HOOK:RUN-AGENT")).toBe("Run AI agents");
		expect(grantLabel("Fs.Read")).toBe("Read your files");
	});

	it("maps the coarse OS-style grants", () => {
		expect(grantLabel("fs")).toBe("Access your files");
		expect(grantLabel("net")).toBe("Access the internet");
		expect(grantLabel("net.fetch")).toBe("Access the internet");
		expect(grantLabel("clipboard")).toBe("Use the clipboard");
		expect(grantLabel("shell")).toBe("Run commands on your computer");
	});
});

describe("grantLabel — unknown grants humanize gracefully", () => {
	it("splits on separators and capitalizes the first word", () => {
		expect(grantLabel("foo:bar")).toBe("Foo bar");
		expect(grantLabel("some_new-grant/here")).toBe("Some new grant here");
	});

	it("collapses runs of mixed separators into single spaces", () => {
		expect(grantLabel("a.__:-/b")).toBe("A b");
	});

	it("returns the raw identifier when it is only separators (nothing to humanize)", () => {
		expect(grantLabel(":._-/")).toBe(":._-/");
	});

	it("does not lowercase the remainder of a word (only the first char is forced up)", () => {
		// "myGrant" has no separators → words === "myGrant"; charAt(0) upper + rest.
		expect(grantLabel("myGrant")).toBe("MyGrant");
	});
});

describe("grantDescription", () => {
	it("returns the curated one-liner for a known grant", () => {
		expect(grantDescription("hook:run-agent")).toBe(
			"Start a tool-using agent that can act with your connected tools and data."
		);
		expect(grantDescription("SHELL")).toBe(
			"Execute shell commands on this device."
		);
	});

	it("returns null for an unknown grant so the caller can fall back to the raw id", () => {
		expect(grantDescription("foo:bar")).toBeNull();
		expect(grantDescription("")).toBeNull();
	});
});

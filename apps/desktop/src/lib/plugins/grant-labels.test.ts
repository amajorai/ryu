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

	it("maps the app-capability grants that ship today", () => {
		// Regression guard for a whole class of dead entry. `grantLabel` lowercases
		// the grant before the lookup but the table's keys are used verbatim, and
		// the keys must be the FULL grant string — a bare `warmup` key never
		// matches the `warmup:crud` grant that is actually issued. Both mistakes
		// were live here: every one of these rendered as the humanizer's fallback
		// ("Widget render", "Warmup crud", "Chat sendFollowUp") in the consent
		// dialog, which is exactly what the curated table exists to prevent.
		expect(grantLabel("widget:render")).toBe("Show interactive cards in chat");
		expect(grantLabel("warmup:crud")).toBe("Schedule keep-alive pings");
		expect(grantLabel("subscriptions:read")).toBe(
			"See your subscription accounts"
		);
		// Labels are often email addresses; consent must say so.
		expect(grantDescription("subscriptions:read")).toContain("email");
		expect(grantLabel("calendar:crud")).toBe("Access your calendar");
		expect(grantLabel("chat.sendFollowUp")).toBe("Send follow-up messages");
		expect(grantLabel("notifications:send-to-user")).toBe(
			"Notify organization members"
		);
	});

	it("labels the reviewed tool-plane grant instead of humanizing it", () => {
		// `tools.invoke` is on the Gateway's default allowlist and held by shipped
		// apps (Monitors, Dashboards, UGC, Social, Sites). Without an entry it
		// rendered as the fallback "Tools invoke", which says nothing about tool
		// runs or credit spend.
		expect(grantLabel("tools.invoke")).toBe("Use your connected tools");
		expect(grantLabel("TOOLS.INVOKE")).toBe("Use your connected tools");
		expect(grantDescription("tools.invoke")).toBe(
			"Run tools connected to Ryu and request work from Ryu-managed providers. Paid provider requests can use your Ryu credits."
		);
	});

	it("maps the coarse OS-style grants", () => {
		expect(grantLabel("fs")).toBe("Access your files");
		expect(grantLabel("net")).toBe("Access the internet");
		expect(grantLabel("net.fetch")).toBe("Access the internet");
		expect(grantLabel("clipboard")).toBe("Use the clipboard");
		expect(grantLabel("shell")).toBe("Run commands on your device");
	});
});

describe("grantLabel — unknown grants humanize gracefully", () => {
	it("humanizes identifiers that match inherited object properties", () => {
		expect(grantLabel("constructor")).toBe("Constructor");
		expect(grantLabel("__proto__")).toBe("Proto");
		expect(grantDescription("constructor")).toBeNull();
		expect(grantDescription("__proto__")).toBeNull();
	});

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
			"Start a read-only tool-using agent that can look at your connected tools and data."
		);
		expect(grantDescription("SHELL")).toBe(
			"Execute shell commands on this device."
		);
		expect(grantDescription("notifications:send-to-user")).toBe(
			"Deliver Inbox notifications to people in your organization or team."
		);
	});

	it("returns null for an unknown grant so the caller can fall back to the raw id", () => {
		expect(grantDescription("foo:bar")).toBeNull();
		expect(grantDescription("")).toBeNull();
	});
});

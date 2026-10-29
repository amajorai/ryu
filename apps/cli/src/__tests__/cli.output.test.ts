// Unit tests for the pure output helpers (cli/output.ts): the column-table
// formatter, the ellipsis truncator, and the typed-lifecycle-error renderers. These
// are exercised indirectly by the dispatcher tests, but the boundary cases (ragged
// rows, the truncate ellipsis threshold, non-Error thrown values, the lifecycle
// shape defaults) live here so a regression names the exact helper.

import { expect, test } from "bun:test";
import { ApiError } from "@ryuhq/core-client/client";
import { MFA_ENROLLMENT_REQUIRED_CODE } from "@ryuhq/core-client/mfa-enrollment";
import { localize, renderLocalized } from "../cli/localizedText.ts";
import {
	errorToJson,
	formatError,
	formatTable,
	truncate,
} from "../cli/output.ts";
import { UsageError } from "../cli/types.ts";
import { FRONTEND_URL } from "../core/waitlist.ts";
import { createCliTranslator } from "../i18n/translate.ts";

// ── formatTable ───────────────────────────────────────────────────────────────

test("formatTable pads each column to its widest cell and trims trailing space", () => {
	const out = formatTable(
		["ID", "NAME"],
		[
			["a", "Alpha"],
			["bb", "B"],
		]
	);
	const lines = out.split("\n");
	expect(lines).toHaveLength(3);
	// Header: "ID" padded to width 2 (max of "ID"/"a"/"bb"), two spaces, "NAME".
	expect(lines[0]).toBe("ID  NAME");
	expect(lines[1]).toBe("a   Alpha");
	// Trailing padding on the last column is trimmed (no spaces after "B").
	expect(lines[2]).toBe("bb  B");
});

test("formatTable header width grows to fit a header wider than any cell", () => {
	const out = formatTable(["LONGHEADER", "X"], [["a", "b"]]);
	const [header, row] = out.split("\n");
	expect(header).toBe("LONGHEADER  X");
	// "a" padded to the 10-char header width, then the second column.
	expect(row).toBe("a           b");
});

test("formatTable handles a ragged row (missing cell treated as empty)", () => {
	// A row shorter than the header must not throw; the absent cell pads to width 0
	// and the trailing empty is trimmed away.
	const out = formatTable(["A", "B"], [["only"]]);
	const [header, row] = out.split("\n");
	expect(header).toBe("A     B");
	expect(row).toBe("only");
});

test("formatTable aligns double-width (CJK) cells by terminal columns", () => {
	const out = formatTable(
		["NAME", "ID"],
		[
			["日本語", "a"],
			["x", "bb"],
		]
	);
	// "日本語" is three characters but six columns wide, so ID starts at column 8.
	expect(out.split("\n")).toEqual(["NAME    ID", "日本語  a", "x       bb"]);
});

test("formatTable with no rows emits just the header line", () => {
	expect(formatTable(["A", "B"], [])).toBe("A  B");
});

// ── truncate ──────────────────────────────────────────────────────────────────

test("truncate leaves a string at or under the limit untouched", () => {
	expect(truncate("hello", 5)).toBe("hello");
	expect(truncate("hi", 10)).toBe("hi");
});

test("truncate replaces the overflow with an ellipsis, keeping max-1 chars + …", () => {
	// "abcdef" (len 6) at max 5 → first 4 chars + ellipsis = "abcd…" (len 5).
	const t = truncate("abcdef", 5);
	expect(t).toBe("abcd…");
	expect(t).toHaveLength(5);
});

test("truncate boundary: a string exactly at the limit is not truncated", () => {
	expect(truncate("abcde", 5)).toBe("abcde");
	// One over the limit triggers truncation.
	expect(truncate("abcdef", 5).endsWith("…")).toBe(true);
});

// ── formatError ─────────────────────────────────────────────────────────────

test("formatError returns a plain Error's message", () => {
	expect(formatError(new Error("boom"))).toBe("boom");
});

test("formatError stringifies a non-Error thrown value", () => {
	expect(formatError("just a string")).toBe("just a string");
	expect(formatError(42)).toBe("42");
	expect(formatError(null)).toBe("null");
});

test("formatError appends a lifecycle hint in parentheses when present", () => {
	const err = Object.assign(new Error("Cannot disable Meetings."), {
		gatewayUnreachable: false,
		hint: "pass --cascade",
	});
	expect(formatError(err)).toBe("Cannot disable Meetings. (pass --cascade)");
});

test("formatError omits the parenthetical when a lifecycle error has no hint", () => {
	const err = Object.assign(new Error("Blocked."), {
		grantsDenied: true,
	});
	expect(formatError(err)).toBe("Blocked.");
});

// ── errorToJson ─────────────────────────────────────────────────────────────

test("errorToJson emits a flat {error} for a plain Error", () => {
	expect(errorToJson(new Error("nope"))).toEqual({ error: "nope" });
});

test("errorToJson stringifies a non-Error into {error}", () => {
	expect(errorToJson("raw")).toEqual({ error: "raw" });
});

test("errorToJson expands the full lifecycle shape with defaults", () => {
	const err = Object.assign(new Error("dep block"), {
		dependencyError: {
			code: "blocked_by_dependents",
			plugin: "whiteboard",
			dependents: ["meetings"],
		},
		hint: "pass --cascade",
	});
	// Only dependencyError + hint were set; the three booleans default.
	expect(errorToJson(err)).toEqual({
		error: "dep block",
		dependencyError: {
			code: "blocked_by_dependents",
			plugin: "whiteboard",
			dependents: ["meetings"],
		},
		gatewayUnreachable: false,
		grantsDenied: false,
		builtIn: false,
		hint: "pass --cascade",
	});
});

test("errorToJson defaults a lifecycle error's optional fields to null/false", () => {
	// The `builtIn` marker alone is enough to trigger the lifecycle branch; every
	// other field must fill its documented default rather than leak `undefined`.
	const err = Object.assign(new Error("built-in"), { builtIn: true });
	const json = errorToJson(err);
	expect(json.error).toBe("built-in");
	expect(json.builtIn).toBe(true);
	expect(json.dependencyError).toBeNull();
	expect(json.gatewayUnreachable).toBe(false);
	expect(json.grantsDenied).toBe(false);
	expect(json.hint).toBeNull();
});

// ── second-factor enrollment refusal ─────────────────────────────────────────

const SETUP_URL = `${FRONTEND_URL.replace(/\/+$/, "")}/settings/setup-2fa`;

/** What request() throws when the control plane refuses an unenrolled account. */
function enrollmentRefusal(): ApiError {
	return new ApiError(
		"/api/auth/get-session",
		403,
		"Two-factor authentication is required",
		MFA_ENROLLMENT_REQUIRED_CODE
	);
}

test("formatError explains the second-factor refusal in one paragraph with the setup page", () => {
	const message = formatError(enrollmentRefusal());
	expect(message).toContain("passkey or an authenticator app");
	expect(message).toContain("Email codes don't count.");
	expect(message).toContain(
		`Set one up at ${SETUP_URL}, then run this command again.`
	);
	expect(message).not.toContain("failed: 403");
	expect(message).not.toContain("\n");
});

test("errorToJson tags the second-factor refusal with its code and setup URL", () => {
	expect(errorToJson(enrollmentRefusal())).toEqual({
		code: "mfa_enrollment_required",
		error: formatError(enrollmentRefusal()),
		setupUrl: SETUP_URL,
	});
});

test("a 403 with another code keeps the plain error rendering", () => {
	const forbidden = new ApiError("/api/teams", 403, "Forbidden", "forbidden");
	expect(formatError(forbidden)).toBe("/api/teams failed: 403");
	expect(errorToJson(forbidden)).toEqual({ error: "/api/teams failed: 403" });
});
// ── Organization access missing from the sign-in ─────────────────────────────

test("formatError and errorToJson explain a sign-in without the node's organization", () => {
	const refused = new ApiError(
		"/api/agents",
		403,
		"Your sign-in does not include access to the organization this node belongs to.",
		"org_access_not_in_session"
	);
	expect(formatError(refused)).toContain(
		"ryu-cli secrets confirm CODE --method totp"
	);
	expect(errorToJson(refused)).toEqual({
		code: "org_access_not_in_session",
		error: "/api/agents failed: 403",
		hint: expect.stringContaining("ryu-cli login"),
	});
	// A plain 403 is unchanged.
	expect(formatError(new ApiError("/api/agents", 403))).toBe(
		"/api/agents failed: 403"
	);
	// A control-plane refusal Core passed through reads as its fix too.
	const notAdmitted = new ApiError(
		"/api/vault/export",
		401,
		"Unauthorized",
		"user_jwt_org_not_admitted"
	);
	expect(formatError(notAdmitted)).toContain(
		"ryu-cli secrets confirm CODE --method totp"
	);
	expect(errorToJson(notAdmitted)).toEqual({
		code: "user_jwt_org_not_admitted",
		error: "/api/vault/export failed: 401",
		hint: expect.stringContaining("two-factor"),
	});
});

test("a localized error renders in the CLI locale but stays English under --json", () => {
	const { tf: germanTf } = createCliTranslator("de", {
		"Unknown --kind '{kind}'. Expected one of: app, plugin, all.":
			"Unbekannte --kind '{kind}'. Erwartet: app, plugin, all.",
	});
	const error = new UsageError(
		localize("Unknown --kind '{kind}'. Expected one of: app, plugin, all.", {
			kind: "x",
		})
	);
	expect(error.message).toBe(
		"Unknown --kind 'x'. Expected one of: app, plugin, all."
	);
	const localized = error.localized;
	expect(localized).not.toBeNull();
	if (localized) {
		expect(renderLocalized(localized, germanTf)).toBe(
			"Unbekannte --kind 'x'. Erwartet: app, plugin, all."
		);
	}
	expect(errorToJson(error)).toEqual({
		error: "Unknown --kind 'x'. Expected one of: app, plugin, all.",
	});
});

test("localized values nest, keeping each part English for machines", () => {
	const { tf: germanTf } = createCliTranslator("de", {
		"Missing {name}. Usage: {usage}": "{name} fehlt. Aufruf: {usage}",
		"app or plugin id": "App- oder Plugin-ID",
	});
	const text = localize("Missing {name}. Usage: {usage}", {
		name: localize("app or plugin id"),
		usage: "ryu-cli add <id>",
	});
	expect(text.english).toBe(
		"Missing app or plugin id. Usage: ryu-cli add <id>"
	);
	expect(renderLocalized(text, germanTf)).toBe(
		"App- oder Plugin-ID fehlt. Aufruf: ryu-cli add <id>"
	);
	expect(formatError(new UsageError(text))).toBe(text.english);
});

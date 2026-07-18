// packages/core-client/src/plugins.test.ts
//
// Tests for the CLI-command path-safety guard. `isSafeCommandPath` is the shared
// predicate BOTH the manifest→AppInfo mapper (`toAppCommands`, which drops unsafe
// commands so the dispatcher can never see them) AND the TUI's `execAppCommand`
// (which refuses to build a request URL from one) rely on. It mirrors Core's
// `validate_cli_command_path` (`crates/ryu-kernel-contracts`). A command path is
// concatenated onto `/api/ext/<appId>` and fetched, and the URL parser normalizes
// `..` (incl. `%2e` / backslash forms) BEFORE the request is sent — a traversal
// path would escape the plugin's proxy scope and hit an arbitrary internal route
// with the full node bearer. These vectors keep that closed.

import { expect, test } from "bun:test";
import { isSafeCommandPath } from "./plugins.ts";

test("isSafeCommandPath accepts plain absolute sub-paths", () => {
	for (const ok of ["/status", "/inboxes/send", "/a-b_c/1", "/x?y=1", "/"]) {
		expect(isSafeCommandPath(ok)).toBe(true);
	}
});

test("isSafeCommandPath rejects path-traversal and escape forms", () => {
	for (const bad of [
		"/../../../v1/chat/completions",
		"/../api/plugins/com.ryu.mail/uninstall",
		"/foo/../../bar",
		"/%2e%2e/%2e%2e/v1",
		"/foo/%2E%2E/bar",
		"/..\\..\\v1",
		"/foo%2fbar",
		"/foo%5cbar",
		"status", // not absolute
		"", // empty
	]) {
		expect(isSafeCommandPath(bad)).toBe(false);
	}
});

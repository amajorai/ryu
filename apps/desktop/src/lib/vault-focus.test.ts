import { beforeEach, expect, test } from "bun:test";
import {
	clearVaultFocus,
	getVaultFocus,
	requestVaultFocus,
} from "./vault-focus.ts";

beforeEach(() => {
	clearVaultFocus();
});

test("each request replaces the last and is distinguishable when repeated", () => {
	const first = requestVaultFocus({ tab: "broker", proposalId: "prop_a" });
	const again = requestVaultFocus({ tab: "broker", proposalId: "prop_a" });
	expect(again.seq).toBeGreaterThan(first.seq);
	expect(getVaultFocus()).toBe(again);
});

test("an unknown tab falls back to Secrets, and clearing drops the request", () => {
	expect(requestVaultFocus({ tab: "nope" }).tab).toBe("secrets");
	expect(getVaultFocus()?.proposalId).toBeNull();
	clearVaultFocus();
	expect(getVaultFocus()).toBeNull();
});

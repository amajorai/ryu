import { beforeEach, expect, test } from "bun:test";
import { clearVaultFocus, getVaultFocus } from "../vault-focus.ts";
import {
	openNotificationLink,
	parseNotificationLink,
} from "./notification-link.ts";

beforeEach(() => {
	clearVaultFocus();
});

test("a broker proposal link opens the Vault Broker tab on that proposal", () => {
	const opened: { path: string; title?: string }[] = [];
	const ok = openNotificationLink(
		"/vault?tab=broker&proposal=prop_0123abc",
		(path, opts) => {
			opened.push({ path, title: opts?.title });
		}
	);
	expect(ok).toBe(true);
	expect(opened).toEqual([{ path: "/vault", title: "Vault" }]);
	expect(getVaultFocus()).toMatchObject({
		tab: "broker",
		proposalId: "prop_0123abc",
	});
});

test("a plain Vault link opens the Secrets tab without a highlight", () => {
	parseNotificationLink("/vault")?.prepare();
	expect(getVaultFocus()).toMatchObject({ tab: "secrets", proposalId: null });
});

test("links outside the allowlist open nothing", () => {
	const refused = [
		null,
		undefined,
		"",
		"vault",
		"//evil.example/vault",
		"https://evil.example/vault",
		"javascript:alert(1)",
		"/settings",
		"/vault?tab=admin",
		"/vault?tab=broker&proposal=../../x",
		"/vault?tab=broker&proposal=a%20b",
		"/vault#tab=broker",
		"/vault/../settings",
	];
	for (const link of refused) {
		let opened = false;
		expect(
			openNotificationLink(link, () => {
				opened = true;
			})
		).toBe(false);
		expect(opened).toBe(false);
	}
	expect(getVaultFocus()).toBeNull();
});

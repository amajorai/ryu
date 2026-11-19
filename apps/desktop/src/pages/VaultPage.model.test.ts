import { describe, expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
import { vaultSecretListCaption } from "./VaultPage.model.ts";

const sources: string[] = [];
const tl: LiteralMessage = (source, values) => {
	sources.push(source);
	return formatMessage(source, values);
};

describe("vaultSecretListCaption", () => {
	test("names the caller inside one catalog sentence", () => {
		sources.length = 0;
		expect(vaultSecretListCaption(tl, "user-42")).toBe(
			"Showing the scopes available to user-42. Select a secret to see its details and history."
		);
		expect(sources).toEqual([
			"Showing the scopes available to {userId}. Select a secret to see its details and history.",
		]);
	});

	test("explains node-local metadata when no caller is signed in", () => {
		expect(vaultSecretListCaption(tl, null)).toBe(
			"Showing node-local metadata. Sign in to a managed node to see user, team, or organization scopes."
		);
	});
});

test("the Policies tab is a vault tab", async () => {
	const { vaultTab } = await import("./VaultPage.model.ts");
	expect(vaultTab("policies")).toBe("policies");
	expect(vaultTab("nope")).toBe("secrets");
});

test("the Machines tab is a vault tab", async () => {
	const { vaultTab } = await import("./VaultPage.model.ts");
	expect(vaultTab("machines")).toBe("machines");
});

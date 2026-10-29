import path from "node:path";
import { expect, test } from "@playwright/test";
import type { EncryptionProofState } from "./harness/gateway-encryption-settings-proof.mock.ts";

declare global {
	interface Window {
		__ENCRYPTION_PROOF__?: EncryptionProofState;
	}
}

// Verification runs set RYU_PROOF_OUTPUT_ROOT so screenshots land in scratch
// space instead of rewriting the tracked sweep evidence.
const evidence = (name: string) =>
	process.env.RYU_PROOF_OUTPUT_ROOT
		? path.resolve(process.env.RYU_PROOF_OUTPUT_ROOT, name)
		: path.resolve(
				import.meta.dirname,
				"../../../docs/proof/test-coverage-sweep-20260924/evidence",
				name
			);

test.beforeEach(async ({ page }) => {
	await page.goto("/gateway-encryption-settings-proof.html");
	await expect(
		page.getByRole("heading", { name: "Encryption", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "What's encrypted on this device" })
	).toBeVisible();
});

test("reports keychain custody and per-store encryption coverage from Core", async ({
	page,
}) => {
	await expect(
		page.getByText("System keychain", { exact: true })
	).toBeVisible();
	await expect(page.getByText("com.ryu.dev/master-key-dev")).toBeVisible();
	await expect(
		page.getByText("/Users/proof/.ryu-dev", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Encrypted", { exact: true }).first()
	).toBeVisible();
	await expect(
		page.getByText("Partly encrypted", { exact: true })
	).toBeVisible();
	await expect(page.getByText("3 of 4 stored items encrypted")).toBeVisible();
	await expect(page.getByText("Not encrypted", { exact: true })).toBeVisible();
	const requests = await page.evaluate(
		() => window.__ENCRYPTION_PROOF__?.requests
	);
	expect(requests).toHaveLength(1);
	expect(requests?.[0]).toMatchObject({
		authorization: "Bearer encryption-proof-token",
		method: "GET",
		url: "http://encryption.test:7980/api/encryption/status",
	});
	await page.screenshot({
		path: evidence("gateway-encryption-keychain-and-coverage.png"),
		fullPage: true,
	});
});

test("refreshes the visible per-store counts from the latest Core response", async ({
	page,
}) => {
	await page.evaluate(() => {
		const state = window.__ENCRYPTION_PROOF__;
		if (!state) {
			throw new Error("Encryption fixtures were not installed");
		}
		state.nextStatus = structuredClone(state.status);
		state.nextStatus.stores[1] = {
			...state.nextStatus.stores[1]!,
			sealed: 4,
			status: "partial",
			total: 5,
		};
	});
	await page.getByRole("button", { name: "Refresh" }).click();
	await expect(page.getByText("4 of 5 stored items encrypted")).toBeVisible();
	await expect(
		page.getByText("2 of 3 areas are still stored without encryption.")
	).toBeVisible();
	const requests = await page.evaluate(
		() => window.__ENCRYPTION_PROOF__?.requests
	);
	expect(requests).toHaveLength(2);
	await page.screenshot({
		path: evidence("gateway-encryption-refreshed.png"),
		fullPage: true,
	});
});

test("explains environment key custody without exposing key material", async ({
	page,
}) => {
	await page.goto("/gateway-encryption-settings-proof.html?source=env");
	await expect(
		page.getByText("Environment variable", { exact: true })
	).toBeVisible();
	await expect(page.getByText("RYU_MASTER_KEY", { exact: true })).toBeVisible();
	await expect(
		page.getByText("The key is injected by whoever starts this node", {
			exact: false,
		})
	).toBeVisible();
	await expect(page.getByText("master-key-dev", { exact: true })).toHaveCount(
		0
	);
	await expect(page.getByText("master.key", { exact: true })).toHaveCount(0);
	await page.screenshot({
		path: evidence("gateway-encryption-environment-key.png"),
		fullPage: true,
	});
});

test("warns when the fallback key shares the data folder and marks legacy residue", async ({
	page,
}) => {
	await page.goto("/gateway-encryption-settings-proof.html?source=file");
	await expect(
		page.getByText("Key file in the data folder", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Stored with your data", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("/Users/proof/.ryu-dev/master.key")
	).toBeVisible();
	await expect(
		page.getByText("Older memory.key still in the data folder")
	).toBeVisible();
	await expect(page.getByText("3 of 4 stored items encrypted")).toBeVisible();
	await page.screenshot({
		path: evidence("gateway-encryption-file-fallback-warning.png"),
		fullPage: true,
	});
});

test("shows an explicit error and retry when Core cannot return encryption status", async ({
	page,
}) => {
	await page.goto("/gateway-encryption-settings-proof.html?failOnce");
	await expect(
		page.getByText("We couldn't read this node's encryption state.")
	).toBeVisible();
	await expect(
		page.getByText("This node cannot load its encryption key")
	).toHaveCount(0);
	await page.getByRole("button", { name: "Retry" }).click();
	await expect(
		page.getByText("System keychain", { exact: true })
	).toBeVisible();
	const requests = await page.evaluate(
		() => window.__ENCRYPTION_PROOF__?.requests
	);
	expect(requests).toHaveLength(2);
	await page.screenshot({
		path: evidence("gateway-encryption-retry-recovered.png"),
		fullPage: true,
	});
});

test("distinguishes an unavailable key from an unreachable Core", async ({
	page,
}) => {
	await page.goto("/gateway-encryption-settings-proof.html?source=unavailable");
	await expect(
		page.getByText("This node cannot load its encryption key")
	).toBeVisible();
	await expect(
		page.getByText("The master key could not be resolved.")
	).toBeVisible();
	await expect(
		page.getByText("We couldn't read this node's encryption state.")
	).toHaveCount(0);
	await expect(page.getByText("System keychain", { exact: true })).toHaveCount(
		0
	);
	await expect(page.getByText("Chats", { exact: true })).toHaveCount(0);
});

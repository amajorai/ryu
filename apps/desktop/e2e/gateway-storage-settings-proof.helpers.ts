import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { z } from "zod";
import type {
	GatewayStorageProgress,
	GatewayStorageState,
} from "./harness/gateway-storage-settings-proof.mock.ts";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for gateway-storage-settings-proof.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger; without it the committed evidence is refreshed.
export const evidence = (name: string) =>
	path.resolve(
		process.env.RYU_PROOF_EVIDENCE_DIR ??
			proofEvidencePath("test-coverage-sweep-20260924/evidence"),
		name
	);
export const RestoreCaptureSchema = z.object({
	backupId: z.string().optional(),
});
export const IdempotencyCaptureSchema = z.object({
	idempotencyKey: z.string(),
});

declare global {
	interface Window {
		__emitGatewayStorageProgress?: (payload: GatewayStorageProgress) => void;
		__GATEWAY_STORAGE_PROOF__?: GatewayStorageState;
	}
}

export type ProofSnapshot = Pick<
	GatewayStorageState,
	| "apiCalls"
	| "fetchCalls"
	| "dataPath"
	| "destinations"
	| "dialogCalls"
	| "operations"
	| "policies"
	| "records"
	| "tauriCalls"
>;

export async function snapshot(page: Page): Promise<ProofSnapshot> {
	return page.evaluate(() => {
		const state = window.__GATEWAY_STORAGE_PROOF__;
		if (!state) {
			throw new Error("Gateway Storage proof fixtures were not installed");
		}
		return {
			apiCalls: state.apiCalls,
			fetchCalls: state.fetchCalls,
			dataPath: state.dataPath,
			destinations: state.destinations,
			dialogCalls: state.dialogCalls,
			operations: state.operations,
			policies: state.policies,
			records: state.records,
			tauriCalls: state.tauriCalls,
		};
	});
}

export async function setFailure(
	page: Page,
	key: string,
	message: string,
	remaining = 1,
	status = 500
): Promise<void> {
	await page.evaluate(
		({ failureKey, failureMessage, count, statusCode }) => {
			const state = window.__GATEWAY_STORAGE_PROOF__;
			if (!state) {
				throw new Error("Gateway Storage proof fixtures were not installed");
			}
			state.failures[failureKey] = {
				message: failureMessage,
				remaining: count,
				status: statusCode,
			};
		},
		{
			failureKey: key,
			failureMessage: message,
			count: remaining,
			statusCode: status,
		}
	);
}

export async function addDestination(
	page: Page,
	name = "Nightly archive"
): Promise<void> {
	await page.getByRole("button", { name: "Add destination" }).click();
	await expect(
		page.getByRole("heading", { name: "Add S3 destination" })
	).toBeVisible();
	await page.getByLabel("Destination name").fill(name);
	await page.getByLabel("Provider").selectOption("aws");
	await page.getByLabel("Bucket").fill("ryu-proof-backups");
	await page.getByLabel("Object prefix").fill("proof/nightly");
	await page.getByLabel("Access key ID").fill("AKIA-PROOF");
	await page.getByLabel("Secret access key").fill("proof-secret-access-key");
	await page.getByLabel("Session token (optional)").fill("proof-session-token");
	await page
		.getByLabel("Apps allowed to use this destination")
		.fill("@ryu/canvas, com.example.notes");
	await page.getByRole("button", { name: "Generate key" }).click();
	await expect(page.getByRole("textbox", { name: "Recovery key" })).toHaveValue(
		"proof-recovery-key-32-characters"
	);
	await page
		.getByRole("checkbox", { name: "I have saved my recovery key" })
		.check();
	await page
		.getByRole("checkbox", { name: "Use path-style requests" })
		.uncheck();
	await page
		.getByRole("checkbox", {
			name: "Allow HTTP for a trusted private S3 server",
		})
		.check();
	await page.getByRole("button", { name: "Validate & save" }).click();
	await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Add S3 destination" })
	).toHaveCount(0);
}

export const EXPORT_PASSPHRASE = "correct horse battery";

/** Export… asks for the backup passphrase twice before the save dialog. */
export async function startEncryptedExport(page: Page) {
	await page.getByRole("button", { name: "Export…" }).click();
	await page.getByLabel("Backup passphrase").fill(EXPORT_PASSPHRASE);
	await page.getByLabel("Confirm passphrase").fill(EXPORT_PASSPHRASE);
	await page.getByRole("button", { name: "Choose location…" }).click();
}

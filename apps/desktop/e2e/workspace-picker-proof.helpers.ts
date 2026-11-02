import { expect, type Page } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";
import {
	decodeWorkspaceRequests,
	isExactWorkspaceTrigger,
	type WorkspaceFixtureRequest,
} from "./workspace-picker-proof.contracts.ts";

// Fixtures and helpers for workspace-picker-proof.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

export const STORY_URL = "/workspace-picker-proof.html";
export const EVIDENCE_DIR = `${proofEvidencePath("test-coverage-sweep-20260924/evidence")}/`;
export const HOME_PATH = "/fixture/home";
export const PROJECTS_PATH = `${HOME_PATH}/Projects`;
export const ALPHA_PATH = `${PROJECTS_PATH}/alpha`;
export const BETA_PATH = `${PROJECTS_PATH}/beta`;
export const CREATED_FOLDER_PATH = `${HOME_PATH}/Documents/Ryu/Fresh Project`;
export const CLONED_FOLDER_PATH = `${HOME_PATH}/Documents/Ryu/agent-runtime`;
export const REQUESTS_KEY = "proof:workspace-picker:requests";

declare global {
	interface Window {
		__workspacePickerProof?: {
			releaseBranches: () => void;
			releaseHomeListing: () => void;
		};
	}
}

export async function openPage(
	page: Page,
	options: { cloud?: boolean; folder?: "alpha"; variant?: "stacked" } = {}
) {
	const query = new URLSearchParams({ reset: "1" });
	if (options.folder) {
		query.set("folder", options.folder);
	}
	if (options.variant) {
		query.set("variant", options.variant);
	}
	if (options.cloud) {
		query.set("cloud", "1");
	}
	await page.setViewportSize({ height: 980, width: 1440 });
	await page.goto(`${STORY_URL}?${query.toString()}`);
	await expect(page.getByTestId("workspace-picker-proof")).toBeVisible();
}

export async function requests(page: Page): Promise<WorkspaceFixtureRequest[]> {
	const raw = await page.evaluate(
		(key) => localStorage.getItem(key),
		REQUESTS_KEY
	);
	return raw ? decodeWorkspaceRequests(raw) : [];
}

export async function storedValue(page: Page, key: string) {
	return page.evaluate((storageKey) => localStorage.getItem(storageKey), key);
}

export async function openMenu(page: Page, triggerName: string | RegExp) {
	const trigger = page.getByRole("button", {
		name: triggerName,
		exact: isExactWorkspaceTrigger(triggerName),
	});
	await trigger.click();
	const menu = page.getByRole("menu").last();
	await expect(menu).toBeVisible();
	return { menu, trigger };
}

/** Project, run-location and branch controls open command dialogs. */
export async function openPicker(page: Page, triggerName: string | RegExp) {
	const trigger = page.getByRole("button", {
		name: triggerName,
		exact: isExactWorkspaceTrigger(triggerName),
	});
	await trigger.click();
	const menu = page.getByRole("dialog").last();
	await expect(menu).toBeVisible();
	return { menu, trigger };
}

export function apiRequests(
	items: WorkspaceFixtureRequest[],
	method: string,
	path: string
): WorkspaceFixtureRequest[] {
	return items.filter((item) => item.method === method && item.path === path);
}

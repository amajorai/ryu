import type { Page } from "@playwright/test";

// Network mock and seeded local state for settings-sync-proof.spec.ts.

const SYNC_API = "**/api/desktop-settings-sync**";
export const REMOTE_UPDATED_AT = Date.now();
const remoteConflicts = [
	{ key: "theme", value: "light", updatedAt: REMOTE_UPDATED_AT },
	{
		key: "ryu_dark_preset",
		value: "cloud-night",
		updatedAt: REMOTE_UPDATED_AT,
	},
];

export interface SyncApiMock {
	delayNextPull(milliseconds: number): void;
	readonly deleteCalls: number;
	readonly deleteRequests: {
		authorization: string | null;
		method: string;
		url: string;
	}[];
	failNextDelete(): void;
	failNextPull(): void;
	failNextPush(): void;
	readonly pullCalls: number;
	readonly pushBodies: string[];
	readonly pushRequests: {
		authorization: string | null;
		body: string;
		method: string;
		url: string;
	}[];
	resetConflicts(): void;
}

export async function installSyncApiMock(page: Page): Promise<SyncApiMock> {
	let pullCalls = 0;
	let deleteCalls = 0;
	let conflictPulls = 0;
	let failPull = false;
	let failDelete = false;
	let failPush = false;
	let pullDelay = 0;
	const pushBodies: string[] = [];
	const pushRequests: SyncApiMock["pushRequests"] = [];
	const deleteRequests: SyncApiMock["deleteRequests"] = [];
	const remoteEntries = new Map<
		string,
		{ deleted?: boolean; key: string; updatedAt: number; value: string | null }
	>();
	let revision = 0;
	let remoteUpdatedAt = 0;

	await page.route(SYNC_API, async (route) => {
		const request = route.request();
		const { pathname } = new URL(request.url());

		if (pathname.endsWith("/pull")) {
			pullCalls++;
			if (pullDelay > 0) {
				const delay = pullDelay;
				pullDelay = 0;
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
			if (failPull) {
				failPull = false;
				await route.fulfill({ status: 503, body: "offline" });
				return;
			}
			const hasConflict =
				new URL(page.url()).searchParams.get("scenario") === "conflict";
			const responseEntries =
				hasConflict && conflictPulls++ === 0 ? remoteConflicts : [];
			if (responseEntries.length > 0) {
				for (const entry of responseEntries) {
					remoteEntries.set(entry.key, entry);
				}
				remoteUpdatedAt = Math.max(
					remoteUpdatedAt,
					...responseEntries.map((entry) => entry.updatedAt)
				);
				revision++;
			}
			await route.fulfill({
				json: {
					entries: responseEntries,
					revision,
					updatedAt: remoteUpdatedAt || 1,
				},
			});
			return;
		}

		if (pathname.endsWith("/push")) {
			const body = request.postData() ?? "{}";
			pushBodies.push(body);
			pushRequests.push({
				authorization: request.headers().authorization ?? null,
				body,
				method: request.method(),
				url: request.url(),
			});
			if (failPush) {
				failPush = false;
				await route.fulfill({ status: 503, body: "offline" });
				return;
			}
			// SAFETY: The mounted SettingsSync proof runs the real engine collectDirty and pushSettings JSON serializer: string keys, native string/null values, boolean deleted, and timestamps from this spec's finite seeds or Date.now. This route reads its captured POST body; forged requests or foreign nonfinite metadata are outside this controlled fixture.
			const payload = JSON.parse(body) as {
				entries?: {
					deleted?: boolean;
					key: string;
					updatedAt: number;
					value: string | null;
				}[];
			};
			const applied: string[] = [];
			const rejected: {
				deleted?: boolean;
				key: string;
				updatedAt: number;
				value: string | null;
			}[] = [];
			for (const entry of payload.entries ?? []) {
				const current = remoteEntries.get(entry.key);
				if (current && current.updatedAt > entry.updatedAt) {
					rejected.push(current);
					continue;
				}
				if (!current || current.updatedAt < entry.updatedAt) {
					remoteEntries.set(entry.key, entry);
					applied.push(entry.key);
				}
			}
			remoteUpdatedAt = Math.max(
				remoteUpdatedAt,
				...(payload.entries ?? []).map((entry) => entry.updatedAt),
				1
			);
			await route.fulfill({
				json: {
					applied,
					rejected,
					revision: ++revision,
					updatedAt: remoteUpdatedAt,
				},
			});
			return;
		}

		if (
			request.method() === "DELETE" &&
			pathname.endsWith("/desktop-settings-sync")
		) {
			deleteCalls++;
			deleteRequests.push({
				authorization: request.headers().authorization ?? null,
				method: request.method(),
				url: request.url(),
			});
			if (failDelete) {
				failDelete = false;
				await route.fulfill({ status: 503, body: "offline" });
				return;
			}
			await route.fulfill({ status: 204, body: "" });
			return;
		}

		await route.continue();
	});

	return {
		get deleteCalls() {
			return deleteCalls;
		},
		get pullCalls() {
			return pullCalls;
		},
		get pushBodies() {
			return pushBodies;
		},
		get pushRequests() {
			return pushRequests;
		},
		get deleteRequests() {
			return deleteRequests;
		},
		failNextDelete() {
			failDelete = true;
		},
		failNextPush() {
			failPush = true;
		},
		failNextPull() {
			failPull = true;
		},
		delayNextPull(milliseconds) {
			pullDelay = milliseconds;
		},
		resetConflicts() {
			conflictPulls = 0;
			remoteEntries.clear();
			remoteUpdatedAt = 0;
		},
	};
}

export async function seedSettingsState(
	page: Page,
	options: { enabled?: boolean; conflict?: boolean; pending?: boolean } = {}
) {
	await page.addInitScript(({ enabled, conflict, pending }) => {
		localStorage.clear();
		localStorage.setItem("ryu_session_token", "settings-sync-fixture-token");
		// Settings sync acts only for a verified account: the live bearer must be
		// the active vault account's own token. The seeded state below is that
		// account's (the visible-owner record names it, as on any store this
		// build wrote); a store without the record is a pre-scoping one, whose
		// stamps are no one's pending work.
		localStorage.setItem(
			"ryu_accounts",
			JSON.stringify([
				{
					email: "settings-sync@example.invalid",
					image: null,
					name: "Settings Sync",
					token: "settings-sync-fixture-token",
					userId: "settings-sync-fixture-user",
				},
			])
		);
		localStorage.setItem("ryu_active_user_id", "settings-sync-fixture-user");
		localStorage.setItem(
			"ryu:settings-sync-visible-owner",
			"settings-sync-fixture-user"
		);
		localStorage.setItem("ryu_workspace_path", "/private/workspace");
		localStorage.setItem("ryu:node-config", "fixture-node-settings");
		localStorage.setItem(
			"ryu:settings-sync-enabled",
			enabled ? "true" : "false"
		);
		localStorage.setItem("ryu:settings-sync-policy", "ask");
		localStorage.setItem("ryu:settings-sync-cursor", "0");
		localStorage.setItem("theme", "dark");
		localStorage.setItem("ryu_ui_font", "Inter");
		if (conflict) {
			const changedAt = Date.now() - 10_000;
			localStorage.setItem("ryu_dark_preset", "local-night");
			localStorage.setItem(
				"ryu:settings-sync-meta",
				JSON.stringify({ theme: changedAt, ryu_dark_preset: changedAt })
			);
		} else if (pending) {
			localStorage.setItem(
				"ryu:settings-sync-meta",
				JSON.stringify({
					theme: 10,
					ryu_ui_font: 11,
					ryu_session_token: 12,
					ryu_workspace_path: 13,
					"ryu:node-config": 14,
				})
			);
		}
	}, options);
}

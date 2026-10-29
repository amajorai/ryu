// Reload a window whose features hold another account's settings in memory.
//
// Features keep synced settings in memory in many shapes (zustand stores read
// at module load, React state, refs) and write them back whole. When the
// visible settings pass to another account, in this window or another one of
// the app, every such copy in this document belongs to the previous account,
// and the settings observer drops their writes from then on (see
// `isStaleWindowWrite`). Reloading is what loads the new account's values into
// every feature at once, the same thing the account switcher already does in
// the window it runs in. It waits for the account write that caused the change
// (the durable vault copy), so the reload never leaves that copy naming the
// previous account.

import { accountWritesSettled } from "@/lib/account-transition.ts";
import {
	isSettingsWindowStale,
	SETTINGS_OWNER_CHANGED_EVENT,
} from "./local-store.ts";

function reloadDocument(): void {
	window.location.reload();
}

/** Reload this window once its settings owner changes. Returns a disposer. */
export function reloadWhenSettingsOwnerChanges(
	reload: () => void = reloadDocument
): () => void {
	let scheduled = false;
	const schedule = () => {
		if (scheduled) {
			return;
		}
		scheduled = true;
		// After the announcing task: the account write that announced the change
		// registers itself synchronously in that task.
		setTimeout(() => {
			accountWritesSettled().then(reload, reload);
		}, 0);
	};
	window.addEventListener(SETTINGS_OWNER_CHANGED_EVENT, schedule);
	if (isSettingsWindowStale()) {
		schedule();
	}
	return () => {
		window.removeEventListener(SETTINGS_OWNER_CHANGED_EVENT, schedule);
	};
}

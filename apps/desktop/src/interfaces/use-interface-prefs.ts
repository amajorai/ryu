// The user's interface preferences. "Hide work details" redacts every
// interface snapshot (as streaming privacy does), so a shared screen shows
// kinds and counts but no thread text.

import { create } from "zustand";

export const HIDE_WORK_DETAILS_KEY = "ryu:interface-hide-work-details";

function readHideWorkDetails(): boolean {
	try {
		return (
			typeof localStorage !== "undefined" &&
			localStorage.getItem(HIDE_WORK_DETAILS_KEY) === "1"
		);
	} catch {
		return false;
	}
}

function writeHideWorkDetails(value: boolean): void {
	try {
		if (value) {
			localStorage.setItem(HIDE_WORK_DETAILS_KEY, "1");
		} else {
			localStorage.removeItem(HIDE_WORK_DETAILS_KEY);
		}
	} catch {
		// Storage unavailable: the choice still holds for this session.
	}
}

export interface InterfacePrefsState {
	hideWorkDetails: boolean;
	setHideWorkDetails: (value: boolean) => void;
}

/** A fresh store reading the persisted choice; exported for tests. */
export function createInterfacePrefsStore() {
	return create<InterfacePrefsState>((set) => ({
		hideWorkDetails: readHideWorkDetails(),
		setHideWorkDetails: (value) => {
			writeHideWorkDetails(value);
			set({ hideWorkDetails: value });
		},
	}));
}

export const useInterfacePrefs = createInterfacePrefsStore();

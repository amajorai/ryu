import { useEffect, useState } from "react";
import type { CommunityViewMode } from "./community-model.ts";

const MINUTE = 60_000;
const VIEW_KEY = "ryu.interfaces.community.view";

export function useMinuteClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), MINUTE);
		return () => window.clearInterval(timer);
	}, []);
	return now;
}

export function readViewMode(): CommunityViewMode {
	try {
		return window.localStorage.getItem(VIEW_KEY) === "compact"
			? "compact"
			: "card";
	} catch {
		return "card";
	}
}

export function writeViewMode(mode: CommunityViewMode) {
	try {
		window.localStorage.setItem(VIEW_KEY, mode);
	} catch {
		// Storage can be blocked; the choice still holds for this session.
	}
}

/** True for targets whose keys belong to typing, menus, tabs, or the host's chat. */
export function ownsKeys(target: EventTarget): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement ||
		target.closest("[role='menu']") !== null ||
		target.closest("[role='tablist']") !== null ||
		target.closest("[data-testid='community-thread-view']") !== null
	);
}

export const STEP_KEYS: Record<string, number> = {
	ArrowDown: 1,
	ArrowUp: -1,
	j: 1,
	k: -1,
};

export interface EmptyCopy {
	action: { label: string; onClick: () => void } | null;
	body: string;
	title: string;
}

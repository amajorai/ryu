import { useEffect, useState } from "react";

const MINUTE = 60_000;

export function useMinuteClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), MINUTE);
		return () => window.clearInterval(timer);
	}, []);
	return now;
}

/** True for targets whose keys belong to typing, menus, or the host's chat. */
export function ownsKeys(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement ||
		target.closest("[role='menu']") !== null ||
		target.closest("[role='slider']") !== null ||
		target.closest("[data-testid='forum-thread-view']") !== null ||
		target.closest("[data-testid='forum-composer']") !== null
	);
}

export const STEP_KEYS: Record<string, number> = {
	ArrowDown: 1,
	ArrowUp: -1,
	j: 1,
	k: -1,
};

export interface ComposerState {
	minimized: boolean;
	open: boolean;
}

export const CLOSED_COMPOSER: ComposerState = { minimized: false, open: false };

/** True for targets whose keys belong to typing or to the host's chat. */
export function ownsKeys(target: EventTarget): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement ||
		target.closest("[data-testid='desk-thread-view']") !== null
	);
}

/** True when no element holds focus, so page-level keys belong to the desk. */
export function isPageTarget(target: EventTarget | null): boolean {
	return (
		target === null ||
		target === document ||
		target === document.body ||
		target === document.documentElement
	);
}

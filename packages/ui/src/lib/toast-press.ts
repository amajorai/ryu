// Toasts render outside every dialog, so Base UI reads a press on one as an
// "outside press" and dismisses the open dialog — expanding an error toast, or
// pressing its action, would throw away the dialog the error is about. Toasts
// are app chrome, never a request to leave the dialog.

/** The anchor `Toaster` renders its viewports inside. */
export const TOASTER_SLOT = "toaster";

interface DismissDetails {
	cancel: () => void;
	event: Event;
	reason: string;
}

/** Cancel a dismissal whose outside press started on a toast. Returns whether
 *  it did, so the caller skips its own close handling. */
export function cancelToastDismissal(open: boolean, details: DismissDetails) {
	if (open || details.reason !== "outside-press") {
		return false;
	}
	const target = details.event.target;
	if (
		!(target instanceof Element) ||
		target.closest(`[data-slot="${TOASTER_SLOT}"]`) === null
	) {
		return false;
	}
	details.cancel();
	return true;
}

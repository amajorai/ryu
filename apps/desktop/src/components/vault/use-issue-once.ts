// Issuing a credential Core returns exactly once (a secret id or a machine
// token). The value lives only in this hook's state, never React Query's
// cache. The owner is told while a request is in flight and while a value is
// on screen, so the dialog neither closes mid-request nor drops a value
// without asking. After Done, focus returns to the button that issued it.

import { useEffect, useRef, useState } from "react";

export interface IssueState {
	/** A request is in flight: Core may be minting a credential. */
	issuing: boolean;
	/** A value is on screen and has not been dismissed. */
	showing: boolean;
}

export const IDLE: IssueState = { issuing: false, showing: false };

export function useIssueOnce(onStateChange: (state: IssueState) => void) {
	const [issued, setIssued] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [refocus, setRefocus] = useState(false);
	const submitRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (refocus && issued === null) {
			submitRef.current?.focus();
			setRefocus(false);
		}
	}, [refocus, issued]);

	/** Run `request`; its value is shown once. `false` when it failed. */
	const run = async (
		request: () => Promise<string>,
		onError: (error: unknown) => void
	): Promise<boolean> => {
		setPending(true);
		onStateChange({ issuing: true, showing: false });
		try {
			const value = await request();
			setIssued(value);
			onStateChange({ issuing: false, showing: true });
			return true;
		} catch (error) {
			onError(error);
			onStateChange(IDLE);
			return false;
		} finally {
			setPending(false);
		}
	};

	/** Drop the value and return focus to the issue button. */
	const done = () => {
		setIssued(null);
		setRefocus(true);
		onStateChange(IDLE);
	};

	return { done, issued, pending, run, submitRef };
}

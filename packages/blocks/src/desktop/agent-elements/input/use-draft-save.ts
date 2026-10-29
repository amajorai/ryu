import { useCallback, useRef, useState } from "react";

/** Keep unsaved text and edits made while persistence is in flight. */
export function useDraftSave(
	input: string,
	setInput: (text: string) => void,
	onSave?: (text: string) => Promise<void> | void
) {
	const latestInput = useRef(input);
	latestInput.current = input;
	const pending = useRef(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const save = useCallback(async () => {
		if (!onSave || pending.current || !input.trim()) {
			return;
		}
		pending.current = true;
		setSaving(true);
		setError(null);
		try {
			await onSave(input);
			if (latestInput.current === input) {
				setInput("");
			}
		} catch {
			setError("Could not save draft. Your text is still available to retry.");
		} finally {
			pending.current = false;
			setSaving(false);
		}
	}, [input, onSave, setInput]);
	return { error, save, saving };
}

// Prompt Studio: keep a late durable-suite load from overwriting the user's
// own prompt edit.

import { useCallback, useEffect, useRef } from "react";

/**
 * The durable suite loads asynchronously and carries its own copy of the
 * prompt. Applying that copy is right only while the user has not touched the
 * draft: an edit made in the moments before the suite arrives must win.
 *
 * `noteEditorValue` takes every value the editor reports (selection changes
 * re-report the same text); only a changed prompt counts as an edit. A new
 * agent starts clean.
 */
export function usePromptLoadGuard(
	agentId: string | null,
	value: string,
	onChange: (value: string) => void
): {
	applyLoadedPrompt: (loaded: string) => void;
	noteEditorValue: (next: string) => void;
} {
	const editedRef = useRef(false);
	const baselineRef = useRef(value);
	const agentRef = useRef(agentId);
	if (agentRef.current !== agentId) {
		agentRef.current = agentId;
		editedRef.current = false;
		baselineRef.current = value;
	}
	useEffect(() => {
		if (!editedRef.current) {
			baselineRef.current = value;
		}
	}, [value]);

	const noteEditorValue = useCallback((next: string) => {
		if (next.trim() !== baselineRef.current.trim()) {
			editedRef.current = true;
		}
	}, []);
	const applyLoadedPrompt = useCallback(
		(loaded: string) => {
			if (editedRef.current) {
				return;
			}
			baselineRef.current = loaded;
			onChange(loaded);
		},
		[onChange]
	);
	return { applyLoadedPrompt, noteEditorValue };
}

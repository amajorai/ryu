// apps/desktop/src/components/settings/DictationSettings-prefs.ts
//
// Loads the `dictation` and Speech Processing preference blobs for the Dictation
// settings page and serializes their writes (with a retry for a failed save).

import { useCallback, useEffect, useRef, useState } from "react";
import { useActiveTargetGetter } from "@/src/hooks/useActiveNode.ts";
import {
	DEFAULT_DICTATION_PREFS,
	DEFAULT_SPEECH_PROCESSING_PREFS,
	type DictationPrefs,
	getDictationPrefs,
	getSpeechProcessingPrefs,
	type SpeechProcessingPrefs,
	setDictationPrefs,
	setSpeechProcessingPrefs,
} from "@/src/lib/api/preferences.ts";
import type {
	DictationPrefsUpdate,
	SpeechProcessingPrefsUpdate,
} from "./DictationSettings-options.ts";

export function useDictationSettingsPrefs() {
	const getTarget = useActiveTargetGetter();
	const [prefs, setPrefs] = useState<DictationPrefs>(DEFAULT_DICTATION_PREFS);
	const [speechPrefs, setSpeechPrefs] = useState<SpeechProcessingPrefs>(
		DEFAULT_SPEECH_PROCESSING_PREFS
	);
	const [loadingPrefs, setLoadingPrefs] = useState(true);
	const [loadError, setLoadError] = useState(false);
	const [loadAttempt, setLoadAttempt] = useState(0);
	const [saveError, setSaveError] = useState<"dictation" | "speech" | null>(
		null
	);
	const dictationPrefsRef = useRef(prefs);
	const speechPrefsRef = useRef(speechPrefs);
	const dictationWriteQueue = useRef(Promise.resolve());
	const speechWriteQueue = useRef(Promise.resolve());

	useEffect(() => {
		let cancelled = false;
		setLoadingPrefs(true);
		setLoadError(false);
		Promise.all([
			getDictationPrefs(getTarget()),
			getSpeechProcessingPrefs(getTarget()),
		])
			.then(([dictation, speechProcessing]) => {
				if (!cancelled) {
					dictationPrefsRef.current = dictation;
					speechPrefsRef.current = speechProcessing;
					setPrefs(dictation);
					setSpeechPrefs(speechProcessing);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setLoadError(true);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setLoadingPrefs(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [loadAttempt]);

	const writePrefs = useCallback((update: DictationPrefsUpdate) => {
		const withEnabled = { ...update(dictationPrefsRef.current), enabled: true };
		const target = getTarget();
		dictationPrefsRef.current = withEnabled;
		setPrefs(withEnabled);
		dictationWriteQueue.current = dictationWriteQueue.current
			.catch(() => undefined)
			.then(async () => {
				await setDictationPrefs(target, withEnabled);
				setSaveError((current) => (current === "dictation" ? null : current));
			})
			.catch(() => setSaveError("dictation"));
	}, []);

	const writeSpeechPrefs = useCallback(
		(update: SpeechProcessingPrefsUpdate) => {
			const next = update(speechPrefsRef.current);
			const target = getTarget();
			speechPrefsRef.current = next;
			setSpeechPrefs(next);
			speechWriteQueue.current = speechWriteQueue.current
				.catch(() => undefined)
				.then(async () => {
					await setSpeechProcessingPrefs(target, next);
					setSaveError((current) => (current === "speech" ? null : current));
				})
				.catch(() => setSaveError("speech"));
		},
		[]
	);

	const retryFailedSave = () => {
		if (saveError === "dictation") {
			const target = getTarget();
			dictationWriteQueue.current = dictationWriteQueue.current
				.catch(() => undefined)
				.then(async () => {
					await setDictationPrefs(target, dictationPrefsRef.current);
					setSaveError((current) => (current === "dictation" ? null : current));
				})
				.catch(() => setSaveError("dictation"));
			return;
		}
		if (saveError === "speech") {
			const target = getTarget();
			speechWriteQueue.current = speechWriteQueue.current
				.catch(() => undefined)
				.then(async () => {
					await setSpeechProcessingPrefs(target, speechPrefsRef.current);
					setSaveError((current) => (current === "speech" ? null : current));
				})
				.catch(() => setSaveError("speech"));
		}
	};

	return {
		prefs,
		speechPrefs,
		loadingPrefs,
		loadError,
		setLoadAttempt,
		saveError,
		writePrefs,
		writeSpeechPrefs,
		retryFailedSave,
	};
}

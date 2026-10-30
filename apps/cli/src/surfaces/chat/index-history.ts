// Chat prompt history: the Core-sealed history file, loaded per node and
// navigated synchronously from the composer's key handlers.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	coreHistorySealer,
	initialPromptHistory,
	loadAndMigratePromptHistory,
	mergeLoadedHistory,
	type PromptHistoryState,
} from "../../core/promptHistory.ts";
import type { ChatSurfaceContext } from "./index-context.ts";

type UseChatPromptHistoryDeps = Pick<ChatSurfaceContext, "coreDown" | "target">;

export function useChatPromptHistory(deps: UseChatPromptHistoryDeps) {
	const { coreDown, target } = deps;
	const [promptHistory, setPromptHistoryState] = useState(() =>
		initialPromptHistory()
	);
	// History navigation runs inside key handlers that also rewrite the
	// composer buffer, so it reads and writes this ref synchronously instead of
	// relying on a (possibly deferred) state updater.
	const promptHistoryRef = useRef(promptHistory);
	const updatePromptHistory = useCallback(
		(update: (state: PromptHistoryState) => PromptHistoryState) => {
			const next = update(promptHistoryRef.current);
			promptHistoryRef.current = next;
			setPromptHistoryState(next);
		},
		[]
	);
	// The history file is sealed by the local Core. Without a reachable Core
	// the history is kept in memory only and nothing is written.
	const historySealer = useMemo(
		() => (coreDown ? null : coreHistorySealer(target)),
		[coreDown, target]
	);
	// The node URL whose sealed history was loaded. Saves are allowed only for
	// that node: after a node switch the file is re-read through the new Core
	// (which may not hold the key) before anything is written back.
	const historyLoadedUrlRef = useRef<string | null>(null);
	const historyTargetUrl = target.url;
	useEffect(() => {
		if (!historySealer || historyLoadedUrlRef.current === historyTargetUrl) {
			return;
		}
		historyLoadedUrlRef.current = null;
		let cancelled = false;
		loadAndMigratePromptHistory(historySealer)
			.then((loaded) => {
				if (cancelled) {
					return;
				}
				historyLoadedUrlRef.current = historyTargetUrl;
				updatePromptHistory((current) => mergeLoadedHistory(loaded, current));
			})
			.catch(() => {
				// Core is unreachable or could not open the sealed file: stay
				// in memory-only mode and never save over the existing file. A
				// later Core reconnect retries the load.
			});
		return () => {
			cancelled = true;
		};
	}, [historySealer, historyTargetUrl, updatePromptHistory]);
	return {
		historyLoadedUrlRef,
		historySealer,
		historyTargetUrl,
		updatePromptHistory,
	};
}

// apps/desktop/src/hooks/useAutoThreadImport.ts
//
// Background auto-import of agents' own on-disk threads (Claude Code / Codex)
// into Ryu conversations — the "keep my agent threads in sync" companion to the
// manual Import dialog, gated by the `useAutoImportThreads` setting. When ON it
// periodically scans each history-supporting engine's native transcript store
// and imports any thread it hasn't imported yet, filing each under the workspace
// folder it ran in (Core stamps `folder_path` = the thread's cwd; we also
// register that folder as a project so it appears grouped in the sidebar even
// before it has other chats).
//
// How it stays "in sync" (VS Code-style): a scan runs on mount, on a fixed
// interval, and whenever the window regains focus, so newly created agent
// threads surface without a manual step. Import is idempotent end-to-end — Core
// dedups by the agent-native session id and we additionally remember which
// native thread ids we've already imported (localStorage) so a poll never
// re-POSTs a known thread. NOTE: this imports *new* threads; it does not yet
// re-sync new messages appended to an already-imported thread (that needs an
// "update import" path in Core) — a deliberate v1 boundary.

import { useEffect, useRef } from "react";
import { readAutoImportThreads } from "@/src/hooks/useAutoImportThreads.ts";
import { engineForAgent } from "@/src/lib/agent-logos.tsx";
import {
	importAgentThread,
	listAgentThreads,
} from "@/src/lib/api/agent-threads.ts";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";

/** Engines whose native history Core can read — used to avoid probing agents
 *  whose engine plainly keeps no importable local history. The list endpoint's
 *  `supported` flag remains the real authority. */
const HISTORY_ENGINE_HINT = /claude|codex/i;

/** How often to rescan for new agent threads while the setting is on. */
const POLL_INTERVAL_MS = 5 * 60 * 1000;

/** A window regains focus at most this often triggers a rescan (debounce). */
const FOCUS_DEBOUNCE_MS = 30 * 1000;

/** Safety cap on imports per scan so a first run over a large history store
 *  can't fire off an unbounded burst of POSTs. Remaining threads import on the
 *  next scan. */
const MAX_IMPORTS_PER_SCAN = 50;

const SEEN_KEY = "ryu:auto-imported-thread-ids";

function loadSeen(): Set<string> {
	try {
		const raw = localStorage.getItem(SEEN_KEY);
		if (!raw) {
			return new Set();
		}
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed)
			? new Set(parsed.filter((v) => typeof v === "string"))
			: new Set();
	} catch {
		return new Set();
	}
}

function saveSeen(seen: Set<string>) {
	try {
		localStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
	} catch {
		// best-effort; the Core-side dedup still prevents duplicate conversations
	}
}

/** First agent per engine, filtered to engines that plausibly keep history —
 *  threads are engine-relative, so importing under one agent per engine is
 *  enough (and avoids importing the same thread twice under sibling agents). */
function historyAgentsByEngine(agents: AgentSummary[]): AgentSummary[] {
	const byEngine = new Map<string, AgentSummary>();
	for (const agent of agents) {
		const engine = engineForAgent(agent) ?? agent.id;
		if (!HISTORY_ENGINE_HINT.test(engine)) {
			continue;
		}
		if (!byEngine.has(engine)) {
			byEngine.set(engine, agent);
		}
	}
	return [...byEngine.values()];
}

/**
 * Mount once (e.g. in the sidebar) to auto-import agent threads while the setting
 * is on. Renders nothing.
 *
 * @param onImported Called after a scan that imported at least one new thread,
 *   so the caller can refresh its conversation list to show them.
 */
export function useAutoThreadImport({
	agents,
	target,
	onImported,
}: {
	agents: AgentSummary[];
	target: ApiTarget;
	onImported?: () => void;
}) {
	const addProjectFolder = useWorkspaceStore((s) => s.addProjectFolder);
	// Latest values, read inside the timer/effect without re-arming it each render.
	const agentsRef = useRef(agents);
	agentsRef.current = agents;
	const targetRef = useRef(target);
	targetRef.current = target;
	const onImportedRef = useRef(onImported);
	onImportedRef.current = onImported;
	const addFolderRef = useRef(addProjectFolder);
	addFolderRef.current = addProjectFolder;

	// One scan at a time; a poll that fires mid-scan is skipped.
	const scanningRef = useRef(false);
	const lastFocusScanRef = useRef(0);

	useEffect(() => {
		let cancelled = false;

		const scan = async () => {
			if (cancelled || scanningRef.current || !readAutoImportThreads()) {
				return;
			}
			const candidates = historyAgentsByEngine(agentsRef.current);
			if (candidates.length === 0) {
				return;
			}
			scanningRef.current = true;
			const seen = loadSeen();
			let importedAny = false;
			let budget = MAX_IMPORTS_PER_SCAN;
			try {
				for (const agent of candidates) {
					if (cancelled || budget <= 0) {
						break;
					}
					let listing: Awaited<ReturnType<typeof listAgentThreads>>;
					try {
						listing = await listAgentThreads(targetRef.current, agent.id);
					} catch {
						continue;
					}
					if (!listing.supported) {
						continue;
					}
					for (const thread of listing.threads) {
						if (cancelled || budget <= 0) {
							break;
						}
						const key = `${listing.engine || agent.id}:${thread.id}`;
						if (seen.has(key)) {
							continue;
						}
						try {
							const result = await importAgentThread(
								targetRef.current,
								agent.id,
								thread.id
							);
							seen.add(key);
							budget -= 1;
							// Register the workspace folder so the imported chat groups
							// under it in the sidebar (Core also stamps folder_path).
							const cwd = result.cwd ?? thread.cwd;
							if (cwd) {
								addFolderRef.current(cwd);
							}
							if (!result.alreadyImported) {
								importedAny = true;
							}
						} catch {
							// Leave the key unseen so a later scan retries this thread.
						}
					}
				}
			} finally {
				saveSeen(seen);
				scanningRef.current = false;
				if (importedAny && !cancelled) {
					onImportedRef.current?.();
				}
			}
		};

		// Initial scan shortly after mount (let the app settle first).
		const startTimer = setTimeout(() => {
			scan().catch(() => undefined);
		}, 4000);
		const interval = setInterval(() => {
			scan().catch(() => undefined);
		}, POLL_INTERVAL_MS);
		const onFocus = () => {
			const now = Date.now();
			if (now - lastFocusScanRef.current < FOCUS_DEBOUNCE_MS) {
				return;
			}
			lastFocusScanRef.current = now;
			scan().catch(() => undefined);
		};
		window.addEventListener("focus", onFocus);

		return () => {
			cancelled = true;
			clearTimeout(startTimer);
			clearInterval(interval);
			window.removeEventListener("focus", onFocus);
		};
	}, []);
}

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

import { useEffect, useMemo, useRef } from "react";
import { readAutoImportThreads } from "@/src/hooks/useAutoImportThreads.ts";
import { agentSupportsHistoryHint } from "@/src/lib/agent-history.ts";
import { engineForAgent } from "@/src/lib/agent-logos.tsx";
import { listAgentSyncProfiles } from "@/src/lib/api/agent-sync.ts";
import {
	importAgentThread,
	listAgentThreads,
} from "@/src/lib/api/agent-threads.ts";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import {
	autoImportSeenKey,
	loadAutoImportSeen,
	saveAutoImportSeen,
} from "@/src/lib/auto-import-seen.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";

/** How often to rescan for new agent threads while the setting is on. */
const POLL_INTERVAL_MS = 5 * 60 * 1000;

/** A window regains focus at most this often triggers a rescan (debounce). */
const FOCUS_DEBOUNCE_MS = 30 * 1000;

/** Safety cap on imports per scan so a first run over a large history store
 *  can't fire off an unbounded burst of POSTs. Remaining threads import on the
 *  next scan. */
const MAX_IMPORTS_PER_SCAN = 50;

const SEEN_KEY = "ryu:auto-imported-thread-ids";

/** First agent per engine, filtered to engines that plausibly keep history —
 *  threads are engine-relative, so importing under one agent per engine is
 *  enough (and avoids importing the same thread twice under sibling agents). */
function historyAgentsByEngine(agents: AgentSummary[]): AgentSummary[] {
	const byEngine = new Map<string, AgentSummary>();
	for (const agent of agents) {
		const engine = engineForAgent(agent) ?? agent.id;
		if (!agentSupportsHistoryHint(agent)) {
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
	const authority = useMemo(
		() => ({
			target: {
				url: target.url.replace(/\/$/, ""),
				token: target.token ?? null,
				userJwt: target.userJwt ?? null,
			},
		}),
		[
			target.url.replace(/\/$/, ""),
			target.token ?? null,
			target.userJwt ?? null,
		]
	);
	const authorityRef = useRef(authority);
	authorityRef.current = authority;
	const memorySeen = useRef(new Map<string, Set<string>>());
	const onImportedRef = useRef(onImported);
	onImportedRef.current = onImported;
	const addFolderRef = useRef(addProjectFolder);
	addFolderRef.current = addProjectFolder;

	// One scan at a time; a poll that fires mid-scan is skipped.

	useEffect(() => {
		let cancelled = false;
		let scanning = false;
		let lastFocusScan = 0;
		const capturedTarget = authority.target;
		const ownsAuthority = () =>
			!cancelled &&
			authorityRef.current === authority &&
			readAutoImportThreads();
		const memoryKey = JSON.stringify([
			capturedTarget.url,
			capturedTarget.token,
			capturedTarget.userJwt,
		]);
		const fallbackSeen = memorySeen.current.get(memoryKey) ?? new Set<string>();
		memorySeen.current.set(memoryKey, fallbackSeen);
		let seenKey: string | null = null;

		const scan = async () => {
			if (!ownsAuthority() || scanning || !readAutoImportThreads()) {
				return;
			}
			const historyAgents = historyAgentsByEngine(agentsRef.current);
			if (historyAgents.length === 0) {
				return;
			}
			// Own the entire scan, including the slow profile lookup, before yielding.
			scanning = true;
			let seen: Set<string> | undefined;
			let importedAny = false;
			let budget = MAX_IMPORTS_PER_SCAN;
			try {
				const managedEngines = new Set<string>();
				try {
					const profiles = (await listAgentSyncProfiles(capturedTarget))
						.profiles;
					for (const profile of profiles) {
						if (profile.importEnabled) {
							managedEngines.add(profile.provider);
						}
					}
				} catch {
					// The legacy scheduler remains the safe fallback while Core is offline.
				}
				const candidates = historyAgents.filter((agent) => {
					const engine = (engineForAgent(agent) ?? agent.id)
						.replace(/^acp:/i, "")
						.toLowerCase();
					return !managedEngines.has(engine);
				});
				if (!ownsAuthority() || candidates.length === 0) {
					return;
				}
				seenKey = await autoImportSeenKey(SEEN_KEY, capturedTarget);
				if (!ownsAuthority()) return;
				seen = loadAutoImportSeen(seenKey, fallbackSeen);
				for (const agent of candidates) {
					if (!ownsAuthority() || budget <= 0) {
						break;
					}
					let listing: Awaited<ReturnType<typeof listAgentThreads>>;
					try {
						listing = await listAgentThreads(capturedTarget, agent.id);
					} catch {
						continue;
					}
					if (!ownsAuthority()) return;
					if (!listing.supported) {
						continue;
					}
					for (const thread of listing.threads) {
						if (!ownsAuthority() || budget <= 0) {
							break;
						}
						const key = `${listing.engine || agent.id}:${thread.id}`;
						if (seen.has(key)) {
							continue;
						}
						try {
							const result = await importAgentThread(
								capturedTarget,
								agent.id,
								thread.id
							);
							if (!ownsAuthority()) return;
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
				if (seen && ownsAuthority()) {
					saveAutoImportSeen(seenKey, seen, fallbackSeen);
				}
				scanning = false;
				if (importedAny && ownsAuthority()) {
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
			if (now - lastFocusScan < FOCUS_DEBOUNCE_MS) {
				return;
			}
			lastFocusScan = now;
			scan().catch(() => undefined);
		};
		window.addEventListener("focus", onFocus);

		return () => {
			cancelled = true;
			clearTimeout(startTimer);
			clearInterval(interval);
			window.removeEventListener("focus", onFocus);
		};
	}, [authority]);
}

// apps/desktop/src/hooks/useAutoSetupImport.ts
//
// Background auto-import of agent *setup* from the well-known agent config roots
// (`~/.claude`, `~/.cursor`, `~/.codex`), gated by the `ryu:auto-import-agent-setup`
// setting. The manual companion is `ImportSetupDialog`; this is the "keep my
// imported setup in sync" equivalent of `useAutoThreadImport` (threads).
//
// Deliberately conservative: only `instructions` items are auto-imported — a
// snapshot of the folder's AGENTS.md/CLAUDE.md that is additive and reversible
// (it overwrites the same preferences key each time). Skills are NOT auto-
// activated, and MCP servers / plugins / memories are NOT auto-imported: those
// spawn processes or enable plugins, so they stay behind the explicit review in
// the manual dialog. A scan runs on mount, on a fixed interval, and when the
// window regains focus.

import { useEffect, useMemo, useRef } from "react";
import { readAutoSetupImportSetting } from "@/src/hooks/useAutoSetupImportSetting.ts";
import { listAgentSyncProfiles } from "@/src/lib/api/agent-sync.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { runImport, scanImportFolder } from "@/src/lib/api/import.ts";
import { listDirectory } from "@/src/lib/api/workspace.ts";
import {
	autoImportSeenKey,
	loadAutoImportSeen,
	saveAutoImportSeen,
} from "@/src/lib/auto-import-seen.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";

/** Agent config roots auto-scanned when the setting is on. */
const AGENT_CONFIG_ROOTS = [".claude", ".cursor", ".codex"];

/** How often to rescan while the setting is on. */
const POLL_INTERVAL_MS = 5 * 60 * 1000;

/** A window regains focus at most this often triggers a rescan (debounce). */
const FOCUS_DEBOUNCE_MS = 30 * 1000;

/** Safety cap on imports per scan so a first run can't burst. */
const MAX_IMPORTS_PER_SCAN = 20;

const SEEN_KEY = "ryu:auto-imported-setup-ids";

/**
 * Mount once (e.g. in the sidebar) to auto-import setup instructions while the
 * setting is on. Renders nothing.
 */
export function useAutoSetupImport({
	target,
	onImported,
}: {
	target: ApiTarget;
	/** Called after a scan that registered at least one new project folder. */
	onImported?: () => void;
}) {
	const addProjectFolder = useWorkspaceStore((s) => s.addProjectFolder);
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
			readAutoSetupImportSetting();
		const memoryKey = JSON.stringify([
			capturedTarget.url,
			capturedTarget.token,
			capturedTarget.userJwt,
		]);
		const fallbackSeen = memorySeen.current.get(memoryKey) ?? new Set<string>();
		memorySeen.current.set(memoryKey, fallbackSeen);
		let seenKey: string | null = null;

		const scan = async () => {
			if (!ownsAuthority() || scanning || !readAutoSetupImportSetting()) {
				return;
			}
			scanning = true;
			let seen: Set<string> | undefined;
			let budget = MAX_IMPORTS_PER_SCAN;
			let importedAny = false;
			try {
				// Once a root is managed by the shared Core sync ledger, the legacy
				// localStorage scheduler must stand down. Otherwise both schedulers
				// would race the same setup item even though Core eventually dedups it.
				const managedRoots = new Set(
					(
						await listAgentSyncProfiles(capturedTarget).catch(() => ({
							profiles: [],
						}))
					).profiles
						.filter((profile) => profile.importEnabled)
						.map((profile) => profile.root)
				);
				if (!ownsAuthority()) {
					return;
				}
				seenKey = await autoImportSeenKey(SEEN_KEY, capturedTarget);
				if (!ownsAuthority()) {
					return;
				}
				seen = loadAutoImportSeen(seenKey, fallbackSeen);
				let home: string;
				try {
					const listing = await listDirectory(capturedTarget);
					home = listing.home;
				} catch {
					return;
				}
				if (!ownsAuthority()) {
					return;
				}
				const sep = home.includes("\\") ? "\\" : "/";
				for (const root of AGENT_CONFIG_ROOTS) {
					if (!ownsAuthority() || budget <= 0) {
						break;
					}
					const rootPath = `${home}${sep}${root}`;
					if (managedRoots.has(rootPath)) {
						continue;
					}
					let scan: Awaited<ReturnType<typeof scanImportFolder>>;
					try {
						scan = await scanImportFolder(capturedTarget, rootPath);
					} catch {
						// The root may not exist (no Claude/Cursor/Codex install) —
						// degrade to nothing, never error.
						continue;
					}
					if (!ownsAuthority()) {
						return;
					}
					const instructions = scan.items.filter(
						(i) => i.kind === "instructions"
					);
					if (instructions.length === 0) {
						continue;
					}
					const toImport = instructions
						.filter(
							(i) =>
								!(
									i.contentRevision &&
									seen?.has(
										`${JSON.stringify([rootPath, i.id])}:${i.contentRevision}`
									)
								)
						)
						.slice(0, budget);
					if (toImport.length === 0) {
						continue;
					}
					try {
						const result = await runImport(
							capturedTarget,
							rootPath,
							toImport.map((i) => ({ kind: i.kind, id: i.id }))
						);
						if (!ownsAuthority()) {
							return;
						}
						budget -= toImport.length;
						for (const r of result.results) {
							if (r.status !== "imported" && r.status !== "skipped") {
								continue;
							}
							const item = toImport.find(
								(candidate) =>
									candidate.id === r.id && candidate.kind === r.kind
							);
							if (!item) {
								continue;
							}
							if (r.contentRevision) {
								const prefix = `${JSON.stringify([rootPath, item.id])}:`;
								// Only the last acknowledged revision can suppress a scan:
								// reverting edited bytes must refresh the imported snapshot too.
								for (const prior of seen) {
									if (prior.startsWith(prefix)) {
										seen.delete(prior);
									}
								}
								for (const prior of fallbackSeen) {
									if (prior.startsWith(prefix)) {
										fallbackSeen.delete(prior);
									}
								}
								seen.add(`${prefix}${r.contentRevision}`);
							}
							if (r.folderPath) {
								addFolderRef.current(r.folderPath);
								importedAny = true;
							}
						}
					} catch {
						// Leave the ids unseen so a later scan retries.
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

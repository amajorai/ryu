// apps/desktop/src/hooks/useComposerDraftAutosave.ts
//
// Keep composer text that was never sent.
//
// The composer's text lives in `AgentChat`'s own state, so closing the tab (or the
// app) destroys it. That is fine for a stray keystroke and infuriating for a
// paragraph you spent five minutes on. This hook mirrors the text into the
// `@ryu/drafts` outbox, keyed on the conversation, so it comes back in the sidebar
// instead of disappearing.
//
// Three properties this has to get right, all of them about NOT being annoying:
//
//  1. One draft per conversation, not one per typing pause. The draft id is derived
//     from the conversation, so every save edits the same row.
//  2. Clearing the composer deletes the draft. The sidecar treats a blank upsert as
//     a delete, so sending a message (which clears the text) removes the draft
//     without a second call — and without a race where the delete lands before the
//     send.
//  3. Nothing is written until the text is worth keeping: the app must be enabled,
//     autosave must be on, and the text must clear `autosave_min_chars`.

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppShellPath } from "@/src/contributions/app-shell-routes.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	DRAFTS_BUTTON_ID,
	DRAFTS_PLUGIN_ID,
	getDraft,
	getDraftsSettings,
	saveDraft,
} from "@/src/lib/api/drafts.ts";
import { useActiveNode } from "./useActiveNode.ts";

/** How long the composer must be idle before the text is written. Long enough that
 *  ordinary typing produces one write per thought rather than one per word. */
const DEBOUNCE_MS = 1500;

/** Settings are re-read at most this often. They change when a user toggles a
 *  switch on the Drafts page, which is rare; re-reading per keystroke would be a
 *  request storm for a value that is almost always the same. */
const SETTINGS_TTL_MS = 60_000;

/**
 * The draft id for one conversation's composer.
 *
 * One stable id per conversation, so every save EDITS that row rather than leaving a
 * trail of one draft per typing pause. Characters outside `[a-zA-Z0-9_-]` are
 * stripped because the sidecar refuses ids with separators — they are primary keys
 * and path segments.
 *
 * Exported because the auto-queue path in `ChatPage` arms the SAME row: a queued
 * send and the autosave of the text it came from are one draft, not two.
 */
export function draftIdFor(conversationId?: string): string {
	const key = (conversationId ?? "launchpad").replace(/[^a-zA-Z0-9_-]/g, "");
	return `composer_${key}`.slice(0, 64);
}

export interface ComposerDraftContext {
	agentId?: string;
	/** The conversation being typed into. A tab with no conversation yet still
	 *  autosaves — under its provisional id — because the launchpad is exactly
	 *  where a long unsent prompt gets abandoned. */
	conversationId?: string;
	folderPath?: string;
	model?: string;
	/** Temporary chats must not write to or restore from the durable outbox. */
	persist?: boolean;
}

interface PendingDraftWrite {
	context: ComposerDraftContext;
	draft: string;
	ids: string[];
	version: number;
}

/**
 * Whether this composer keeps drafts: the Drafts app is on and the chat is not
 * temporary.
 *
 * The Drafts lookup is a hook, so it runs on every render whatever `persist` says.
 * Short-circuiting it (`persist !== false && useAppShellPath(...)`) skips it while a
 * chat is temporary, which changes the page's hook order the moment "Temporary chat"
 * is turned on and crashes the page.
 */
export function useComposerDraftsEnabled(
	context: ComposerDraftContext
): boolean {
	const draftsAppEnabled =
		useAppShellPath(DRAFTS_PLUGIN_ID, DRAFTS_BUTTON_ID) !== null;
	return context.persist !== false && draftsAppEnabled;
}

/**
 * Returns the `onDraftChange` handler to hand to `AgentChat`.
 *
 * A no-op that still returns a stable callback when the app is disabled, so the
 * consumer never has to branch.
 */
export function useComposerDraftAutosave(
	context: ComposerDraftContext
): (draft: string) => void {
	const node = useActiveNode();
	const enabled = useComposerDraftsEnabled(context);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const settings = useRef<{ at: number; enabled: boolean; min: number } | null>(
		null
	);
	const pending = useRef<PendingDraftWrite | null>(null);
	const lastDraftId = useRef(draftIdFor(context.conversationId));
	const observedInitialDraft = useRef(false);
	const writeVersion = useRef(0);
	// The context in a ref so a changing folder/agent does not re-create the
	// callback and reset the debounce mid-sentence.
	const ctx = useRef(context);
	ctx.current = context;

	const flush = useCallback(
		async (item: PendingDraftWrite): Promise<void> => {
			if (item.version !== writeVersion.current) {
				return;
			}
			const target = toTarget(node);
			try {
				const text = item.draft.trim();
				if (text.length > 0) {
					const now = Date.now();
					if (
						!settings.current ||
						now - settings.current.at > SETTINGS_TTL_MS
					) {
						const fetched = await getDraftsSettings(target);
						settings.current = {
							at: now,
							enabled: fetched.autosave_enabled,
							min: fetched.autosave_min_chars,
						};
					}
					if (
						!settings.current.enabled ||
						text.length < settings.current.min ||
						item.version !== writeVersion.current
					) {
						return;
					}
				}

				for (const id of item.ids) {
					if (item.version !== writeVersion.current) {
						return;
					}
					await saveDraft(target, {
						id,
						text: item.draft,
						conversation_id: item.context.conversationId,
						agent_id: item.context.agentId,
						model: item.context.model,
						folder_path: item.context.folderPath,
						source: "composer-autosave",
					});
				}
			} catch {
				// Autosave is a courtesy, not a promise the user is waiting on. A
				// disabled app, a down node or a 404 route all mean "no draft kept",
				// and surfacing that as an error while someone is typing would be
				// worse than the thing it reports.
			}
		},
		[node]
	);

	useEffect(() => {
		if (!enabled) {
			if (timer.current) {
				clearTimeout(timer.current);
				timer.current = null;
			}
			pending.current = null;
		}
	}, [enabled]);

	useEffect(() => {
		return () => {
			if (timer.current) {
				clearTimeout(timer.current);
			}
			const item = pending.current;
			pending.current = null;
			if (item) {
				void flush(item);
			}
		};
	}, [flush]);

	return useCallback(
		(draft: string) => {
			if (!enabled) {
				return;
			}
			if (timer.current) {
				clearTimeout(timer.current);
			}
			writeVersion.current += 1;
			const version = writeVersion.current;
			const id = draftIdFor(ctx.current.conversationId);
			const previousId = lastDraftId.current;
			lastDraftId.current = id;
			// The first empty notification is AgentChat's mount-time observation, not
			// the user clearing a draft. Ignoring it prevents a slow restore request
			// from racing with a blank delete and destroying the only saved copy.
			if (!observedInitialDraft.current && draft.trim().length === 0) {
				observedInitialDraft.current = true;
				return;
			}
			observedInitialDraft.current = true;
			const ids =
				draft.trim().length === 0 ? [...new Set([id, previousId])] : [id];
			const item: PendingDraftWrite = {
				context: ctx.current,
				draft,
				ids,
				version,
			};
			pending.current = item;
			timer.current = setTimeout(() => {
				if (pending.current?.version !== version) {
					return;
				}
				pending.current = null;
				void flush(item);
			}, DEBOUNCE_MS);
		},
		[enabled, flush]
	);
}

/**
 * Load the durable composer row for this tab. The text is returned as a seed for
 * `AgentChat`; the component still owns the live value, so a user edit that wins
 * the race with this request is never overwritten.
 */
export function useComposerDraftRestore(
	context: ComposerDraftContext
): string | undefined {
	const node = useActiveNode();
	const enabled = useComposerDraftsEnabled(context);
	const [restoredDraft, setRestoredDraft] = useState<string | undefined>();
	const conversationId = context.conversationId;

	useEffect(() => {
		if (!enabled) {
			setRestoredDraft(undefined);
			return;
		}
		let cancelled = false;
		setRestoredDraft(undefined);
		void getDraft(toTarget(node), draftIdFor(conversationId))
			.then((draft) => {
				if (!cancelled) {
					setRestoredDraft(draft?.text || undefined);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setRestoredDraft(undefined);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [conversationId, enabled, node]);

	return restoredDraft;
}

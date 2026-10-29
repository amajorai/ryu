import { z } from "zod";
// apps/desktop/src/hooks/useComposerAutoQueue.ts
//
// "Don't start this now — the machine is already full."
//
// When `auto_queue_enabled` is on and the node is already running `max_concurrent`
// agents, pressing send does not send: the message becomes a draft armed with
// `concurrency { below: max_concurrent }`, and `useDraftsDispatcher` starts it the
// moment a slot frees. Off by default, because this changes what pressing Enter
// does and a user who has not asked for a queue should get the send they pressed
// for.
//
// The running count is read at SUBMIT time, not cached from the dispatcher's tick.
// A send happens a few times a minute at most, so one request buys a reading that is
// actually current — and a stale "2 running" from nine seconds ago is exactly how a
// message gets sent into a node that just filled up.
//
// Fail-OPEN here, which is the opposite of the dispatcher's rule and deliberate: if
// the running count cannot be read, the message SENDS. The user pressed send; the
// worst case of sending is a busy node, while the worst case of swallowing it into a
// queue on an unreadable signal is that their message silently does not happen.

import { useCallback } from "react";
import { request, toTarget } from "@/src/lib/api/client.ts";
import {
	armDraft,
	getDraftsSettings,
	saveDraft,
} from "@/src/lib/api/drafts.ts";
import { useActiveNode } from "./useActiveNode.ts";
import {
	type ComposerDraftContext,
	draftIdFor,
	useComposerDraftsEnabled,
} from "./useComposerDraftAutosave.ts";

/**
 * Returns a predicate the composer calls before sending: `true` means the message
 * was queued as a draft and must NOT be sent.
 *
 * Always resolves — never throws into the submit path.
 */
export function useComposerAutoQueue(
	context: ComposerDraftContext
): (text: string) => Promise<boolean> {
	const node = useActiveNode();
	const enabled = useComposerDraftsEnabled(context);

	return useCallback(
		async (text: string) => {
			if (!(enabled && text.trim())) {
				return false;
			}
			const target = toTarget(node);
			try {
				const settings = await getDraftsSettings(target);
				if (!settings.auto_queue_enabled) {
					return false;
				}
				const body = await request(
					target,
					"/api/runs",
					undefined,
					autoQueueRunsResponseSchema
				);
				const running = (body?.runs ?? []).filter(
					(r) => r.run_status === "running"
				).length;
				if (running < settings.max_concurrent) {
					return false;
				}
				// The SAME row the autosave has been writing, armed in place. Minting a
				// new id would leave two drafts holding the same text — the autosaved
				// one and the queued one — and the autosave's next blank flush would
				// only clear one of them.
				const id = draftIdFor(context.conversationId);
				await saveDraft(target, {
					id,
					text,
					conversation_id: context.conversationId,
					agent_id: context.agentId,
					model: context.model,
					folder_path: context.folderPath,
					source: "auto-queue",
				});
				await armDraft(target, id, {
					kind: "concurrency",
					below: settings.max_concurrent,
				});
				return true;
			} catch {
				// See the header: unreadable signal ⇒ send it.
				return false;
			}
		},
		[enabled, node, context]
	);
}

const runWireResponseSchema = z
	.object({ run_status: z.string().nullish() })
	.passthrough();

const autoQueueRunsResponseSchema = z
	.object({ runs: z.array(runWireResponseSchema).optional() })
	.passthrough();

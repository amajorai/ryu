import { z } from "zod";
// Hand the global "Ask Ryu" panel over to a page's builder while that page is
// the focused tab. A builder page (agent edit, workflows) calls this with the
// target it's building + the wiring to resolve/refresh it; the panel then acts
// as that builder (preamble, `*_builder.*` tools, live refresh) docked as a
// sidebar. Mirrors `useAssistantPageContext`: only the ACTIVE tab registers, so
// a background builder tab can't steal the panel (every tab stays mounted — see
// Layout), and the takeover is cleared when the page unmounts or loses focus.

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useIsActiveTab } from "@/src/contexts/TabsContext.tsx";
import {
	type AssistantBuilderKind,
	useAssistantStore,
} from "@/src/store/useAssistantStore.ts";

export interface AssistantBuilderInput {
	/** Sentence under the empty-state title. Required for an app-defined kind. */
	description?: string;
	/** Whether registering docks the panel open. Defaults to `true` (the builder
	 *  pages' behaviour); pass `false` for a surface the user did not ask to chat
	 *  with. See the store's `dock` doc. */
	dock?: boolean;
	/** `agent` / `workflow` (built-in preambles) or an app-defined surface id. */
	kind: AssistantBuilderKind;
	/** Empty-state + header title. Defaults to `Build <targetName>`. */
	label?: string;
	/** Called after each settled turn with the edited id so the page re-hydrates. */
	onChanged: (id: string) => void;
	/**
	 * Instructions injected ahead of the first outgoing user message. REQUIRED for
	 * an app-defined `kind`; ignored for `agent`/`workflow`, which ship their own.
	 * `{{targetId}}` / `{{snapshot}}` are substituted at send time.
	 */
	preamble?: string;
	/** One-tap starter prompts offered while the thread is empty. */
	prompts?: string[];
	/** Lazily resolve (creating a draft) the id to build. Returns null on failure. */
	resolveId: () => Promise<string | null>;
	/** Compact snapshot of the current definition, injected into the preamble. */
	snapshot: string;
	/** Target record id being built; null until a draft is created on first send. */
	targetId: string | null;
	/** Human name of the target, for the header + empty-state copy. */
	targetName: string;
	/** What an app-defined surface's conversation is about; a new value starts a
	 *  separate thread. See the store's `thread` doc. */
	thread?: string;
	/** Tool ids to name in the preamble. Advisory — see the store's doc comment. */
	tools?: string[];
}

/**
 * Register the calling page as the assistant's builder while it is focused.
 * Pass `null` to opt out (e.g. a non-builder view of the same page, or while
 * still loading) — that also tears down any takeover this page had registered.
 */
export function useAssistantBuilder(input: AssistantBuilderInput | null): void {
	const isActive = useIsActiveTab();
	const registerBuilder = useAssistantStore((s) => s.registerBuilder);
	const updateBuilder = useAssistantStore((s) => s.updateBuilder);
	const clearBuilder = useAssistantStore((s) => s.clearBuilder);

	// One stable conversation id per page instance, doubling as the owner token
	// the store uses to guard clears. crypto.randomUUID runs once via the ref.
	const ownerRef = useRef<string | null>(null);
	if (ownerRef.current === null) {
		ownerRef.current = `builder-${crypto.randomUUID()}`;
	}
	const owner = ownerRef.current;

	// The page's resolve/refresh callbacks change identity each render; read them
	// through refs so the registered session's closures stay stable (no re-dock).
	const resolveRef = useRef(input?.resolveId);
	resolveRef.current = input?.resolveId;
	const changedRef = useRef(input?.onChanged);
	changedRef.current = input?.onChanged;
	const stableResolve = useCallback(
		() => resolveRef.current?.() ?? Promise.resolve(null),
		[]
	);
	const stableChanged = useCallback((id: string) => {
		changedRef.current?.(id);
	}, []);

	// Live field values effect 1 reads at register time (without depending on them
	// — field changes flow through effect 2 so registering never re-docks).
	const kind = input?.kind;
	const targetId = input?.targetId ?? null;
	const targetName = input?.targetName ?? "";
	const snapshot = input?.snapshot ?? "";
	// The descriptive half (label/description/preamble/tools/prompts). Arrays get
	// a serialized dep key so an inline `tools={[...]}` literal can't re-fire the
	// update effect every render.
	const label = input?.label;
	const description = input?.description;
	const dock = input?.dock;
	const preamble = input?.preamble;
	const thread = input?.thread;
	const toolsKey = JSON.stringify(input?.tools ?? []);
	const promptsKey = JSON.stringify(input?.prompts ?? []);
	const descriptor = useMemo(
		() => ({
			label,
			description,
			dock,
			preamble,
			thread,
			tools: z.array(z.string()).parse(JSON.parse(toolsKey)),
			prompts: z.array(z.string()).parse(JSON.parse(promptsKey)),
		}),
		[label, description, dock, preamble, thread, toolsKey, promptsKey]
	);
	const fieldsRef = useRef({ targetId, targetName, snapshot, descriptor });
	fieldsRef.current = { targetId, targetName, snapshot, descriptor };

	// Register (auto-docks) on focus; clear on blur/unmount. Owner-guarded clear.
	useEffect(() => {
		if (!(isActive && kind)) {
			return;
		}
		registerBuilder({
			conversationId: owner,
			kind,
			onChanged: stableChanged,
			resolveId: stableResolve,
			snapshot: fieldsRef.current.snapshot,
			targetId: fieldsRef.current.targetId,
			targetName: fieldsRef.current.targetName,
			...fieldsRef.current.descriptor,
		});
		return () => clearBuilder(owner);
	}, [
		isActive,
		kind,
		owner,
		registerBuilder,
		clearBuilder,
		stableResolve,
		stableChanged,
	]);

	// Push live field changes without re-docking (leaves the user's layout alone).
	useEffect(() => {
		if (!(isActive && kind)) {
			return;
		}
		updateBuilder({ snapshot, targetId, targetName, ...descriptor });
	}, [
		isActive,
		kind,
		snapshot,
		targetId,
		targetName,
		descriptor,
		updateBuilder,
	]);
}

/**
 * The generalized name for {@link useAssistantBuilder}: an app-defined takeover
 * is a *surface*, not a builder. Same hook — `kind` is an open string and an
 * app-defined kind must bring its own `preamble`.
 */
export const useAssistantSurface = useAssistantBuilder;

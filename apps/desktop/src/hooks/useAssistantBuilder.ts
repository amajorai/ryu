// Hand the global "Ask Ryu" panel over to a page's builder while that page is
// the focused tab. A builder page (agent edit, workflows) calls this with the
// target it's building + the wiring to resolve/refresh it; the panel then acts
// as that builder (preamble, `*_builder__*` tools, live refresh) docked as a
// sidebar. Mirrors `useAssistantPageContext`: only the ACTIVE tab registers, so
// a background builder tab can't steal the panel (every tab stays mounted — see
// Layout), and the takeover is cleared when the page unmounts or loses focus.

import { useCallback, useEffect, useRef } from "react";
import { useIsActiveTab } from "@/src/contexts/TabsContext.tsx";
import {
	type AssistantBuilderKind,
	useAssistantStore,
} from "@/src/store/useAssistantStore.ts";

export interface AssistantBuilderInput {
	kind: AssistantBuilderKind;
	/** Called after each settled turn with the edited id so the page re-hydrates. */
	onChanged: (id: string) => void;
	/** Lazily resolve (creating a draft) the id to build. Returns null on failure. */
	resolveId: () => Promise<string | null>;
	/** Compact snapshot of the current definition, injected into the preamble. */
	snapshot: string;
	/** Target record id being built; null until a draft is created on first send. */
	targetId: string | null;
	/** Human name of the target, for the header + empty-state copy. */
	targetName: string;
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
	const fieldsRef = useRef({ targetId, targetName, snapshot });
	fieldsRef.current = { targetId, targetName, snapshot };

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
		updateBuilder({ snapshot, targetId, targetName });
	}, [isActive, kind, snapshot, targetId, targetName, updateBuilder]);
}

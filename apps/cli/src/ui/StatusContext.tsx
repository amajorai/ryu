/* @jsxImportSource @opentui/react */
// StatusContext - lets the surface that owns the keyboard publish its key hints
// and busy state to the shell's single StatusBar, instead of each surface drawing
// its own bottom bar.
//
// Contributions are keyed by scope: a pane id for pane surfaces, or
// OVERLAY_STATUS_SCOPE for a body inside the modal overlay (which owns the
// keyboard while open). While an overlay is open the provider exposes only the
// overlay contribution (or nothing): the focused pane's hints and busy state
// would advertise keys the overlay has taken over. Otherwise it exposes the
// focused pane's. Outside a provider
// useStatusContribution is a no-op, so isolated surface harnesses keep working.

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { KeyHint } from "../core/keymap.ts";
import { useOverlay } from "../overlays/OverlayHost.tsx";
import { useWorkspace } from "../workspace/WorkspaceContext.tsx";
import type { StatusBusy } from "./StatusBar.tsx";

/** Scope id for a contribution from the modal overlay layer. */
export const OVERLAY_STATUS_SCOPE = "overlay";

export interface StatusContribution {
	busy?: StatusBusy;
	hints?: KeyHint[];
	/** Replaces the shell's left status text (e.g. "refreshing…"). */
	left?: string;
}

interface StatusRegistry {
	remove: (scopeId: string) => void;
	set: (scopeId: string, contribution: StatusContribution) => void;
}

const StatusRegistryContext = createContext<StatusRegistry | null>(null);
const ActiveStatusContext = createContext<StatusContribution | null>(null);

export function StatusProvider({ children }: { children: ReactNode }) {
	const { focusedPaneId } = useWorkspace();
	const { openId: overlayOpenId } = useOverlay();
	const [contributions, setContributions] = useState<
		ReadonlyMap<string, StatusContribution>
	>(() => new Map());

	const set = useCallback(
		(scopeId: string, contribution: StatusContribution) => {
			setContributions((current) => {
				const next = new Map(current);
				next.set(scopeId, contribution);
				return next;
			});
		},
		[]
	);
	const remove = useCallback((scopeId: string) => {
		setContributions((current) => {
			if (!current.has(scopeId)) {
				return current;
			}
			const next = new Map(current);
			next.delete(scopeId);
			return next;
		});
	}, []);
	const registry = useMemo(() => ({ remove, set }), [remove, set]);

	const active =
		overlayOpenId === null
			? (contributions.get(focusedPaneId) ?? null)
			: (contributions.get(OVERLAY_STATUS_SCOPE) ?? null);

	return (
		<StatusRegistryContext.Provider value={registry}>
			<ActiveStatusContext.Provider value={active}>
				{children}
			</ActiveStatusContext.Provider>
		</StatusRegistryContext.Provider>
	);
}

/** The contribution the shell's StatusBar should show, or null. */
export function useActiveStatus(): StatusContribution | null {
	return useContext(ActiveStatusContext);
}

function contributionSignature(contribution: StatusContribution): string {
	const hints = (contribution.hints ?? [])
		.map((hint) => `${hint.keys}\u0000${hint.label}\u0000${hint.priority}`)
		.join("\u0001");
	const busy = contribution.busy
		? `${contribution.busy.label}\u0000${contribution.busy.startedAt}`
		: "";
	return `${contribution.left ?? ""}\u0002${busy}\u0002${hints}`;
}

/**
 * Publish this surface's hints/busy state for `scopeId` (its pane id, or
 * OVERLAY_STATUS_SCOPE). Re-registers only when the content changes, so callers
 * may pass fresh literals every render; unregisters on unmount.
 */
export function useStatusContribution(
	scopeId: string | undefined,
	contribution: StatusContribution
): void {
	const registry = useContext(StatusRegistryContext);
	const latest = useRef(contribution);
	latest.current = contribution;
	const signature = contributionSignature(contribution);

	useEffect(() => {
		if (!(registry && scopeId)) {
			return;
		}
		// `signature` tracks the content of `latest.current`.
		registry.set(scopeId, latest.current);
	}, [registry, scopeId, signature]);

	useEffect(() => {
		if (!(registry && scopeId)) {
			return;
		}
		return () => registry.remove(scopeId);
	}, [registry, scopeId]);
}

import { useCallback, useEffect, useMemo } from "react";
import { setOnboardingActive } from "@/src/lib/onboarding-active.ts";
import { type Node, useNodeStore } from "@/src/store/useNodeStore.ts";
import type { LocalStatusReporter } from "./OnboardingPage.local-stack.ts";
import type { useOnboardingPhase } from "./OnboardingPage.phase.ts";
import type { useOnboardingFlowState } from "./OnboardingPage.state.ts";

type OnboardingLocalProgressInput = Pick<
	ReturnType<typeof useOnboardingFlowState>,
	"cancelledRef" | "doneStatusRef" | "liveStatusRef" | "setLocalPercent"
> &
	Pick<ReturnType<typeof useOnboardingPhase>, "setDefault">;

/** Local bring-up progress reporting and node activation. */
export function useOnboardingLocalProgress({
	cancelledRef,
	doneStatusRef,
	liveStatusRef,
	setDefault,
	setLocalPercent,
}: OnboardingLocalProgressInput) {
	const updateLocalPercent = useCallback((percent: number | null) => {
		if (percent === null) {
			setLocalPercent(null);
			return;
		}
		setLocalPercent((previous) =>
			previous === null ? percent : Math.max(previous, percent)
		);
	}, []);
	useEffect(() => {
		cancelledRef.current = false;
		return () => {
			cancelledRef.current = true;
		};
	}, []);
	const activateOnboardingNode = useCallback(
		async (node: Node): Promise<Node> => {
			try {
				await setDefault(node.name);
			} catch {
				// Browser onboarding has no Tauri persistence bridge. Keep the selected
				// node active for this session instead of continuing against a stale
				// cloud/default node.
				useNodeStore.setState({
					activeNodeOnline: null,
					autoSelectedNode: null,
					defaultNode: node.name,
				});
			}
			// A deliberate onboarding choice must win over any stale auto-selection.
			useNodeStore.setState({ autoSelectedNode: null, activeNodeOnline: null });
			const active = useNodeStore.getState().getActiveNode();
			const sameUrl =
				active.url.replace(/\/+$/u, "") === node.url.replace(/\/+$/u, "");
			if (active.name !== node.name || !sameUrl) {
				throw new Error("Ryu could not activate the selected node. Try again.");
			}
			return active;
		},
		[setDefault]
	);
	// The stages the installer events cannot see — preparing, Core booting, the
	// local engine install, agent detection. A fixed bar position rather than a
	// fraction; null hands the bar back to the phase's own placeholder.
	const reportLocalStatus = useCallback(
		(status: string | null, percent?: number | null) => {
			liveStatusRef.current = status;
			updateLocalPercent(percent ?? null);
		},
		[updateLocalPercent]
	);
	/** Record something that has actually COMPLETED. These keep appearing in the
	 *  loop after the fact, which is the point: the gateway and the local engine
	 *  install silently today, so nothing on screen ever admitted they existed. */
	const reportDone = useCallback((line: string) => {
		const log = doneStatusRef.current;
		if (log.at(-1) !== line) {
			log.push(line);
		}
	}, []);
	/** The pair handed to every async leg of the local bring-up. */
	const localReport = useMemo<LocalStatusReporter>(
		() => ({ done: reportDone, status: reportLocalStatus }),
		[reportDone, reportLocalStatus]
	);
	// Claim the installer progress for the duration of the wizard. App.tsx listens
	// to the same stream outside onboarding and toasts it; here the wizard owns the
	// inline status and progress bar.
	useEffect(() => {
		setOnboardingActive(true);
		return () => setOnboardingActive(false);
	}, []);
	return {
		activateOnboardingNode,
		localReport,
		reportDone,
		updateLocalPercent,
	};
}

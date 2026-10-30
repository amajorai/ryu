import { toast } from "@ryu/ui/components/sileo.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	getSandboxDefaultRunBudgetMicroUsd,
	setSandboxDefaultRunBudgetMicroUsd,
} from "@/src/lib/api/preferences.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import {
	dollarTextToMicro,
	microToDollarText,
} from "./BillingTab-spend-shared.tsx";

/**
 * The per-run default sandbox budget of the selected node, for
 * `SpendControlsSection`'s "Sandbox spending" card.
 */
export function useSandboxRunBudget() {
	const [budgetText, setBudgetText] = useState("0");
	const [budgetDirty, setBudgetDirty] = useState(false);
	// The run budget is a preference of the selected node, so it is read from
	// and written to whichever node is selected now, not the one at mount.
	const budgetNode = useNodeStore((s) => s.getActiveNode());
	// Bumped by every edit and node switch. A save clears `budgetDirty` only if
	// nothing changed while it was in flight, so a late completion for node A
	// (or for an earlier value) never marks B's newer edit as saved.
	const budgetEdit = useRef(0);

	// Load the per-run default sandbox budget (Core node preference). CLEAR
	// FIRST, THEN LOAD on every node change: an unsaved edit belongs to the node
	// it was typed for, and a failed read must not leave another node's budget
	// on screen to be saved onto this one.
	useEffect(() => {
		let cancelled = false;
		budgetEdit.current += 1;
		setBudgetText("0");
		setBudgetDirty(false);
		getSandboxDefaultRunBudgetMicroUsd(toTarget(budgetNode))
			.then((micro) => {
				if (!cancelled) {
					setBudgetText(microToDollarText(micro));
					setBudgetDirty(false);
				}
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [budgetNode]);

	const saveBudget = useCallback(async () => {
		if (!budgetDirty) {
			return;
		}
		const micro = Math.max(0, dollarTextToMicro(budgetText));
		setBudgetText(microToDollarText(micro));
		const edit = budgetEdit.current;
		try {
			const ok = await setSandboxDefaultRunBudgetMicroUsd(
				toTarget(budgetNode),
				micro
			);
			if (ok) {
				if (budgetEdit.current === edit) {
					setBudgetDirty(false);
				}
			} else {
				toast.error("Couldn't save the sandbox run budget.");
			}
		} catch {
			toast.error("Couldn't save the sandbox run budget.");
		}
	}, [budgetDirty, budgetText, budgetNode]);

	return { budgetEdit, budgetText, saveBudget, setBudgetDirty, setBudgetText };
}

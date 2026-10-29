// apps/desktop/src/lib/cloud-task-backend-choice.ts
//
// The per-session backend choice for a new cloud task ("Auto", the owner's plan, or
// the Ryu Box), keyed by the same chat scope as the environment selection. It is
// ephemeral: it only shapes the first prompt, and Core keeps a conversation that
// started on a plan on that plan.

import { create } from "zustand";
import {
	BACKEND_PROVIDER,
	type CloudTaskBackendId,
} from "./api/cloud-task-backends.ts";

export type CloudTaskBackendChoice =
	| { kind: "auto" }
	| {
			kind: "pinned";
			backend: CloudTaskBackendId;
			strict: boolean;
			/** The linked account to run on; omitted uses the agent's or default one. */
			accountId?: string;
	  };

export const AUTO_BACKEND_CHOICE: CloudTaskBackendChoice = { kind: "auto" };

interface BackendChoiceState {
	choices: Record<string, CloudTaskBackendChoice>;
	setChoice: (scope: string, choice: CloudTaskBackendChoice) => void;
}

export const useCloudTaskBackendChoices = create<BackendChoiceState>((set) => ({
	choices: {},
	setChoice: (scope, choice) =>
		set((state) => ({ choices: { ...state.choices, [scope]: choice } })),
}));

/** The prompt fields a choice adds (none for "Auto"). */
export function backendPromptFields(
	choice: CloudTaskBackendChoice | undefined
): {
	account?: string;
	backend?: CloudTaskBackendId;
	fallback?: boolean;
} {
	if (!choice || choice.kind === "auto") {
		return {};
	}
	const fields = { backend: choice.backend, fallback: !choice.strict };
	if (choice.accountId && choice.backend !== "ryu-box") {
		return {
			...fields,
			account: `${BACKEND_PROVIDER[choice.backend]}:${choice.accountId}`,
		};
	}
	return fields;
}

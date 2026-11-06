// The empty definition the workflow builder creates on its first message.
//
// Its name is user-editable, so it is written in the creator's UI language at
// creation time (like any name a person types) rather than a fixed English
// placeholder.

import type { LiteralMessage } from "@ryu/i18n";

export function newWorkflowName(tl: LiteralMessage): string {
	return tl("New workflow");
}

export function newWorkflowDraft(tl: LiteralMessage) {
	return {
		id: "",
		name: newWorkflowName(tl),
		nodes: [],
		edges: [],
		triggers: [],
	};
}

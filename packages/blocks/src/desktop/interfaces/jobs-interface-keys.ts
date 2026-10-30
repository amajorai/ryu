import type { KeyboardEvent } from "react";
import { ownsKeys } from "./jobs-interface-hooks.tsx";
import { cursorStep, stepIndex } from "./jobs-model.ts";

interface RowRegistry {
	focus: (id: string | undefined) => void;
}

/** Arrow keys walk the job list; Enter opens a job and Escape closes it. */
export function onKeyDownJobHandler({
	closeJob,
	conversationOpen,
	jobRegistry,
	openJob,
	order,
	setCursorId,
}: {
	closeJob: () => void;
	conversationOpen: boolean;
	jobRegistry: RowRegistry;
	openJob: (threadId: string) => void;
	order: string[];
	setCursorId: (id: string) => void;
}) {
	return (event: KeyboardEvent<HTMLElement>, threadId: string) => {
		if (event.metaKey || event.ctrlKey || event.altKey) {
			return;
		}
		const step = cursorStep(event.key);
		if (step) {
			event.preventDefault();
			event.stopPropagation();
			const next =
				order[stepIndex(step, order.indexOf(threadId), order.length)];
			if (next) {
				setCursorId(next);
				jobRegistry.focus(next);
			}
			return;
		}
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			event.stopPropagation();
			openJob(threadId);
			return;
		}
		if (event.key === "Escape" && conversationOpen) {
			event.preventDefault();
			event.stopPropagation();
			closeJob();
		}
	};
}

/** Arrow keys walk the freelancer list; Enter unfolds the Hire composer. */
export function onKeyDownFreelancerHandler({
	freelancerOrder,
	freelancerRegistry,
	hire,
	setFreelancerCursorId,
}: {
	freelancerOrder: string[];
	freelancerRegistry: RowRegistry;
	hire: (agentId: string) => void;
	setFreelancerCursorId: (id: string) => void;
}) {
	return (event: KeyboardEvent<HTMLElement>, agentId: string) => {
		if (event.metaKey || event.ctrlKey || event.altKey) {
			return;
		}
		if (event.target !== event.currentTarget) {
			return;
		}
		const step = cursorStep(event.key);
		if (step) {
			event.preventDefault();
			event.stopPropagation();
			const next =
				freelancerOrder[
					stepIndex(
						step,
						freelancerOrder.indexOf(agentId),
						freelancerOrder.length
					)
				];
			if (next) {
				setFreelancerCursorId(next);
				freelancerRegistry.focus(next);
			}
			return;
		}
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			event.stopPropagation();
			hire(agentId);
		}
	};
}

/** Escape leaves full view unless a typing target owns the key. */
export function onKeyDownRootHandler({
	fullView,
	setFullView,
}: {
	fullView: boolean;
	setFullView: (next: boolean) => void;
}) {
	return (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.defaultPrevented ||
			event.metaKey ||
			event.ctrlKey ||
			event.altKey ||
			ownsKeys(event.target)
		) {
			return;
		}
		if (event.key === "Escape" && fullView) {
			event.preventDefault();
			setFullView(false);
		}
	};
}

import "./setup-dom.ts";

import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useDeferredQuestion } from "../../../../packages/blocks/src/desktop/agent-elements/use-deferred-question.ts";

// ReactDOM reads this optional host flag; the fixture installs it on the full
// existing native global object at the original mutation point.
const reactActEnvironment: typeof globalThis & {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
} = globalThis;
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

interface PendingQuestion {
	id: string;
}

let markComposerActivity = () => undefined;
let markComposerIdle = () => undefined;
let visibleQuestion: PendingQuestion | null = null;
let currentRoot: Root | null = null;
let currentContainer: HTMLElement | null = null;

const Harness = ({
	question,
	idleMs = 20,
	paused = false,
}: {
	question: PendingQuestion | null;
	idleMs?: number;
	paused?: boolean;
}) => {
	const deferred = useDeferredQuestion(question, idleMs, paused);
	markComposerActivity = deferred.markComposerActivity;
	markComposerIdle = deferred.markComposerIdle;
	visibleQuestion = deferred.visibleQuestion;
	return null;
};

const renderHarness = async (
	question: PendingQuestion | null,
	paused = false
) => {
	if (!(currentRoot && currentContainer)) {
		currentContainer = document.createElement("div");
		document.body.appendChild(currentContainer);
		currentRoot = createRoot(currentContainer);
	}
	await act(async () => {
		currentRoot?.render(<Harness paused={paused} question={question} />);
	});
};

afterEach(async () => {
	if (currentRoot) {
		await act(async () => {
			currentRoot?.unmount();
		});
	}
	currentRoot = null;
	currentContainer?.remove();
	currentContainer = null;
	markComposerActivity = () => undefined;
	markComposerIdle = () => undefined;
	visibleQuestion = null;
});

describe("useDeferredQuestion", () => {
	it("keeps a new question hidden while composer activity is fresh", async () => {
		await renderHarness(null);
		await act(async () => {
			markComposerActivity();
		});
		await renderHarness({ id: "question-1" });

		expect(visibleQuestion).toBeNull();
	});

	it("reveals the pending question after the composer becomes idle", async () => {
		await renderHarness(null);
		await act(async () => {
			markComposerActivity();
		});
		await renderHarness({ id: "question-1" });

		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 30));
		});

		expect(visibleQuestion).toEqual({ id: "question-1" });
	});

	it("shows a question immediately when the composer is already idle", async () => {
		await renderHarness({ id: "question-1" });

		expect(visibleQuestion).toEqual({ id: "question-1" });
	});

	it("reveals the pending question immediately when the draft is cleared", async () => {
		await renderHarness(null);
		await act(async () => {
			markComposerActivity();
		});
		await renderHarness({ id: "question-1" });
		expect(visibleQuestion).toBeNull();

		await act(async () => {
			markComposerIdle();
		});

		expect(visibleQuestion).toEqual({ id: "question-1" });
	});

	it("keeps the pending question out of the composer while unavailable", async () => {
		await renderHarness({ id: "question-1" }, true);

		expect(visibleQuestion).toBeNull();

		await renderHarness({ id: "question-1" });

		expect(visibleQuestion).toEqual({ id: "question-1" });
	});
});

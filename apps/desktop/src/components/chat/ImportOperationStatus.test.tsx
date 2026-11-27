// apps/desktop/src/components/chat/ImportOperationStatus.test.tsx
//
// What the import surfaces draw for the operations they started: the progress
// block while an import runs, the sentence and the counts once it ended, and
// the buttons that go with each state.

import { describe, expect, test } from "bun:test";
import { I18nProvider } from "@ryu/i18n/react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ImportOperationsView } from "@/src/hooks/useImportOperations.ts";
import type { ImportOutcome } from "@/src/lib/api/import.ts";
import type { Operation } from "@/src/lib/api/operations.ts";
import {
	ImportOperationActions,
	ImportOperationStatus,
	ImportOutcomeTotals,
} from "./ImportOperationStatus.tsx";

const TAG = /<[^>]*>/gu;
const SPACES = /\s+/gu;
const BUTTON = /<button[^>]*>.*?<\/button>/gsu;
const DISABLED = /<button[^>]*\sdisabled(?:=""|[\s>])/u;

function html(node: ReactNode): string {
	return renderToStaticMarkup(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale="en"
			initialPackId={null}
		>
			{node}
		</I18nProvider>
	);
}

/** The visible text of `node`, tags removed. */
function textOf(node: ReactNode): string {
	return html(node).replace(TAG, " ").replace(SPACES, " ").trim();
}

/** The labels of the buttons `node` draws, in order. */
function buttonsOf(node: ReactNode): string[] {
	return (html(node).match(BUTTON) ?? []).map((button) =>
		button.replace(TAG, " ").replace(SPACES, " ").trim()
	);
}

function operation(over: Partial<Operation> = {}): Operation {
	return {
		attempt: 1,
		cancelRequested: false,
		createdAt: "2026-11-18T10:00:00.000Z",
		id: "op_1",
		kind: "import.setup",
		progress: { done: 3, total: 12 },
		resumed: false,
		status: "running",
		title: ".claude",
		updatedAt: "2026-11-18T10:00:05.000Z",
		...over,
	};
}

function outcome(
	status: ImportOutcome["status"],
	id: string,
	detail?: string
): ImportOutcome {
	return { alreadyExists: false, detail, id, kind: "skill", status, title: id };
}

function view(over: Partial<ImportOperationsView> = {}): ImportOperationsView {
	return {
		active: false,
		clear: () => undefined,
		operations: [],
		outcomes: [],
		retry: () => Promise.resolve(),
		settled: false,
		start: () => Promise.resolve([]),
		stop: () => Promise.resolve(),
		...over,
	};
}

describe("the state of a surface's imports", () => {
	test("a surface without imports draws nothing", () => {
		expect(textOf(<ImportOperationStatus view={view()} />)).toBe("");
		expect(
			buttonsOf(
				<ImportOperationActions onError={() => undefined} view={view()} />
			)
		).toEqual([]);
	});

	test("a running import shows how far it is and that the window can be closed", () => {
		const text = textOf(
			<ImportOperationStatus view={view({ operations: [operation()] })} />
		);
		expect(text).toContain("Importing…");
		expect(text).toContain("3 of 12 items");
		expect(text).toContain(
			"You can close this window. The import keeps running and shows in the Live section."
		);
		expect(text).not.toContain("Resumed after restart");
	});

	test("the hint is left out where there is no window to close", () => {
		const text = textOf(
			<ImportOperationStatus
				hint={false}
				view={view({ operations: [operation()] })}
			/>
		);
		expect(text).toContain("Importing…");
		expect(text).not.toContain("You can close this window.");
	});

	test("an import that only waits says so, and has no count before it knows one", () => {
		const text = textOf(
			<ImportOperationStatus
				view={view({
					operations: [
						operation({ progress: { done: 0, total: 0 }, status: "queued" }),
					],
				})}
			/>
		);
		expect(text).toContain("Waiting for another import to finish.");
		expect(text).not.toContain(" of ");
	});

	test("a stop that was asked for and a run that continued after a restart are marked", () => {
		expect(
			textOf(
				<ImportOperationStatus
					view={view({ operations: [operation({ cancelRequested: true })] })}
				/>
			)
		).toContain("Stopping…");
		expect(
			textOf(
				<ImportOperationStatus
					view={view({ operations: [operation({ resumed: true })] })}
				/>
			)
		).toContain("Resumed after restart");
	});

	test("an interrupted import says what happened and what was kept", () => {
		const text = textOf(
			<ImportOperationStatus
				view={view({
					operations: [operation({ status: "interrupted" })],
					outcomes: [outcome("imported", "a"), outcome("imported", "b")],
					settled: true,
				})}
			/>
		);
		expect(text).toContain(
			"The node restarted during this import. Items already imported are kept."
		);
		expect(text).toContain("Imported 2, skipped 0, failed 0");
		expect(text).not.toContain("Importing…");
	});

	test("a failed import shows the node's error and one line per failed item", () => {
		const text = textOf(
			<ImportOperationStatus
				view={view({
					operations: [
						operation({ error: "The folder is gone.", status: "failed" }),
					],
					outcomes: [
						outcome("imported", "a"),
						outcome("skipped", "b"),
						outcome("failed", "Skill 3", "The file is not a readable skill."),
					],
					settled: true,
				})}
			/>
		);
		expect(text).toContain(
			"The import stopped with an error. Items already imported are kept."
		);
		expect(text).toContain("The folder is gone.");
		expect(text).toContain("Imported 1, skipped 1, failed 1");
		expect(text).toContain("Skill 3: The file is not a readable skill.");
	});

	test("the counts wait until the final record of every import is read", () => {
		const text = textOf(
			<ImportOperationStatus
				view={view({
					operations: [operation({ status: "cancelled" })],
					outcomes: [outcome("imported", "a")],
					settled: false,
				})}
			/>
		);
		expect(text).toContain(
			"The import was stopped. Items already imported are kept."
		);
		expect(text).not.toContain("Imported 1");
	});

	test("a finished import shows its counts and no warning", () => {
		const text = textOf(
			<ImportOperationStatus
				view={view({
					operations: [
						operation({ progress: { done: 2, total: 2 }, status: "succeeded" }),
					],
					outcomes: [outcome("imported", "a"), outcome("skipped", "b")],
					settled: true,
				})}
			/>
		);
		expect(text).toBe("Imported 1, skipped 1, failed 0");
	});

	test("the totals of an older node's answer use the same line", () => {
		expect(
			textOf(
				<ImportOutcomeTotals
					outcomes={[outcome("imported", "a"), outcome("failed", "b")]}
				/>
			)
		).toBe("Imported 1, skipped 0, failed 1");
	});
});

describe("the buttons of a surface's imports", () => {
	const actions = (over: Partial<ImportOperationsView>) => (
		<ImportOperationActions onError={() => undefined} view={view(over)} />
	);

	test("a running import can only be stopped", () => {
		const node = actions({ operations: [operation()] });
		expect(buttonsOf(node)).toEqual(["Stop"]);
		expect(html(node)).not.toMatch(DISABLED);
	});

	test("Stop is off once the stop was asked for", () => {
		const node = actions({
			operations: [operation({ cancelRequested: true })],
		});
		expect(buttonsOf(node)).toEqual(["Stop"]);
		expect(html(node)).toMatch(DISABLED);
	});

	test("an import that ended early offers Retry and the way back", () => {
		for (const status of ["failed", "cancelled", "interrupted"] as const) {
			expect(
				buttonsOf(actions({ operations: [operation({ status })] }))
			).toEqual(["Retry", "Import another folder"]);
		}
	});

	test("a finished import offers only the way back", () => {
		expect(
			buttonsOf(actions({ operations: [operation({ status: "succeeded" })] }))
		).toEqual(["Import another folder"]);
	});
});

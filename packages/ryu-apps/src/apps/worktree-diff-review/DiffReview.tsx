// The Worktree Diff Review widget (spec §4 app 7, D5/D6). Renders a per-file,
// per-hunk diff for a run's worktree with include checkboxes, expand/collapse, and
// diff coloring. Companion actions transit the governed host bridge:
//   - "Apply selected" / "Discard selected" -> window.ryu.callTool (HITL write)
//   - "Open PR"                              -> window.ryu.callTool
//   - "Explain this hunk"                    -> window.ryu.sendFollowUpMessage
// UI state (per-hunk include, per-file collapse, PR title) persists via
// window.ryu.setWidgetState so it survives reload (D4). Theme follows tokens.css.
//
// B1 scope: this component + a client-side SAMPLE stub used only in bare dev preview
// (no host injected toolOutput). The real Rust provider is wired in B2.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRyuGlobal } from "../../shared/useRyuGlobal";

// ---- data shapes (structuredContent of ryu.worktree.review) ----

type LineKind = "add" | "del" | "ctx";

interface DiffLine {
	kind: LineKind;
	content: string;
}

interface Hunk {
	id: string;
	header: string;
	lines: DiffLine[];
}

interface DiffFile {
	path: string;
	status: string;
	additions: number;
	deletions: number;
	hunks: Hunk[];
}

interface ReviewSummary {
	files: number;
	additions: number;
	deletions: number;
}

interface ReviewOutput {
	branch: string;
	worktree_path: string;
	summary: ReviewSummary;
	files: DiffFile[];
}

/** Persisted widget UI state (D4), keyed host-side by toolCallId. */
interface DiffWidgetState {
	/** hunkId -> included in the next apply/discard. Absent key defaults to true. */
	included: Record<string, boolean>;
	/** filePath -> collapsed (hunks hidden). Absent key defaults to expanded. */
	collapsed: Record<string, boolean>;
	/** Draft PR title. */
	prTitle: string;
}

// ---- dev-only sample (client stub; real data comes from the B2 Rust provider) ----

const SAMPLE_OUTPUT: ReviewOutput = {
	branch: "ryu/run-4f2a-diff-review",
	worktree_path: ".claude/worktrees/run-4f2a",
	summary: { files: 2, additions: 9, deletions: 3 },
	files: [
		{
			path: "apps/core/src/workflow/store.rs",
			status: "modified",
			additions: 6,
			deletions: 3,
			hunks: [
				{
					id: "store.rs#1",
					header: "@@ -12,7 +12,10 @@ impl WorkflowStore",
					lines: [
						{
							kind: "ctx",
							content: "    pub fn insert(&mut self, run: Run) {",
						},
						{ kind: "del", content: "        self.runs.push(run);" },
						{ kind: "add", content: "        let id = run.id.clone();" },
						{ kind: "add", content: "        self.runs.insert(id, run);" },
						{ kind: "ctx", content: "    }" },
					],
				},
				{
					id: "store.rs#2",
					header: "@@ -40,3 +43,5 @@ impl WorkflowStore",
					lines: [
						{ kind: "del", content: "        // TODO: persist" },
						{ kind: "del", content: "        Ok(())" },
						{ kind: "add", content: "        self.flush()?;" },
						{ kind: "add", content: "        Ok(())" },
					],
				},
			],
		},
		{
			path: "packages/ryu-apps/src/apps/worktree-diff-review/README.md",
			status: "added",
			additions: 3,
			deletions: 0,
			hunks: [
				{
					id: "README.md#1",
					header: "@@ -0,0 +1,3 @@",
					lines: [
						{ kind: "add", content: "# Worktree Diff Review" },
						{ kind: "add", content: "" },
						{ kind: "add", content: "Hunk-level review widget." },
					],
				},
			],
		},
	],
};

// ---- validation ----

function isReviewOutput(value: unknown): value is ReviewOutput {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return typeof candidate.branch === "string" && Array.isArray(candidate.files);
}

function collectHunkIds(files: DiffFile[]): string[] {
	const ids: string[] = [];
	for (const file of files) {
		for (const hunk of file.hunks) {
			ids.push(hunk.id);
		}
	}
	return ids;
}

function isIncluded(state: DiffWidgetState, hunkId: string): boolean {
	return state.included[hunkId] !== false;
}

const EMPTY_STATE: DiffWidgetState = {
	included: {},
	collapsed: {},
	prTitle: "",
};

function normalizeState(raw: unknown): DiffWidgetState {
	if (!raw || typeof raw !== "object") {
		return EMPTY_STATE;
	}
	const candidate = raw as Partial<DiffWidgetState>;
	return {
		included:
			candidate.included && typeof candidate.included === "object"
				? candidate.included
				: {},
		collapsed:
			candidate.collapsed && typeof candidate.collapsed === "object"
				? candidate.collapsed
				: {},
		prTitle: typeof candidate.prTitle === "string" ? candidate.prTitle : "",
	};
}

// ---- presentational leaf components (defined at module scope) ----

function Chevron() {
	return (
		<svg
			aria-hidden="true"
			fill="none"
			height="14"
			viewBox="0 0 24 24"
			width="14"
		>
			<title>toggle</title>
			<path
				d="M6 9l6 6 6-6"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="2"
			/>
		</svg>
	);
}

/** Stable React keys for a hunk's lines (content can repeat, so dedup by occurrence
 *  rather than using the array index, which the linter forbids). */
function keyedLines(hunk: Hunk): { key: string; line: DiffLine }[] {
	const seen = new Map<string, number>();
	return hunk.lines.map((line) => {
		const base = `${line.kind}:${line.content}`;
		const occurrence = seen.get(base) ?? 0;
		seen.set(base, occurrence + 1);
		return { key: `${hunk.id}:${base}:${occurrence}`, line };
	});
}

function DiffLineRow({ line }: { line: DiffLine }) {
	const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
	return (
		<div className="wdr-line" data-kind={line.kind}>
			<span className="wdr-line-sign">{sign}</span>
			<span className="wdr-line-text">{line.content || " "}</span>
		</div>
	);
}

interface HunkRowProps {
	hunk: Hunk;
	filePath: string;
	included: boolean;
	busy: boolean;
	onToggle: (hunkId: string) => void;
	onExplain: (file: string, hunk: Hunk) => void;
}

function HunkRow({
	hunk,
	filePath,
	included,
	busy,
	onToggle,
	onExplain,
}: HunkRowProps) {
	return (
		<div className="wdr-hunk">
			<div className="wdr-hunk-head">
				<input
					aria-label={`Include hunk ${hunk.header}`}
					checked={included}
					className="wdr-check"
					onChange={() => onToggle(hunk.id)}
					type="checkbox"
				/>
				<span className="wdr-hunk-header" title={hunk.header}>
					{hunk.header}
				</span>
				<button
					className="wdr-btn wdr-btn-ghost wdr-explain"
					disabled={busy}
					onClick={() => onExplain(filePath, hunk)}
					type="button"
				>
					Explain
				</button>
			</div>
			<div className="wdr-lines">
				{keyedLines(hunk).map((entry) => (
					<DiffLineRow key={entry.key} line={entry.line} />
				))}
			</div>
		</div>
	);
}

interface FileBlockProps {
	file: DiffFile;
	state: DiffWidgetState;
	busy: boolean;
	onToggleHunk: (hunkId: string) => void;
	onToggleFile: (file: DiffFile) => void;
	onToggleCollapse: (path: string) => void;
	onExplain: (file: string, hunk: Hunk) => void;
}

function FileBlock({
	file,
	state,
	busy,
	onToggleHunk,
	onToggleFile,
	onToggleCollapse,
	onExplain,
}: FileBlockProps) {
	const collapsed = state.collapsed[file.path] === true;
	const includedCount = file.hunks.filter((h) =>
		isIncluded(state, h.id),
	).length;
	const allIncluded = includedCount === file.hunks.length;
	const noneIncluded = includedCount === 0;
	const fileCheckRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (fileCheckRef.current) {
			fileCheckRef.current.indeterminate = !(allIncluded || noneIncluded);
		}
	}, [allIncluded, noneIncluded]);

	return (
		<div className="wdr-file">
			<div className="wdr-file-head">
				<input
					aria-label={`Include all hunks in ${file.path}`}
					checked={allIncluded}
					className="wdr-check"
					onChange={() => onToggleFile(file)}
					ref={fileCheckRef}
					type="checkbox"
				/>
				<button
					aria-expanded={!collapsed}
					className="wdr-file-toggle"
					data-collapsed={collapsed}
					onClick={() => onToggleCollapse(file.path)}
					type="button"
				>
					<Chevron />
				</button>
				<span className="wdr-file-path" title={file.path}>
					{file.path}
				</span>
				<span className="wdr-status" data-status={file.status}>
					{file.status}
				</span>
				<span className="wdr-file-stats wdr-stat-add">+{file.additions}</span>
				<span className="wdr-file-stats wdr-stat-del">-{file.deletions}</span>
			</div>
			{collapsed ? null : (
				<div className="wdr-hunks">
					{file.hunks.map((hunk) => (
						<HunkRow
							busy={busy}
							filePath={file.path}
							hunk={hunk}
							included={isIncluded(state, hunk.id)}
							key={hunk.id}
							onExplain={onExplain}
							onToggle={onToggleHunk}
						/>
					))}
				</div>
			)}
		</div>
	);
}

// ---- root ----

interface ActionNote {
	tone: "error" | "success";
	message: string;
}

export function DiffReview() {
	const rawOutput = useRyuGlobal("toolOutput");
	const rawInput = useRyuGlobal("toolInput");
	const rawState = useRyuGlobal("widgetState");

	const [state, setState] = useState<DiffWidgetState>(EMPTY_STATE);
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState<ActionNote | null>(null);
	const hydratedRef = useRef(false);

	// Hydrate local state from the host's persisted snapshot once it arrives.
	useEffect(() => {
		if (hydratedRef.current || rawState === undefined) {
			return;
		}
		hydratedRef.current = true;
		setState(normalizeState(rawState));
	}, [rawState]);

	// In bare dev preview the host injects nothing, so toolOutput stays undefined;
	// fall back to the sample so the widget is viewable. In the host it is present
	// synchronously (D2), so this stub never masks a real loading state.
	const output = rawOutput === undefined ? SAMPLE_OUTPUT : rawOutput;
	const runId =
		rawInput && typeof rawInput === "object"
			? ((rawInput as Record<string, unknown>).run_id as string | undefined)
			: undefined;

	const persist = useCallback((next: DiffWidgetState) => {
		setState(next);
		window.ryu?.setWidgetState(next).catch(() => {
			// Persistence is best-effort (D4); local state already reflects the change.
		});
	}, []);

	const valid = isReviewOutput(output);
	const files = valid ? output.files : [];

	const selectedHunkIds = useMemo(
		() => collectHunkIds(files).filter((id) => isIncluded(state, id)),
		[files, state],
	);
	const totalHunks = useMemo(() => collectHunkIds(files).length, [files]);

	// Explicitly report height on the structural changes a ResizeObserver may batch
	// late (collapse/expand), in addition to the WidgetRoot auto-height observer.
	useEffect(() => {
		if (typeof document !== "undefined") {
			window.ryu?.notifyIntrinsicHeight(
				Math.ceil(document.documentElement.scrollHeight),
			);
		}
	}, []);

	const toggleHunk = useCallback(
		(hunkId: string) => {
			const nextIncluded = { ...state.included };
			nextIncluded[hunkId] = !isIncluded(state, hunkId);
			persist({ ...state, included: nextIncluded });
		},
		[state, persist],
	);

	const toggleFile = useCallback(
		(file: DiffFile) => {
			const anyOff = file.hunks.some((h) => !isIncluded(state, h.id));
			const nextIncluded = { ...state.included };
			for (const hunk of file.hunks) {
				nextIncluded[hunk.id] = anyOff;
			}
			persist({ ...state, included: nextIncluded });
		},
		[state, persist],
	);

	const toggleCollapse = useCallback(
		(path: string) => {
			const nextCollapsed = { ...state.collapsed };
			nextCollapsed[path] = !(state.collapsed[path] === true);
			persist({ ...state, collapsed: nextCollapsed });
		},
		[state, persist],
	);

	const setPrTitle = useCallback(
		(value: string) => {
			persist({ ...state, prTitle: value });
		},
		[state, persist],
	);

	const explainHunk = useCallback((filePath: string, hunk: Hunk) => {
		const body = hunk.lines
			.map((line) => {
				const sign =
					line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
				return `${sign}${line.content}`;
			})
			.join("\n");
		const prompt = `Explain this diff hunk from \`${filePath}\`:\n\n\`\`\`diff\n${hunk.header}\n${body}\n\`\`\``;
		window.ryu?.sendFollowUpMessage({ prompt }).catch(() => {
			setNote({ tone: "error", message: "Could not send the follow-up." });
		});
	}, []);

	const runWrite = useCallback(
		async (tool: "apply" | "discard", hunkIds: string[], verb: string) => {
			if (!runId) {
				setNote({
					tone: "error",
					message: "No run id in scope for this diff.",
				});
				return;
			}
			if (hunkIds.length === 0) {
				setNote({ tone: "error", message: "Select at least one hunk first." });
				return;
			}
			setBusy(true);
			setNote(null);
			try {
				await window.ryu?.callTool(tool, { run_id: runId, hunk_ids: hunkIds });
				setNote({
					tone: "success",
					message: `${verb} ${hunkIds.length} hunk${hunkIds.length === 1 ? "" : "s"}.`,
				});
			} catch (error) {
				setNote({
					tone: "error",
					message: error instanceof Error ? error.message : `${verb} failed.`,
				});
			} finally {
				setBusy(false);
			}
		},
		[runId],
	);

	const openPr = useCallback(async () => {
		if (!runId) {
			setNote({ tone: "error", message: "No run id in scope for this diff." });
			return;
		}
		const title =
			state.prTitle.trim() ||
			(valid ? `Review: ${output.branch}` : "Open pull request");
		setBusy(true);
		setNote(null);
		try {
			await window.ryu?.callTool("open_pr", { run_id: runId, title });
			setNote({ tone: "success", message: "Pull request opened." });
		} catch (error) {
			setNote({
				tone: "error",
				message: error instanceof Error ? error.message : "Open PR failed.",
			});
		} finally {
			setBusy(false);
		}
	}, [runId, state.prTitle, valid, output]);

	if (!valid) {
		return (
			<div className="wdr">
				<div className="wdr-state">
					<strong>Could not read the diff.</strong>
					<span>The review tool returned an unexpected shape.</span>
				</div>
			</div>
		);
	}

	if (files.length === 0) {
		return (
			<div className="wdr">
				<div className="wdr-header">
					<span className="wdr-branch">
						<code>{output.branch}</code>
					</span>
				</div>
				<div className="wdr-state">
					<strong>No changes in this worktree.</strong>
					<span>Nothing to review against the base ref.</span>
				</div>
			</div>
		);
	}

	return (
		<div className="wdr">
			<div className="wdr-header">
				<span className="wdr-branch">
					<span aria-hidden="true">⎇</span>
					<code>{output.branch}</code>
				</span>
				<span className="wdr-summary">
					<span>
						{output.summary.files} file{output.summary.files === 1 ? "" : "s"}
					</span>
					<span className="wdr-stat-add">+{output.summary.additions}</span>
					<span className="wdr-stat-del">-{output.summary.deletions}</span>
				</span>
			</div>
			<div className="wdr-worktree" title={output.worktree_path}>
				{output.worktree_path}
			</div>

			<div className="wdr-toolbar">
				<span className="wdr-selcount">
					{selectedHunkIds.length} / {totalHunks} hunks selected
				</span>
				<span className="wdr-toolbar-spacer" />
				<button
					className="wdr-btn wdr-btn-danger"
					disabled={busy || selectedHunkIds.length === 0}
					onClick={() => runWrite("discard", selectedHunkIds, "Discarded")}
					type="button"
				>
					Discard selected
				</button>
				<button
					className="wdr-btn wdr-btn-primary"
					disabled={busy || selectedHunkIds.length === 0}
					onClick={() => runWrite("apply", selectedHunkIds, "Applied")}
					type="button"
				>
					Apply selected
				</button>
			</div>

			{note ? (
				<div aria-live="polite" className="wdr-note" data-tone={note.tone}>
					{note.message}
				</div>
			) : null}

			<div className="wdr-files">
				{files.map((file) => (
					<FileBlock
						busy={busy}
						file={file}
						key={file.path}
						onExplain={explainHunk}
						onToggleCollapse={toggleCollapse}
						onToggleFile={toggleFile}
						onToggleHunk={toggleHunk}
						state={state}
					/>
				))}
			</div>

			<div className="wdr-linkline">
				<input
					aria-label="Pull request title"
					className="wdr-pr-title"
					onChange={(event) => setPrTitle(event.target.value)}
					placeholder={`Review: ${output.branch}`}
					type="text"
					value={state.prTitle}
				/>
				<button
					className="wdr-btn"
					disabled={busy}
					onClick={openPr}
					type="button"
				>
					Open PR
				</button>
			</div>
		</div>
	);
}

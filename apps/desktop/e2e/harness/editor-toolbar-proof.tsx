import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MarkdownEditor as SkillMarkdownEditor } from "../../../../apps-store/skill-editor/ui/src/MarkdownEditor.tsx";
import { MarkdownEditor as PageMarkdownEditor } from "../../src/components/editor/MarkdownEditor.tsx";
import "../../src/index.css";

const PAGE_MARKDOWN = `# Page editor proof

Select this text and open the floating rail to explore the nested editor tools.

- Page editor uses PlateJS
- The rail is shared with the skill editor`;

const SKILL_MARKDOWN = `# Skill editor proof

Select this text and use Format or Blocks from the floating rail.`;

function EditorToolbarProof() {
	const [surface, setSurface] = useState<"page" | "skill">("page");
	const [pageMarkdown, setPageMarkdown] = useState(PAGE_MARKDOWN);
	const [skillMarkdown, setSkillMarkdown] = useState(SKILL_MARKDOWN);

	return (
		<main className="min-h-screen overflow-auto bg-background px-4 py-6 pb-32 text-foreground sm:px-8 sm:py-10">
			<div className="mx-auto flex max-w-4xl flex-col gap-6">
				<header className="flex flex-col gap-4 border-b pb-6 sm:flex-row sm:items-start sm:justify-between">
					<div>
						<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
							React verification artifact
						</p>
						<h1 className="mt-2 font-semibold text-3xl tracking-tight">
							Nested editor toolbar
						</h1>
						<p className="mt-2 max-w-2xl text-muted-foreground text-sm leading-6">
							Space pages keep history, basic formatting, and AI in the compact
							rail. Open it to reveal the full toolset in a two-row grid. The
							Skill editor keeps its existing nested rail.
						</p>
					</div>
					<div
						className="inline-flex w-fit items-center rounded-full border border-success/30 bg-success/10 px-3 py-1.5 font-semibold text-success text-xs dark:text-success"
						data-testid="proof-status"
					>
						Shared primitive mounted
					</div>
				</header>

				<nav
					aria-label="Editor surface"
					className="flex w-fit items-center gap-1 rounded-full border bg-card p-1"
				>
					<SurfaceButton
						active={surface === "page"}
						label="Page editor"
						onClick={() => setSurface("page")}
					/>
					<SurfaceButton
						active={surface === "skill"}
						label="Skill editor"
						onClick={() => setSurface("skill")}
					/>
				</nav>

				<section
					aria-label={`${surface === "page" ? "Page" : "Skill"} editor proof`}
					className="rounded-2xl border bg-card shadow-sm"
					data-testid={`editor-surface-${surface}`}
				>
					<div className="flex items-center justify-between border-b px-5 py-4">
						<div>
							<h2 className="font-semibold text-lg">
								{surface === "page" ? "Page editor" : "Skill editor"}
							</h2>
							<p className="mt-1 text-muted-foreground text-sm">
								{surface === "page"
									? "PlateJS rich text with a compact rail and two-row expanded tools."
									: "Plain Markdown with the shared rail and working text transforms."}
							</p>
						</div>
						<code className="rounded bg-muted px-2 py-1 text-muted-foreground text-xs">
							{surface === "page" ? "PlateJS" : "Markdown"}
						</code>
					</div>
					<div className="h-[440px] overflow-hidden px-4 py-4 sm:px-8">
						{surface === "page" ? (
							<PageMarkdownEditor
								initialMarkdown={pageMarkdown}
								onChangeMarkdown={setPageMarkdown}
								toolbar="two-row"
							/>
						) : (
							<SkillMarkdownEditor
								initialMarkdown={skillMarkdown}
								onChangeMarkdown={setSkillMarkdown}
							/>
						)}
					</div>
				</section>

				<div className="grid gap-3 text-sm sm:grid-cols-3">
					<ProofNote
						label="Quick actions"
						value="Undo, redo, bold, italic, and AI stay visible"
					/>
					<ProofNote
						label="Expanded"
						value="The remaining tool groups fit in a two-row grid"
					/>
					<ProofNote
						label="Scope"
						value="Skill editor keeps its current nested toolbar"
					/>
				</div>
			</div>
		</main>
	);
}

function SurfaceButton({
	active,
	label,
	onClick,
}: {
	active: boolean;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			aria-pressed={active}
			className={`rounded-full px-3 py-1.5 font-medium text-sm transition-colors ${active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
			onClick={onClick}
			type="button"
		>
			{label}
		</button>
	);
}

function ProofNote({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-xl border bg-card p-3">
			<div className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
				{label}
			</div>
			<div className="mt-1 leading-5">{value}</div>
		</div>
	);
}

createRoot(document.getElementById("root")!).render(<EditorToolbarProof />);

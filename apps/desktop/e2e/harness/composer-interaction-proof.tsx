import { InputBar } from "@ryu/blocks/desktop/agent-elements/input-bar.tsx";
import type { QuestionConfig } from "@ryu/blocks/desktop/agent-elements/question/question-prompt.tsx";
import { useDeferredComposerPrompt } from "@ryu/blocks/desktop/agent-elements/use-deferred-question.ts";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
	type ActivePermission,
	PermissionPrompt,
} from "../../src/components/chat/PermissionPrompt.tsx";
import "../../src/index.css";

const QUESTION: QuestionConfig = {
	allowCustom: true,
	customLabel: "Other",
	customPlaceholder: "Tell me what you need",
	description: "Choose a workspace, or tell the agent what you need.",
	kind: "single",
	options: [
		{ id: "workspace", label: "Use the current workspace" },
		{ id: "scratch", label: "Use a scratch folder" },
	],
	title: "Where should I continue?",
};

const TEXT_QUESTION: QuestionConfig = {
	description: "The agent needs a short written response before it continues.",
	kind: "text",
	placeholder: "Describe what should happen next",
	title: "What should I do next?",
};

const PERMISSION: ActivePermission = {
	options: [
		{ kind: "allow_once", name: "Allow once", optionId: "allow-once" },
		{ kind: "allow_always", name: "Always allow", optionId: "allow-always" },
		{ kind: "reject_once", name: "Reject", optionId: "reject-once" },
	],
	requestId: "proof-permission",
	toolCall: {
		kind: "execute",
		rawInput: {
			command: "rg --files src | sort | head -20",
			cwd: "/workspace/ryu",
		},
		title: "list workspace files",
	},
};

type PromptMode = "composer" | "question" | "text-question" | "permission";

function Story() {
	const [draft, setDraft] = useState("");
	const [mode, setMode] = useState<PromptMode>("composer");
	const questionDeferred = useDeferredComposerPrompt(
		mode === "question"
			? QUESTION
			: mode === "text-question"
				? TEXT_QUESTION
				: null,
		450
	);
	const permissionDeferred = useDeferredComposerPrompt(
		mode === "permission" ? PERMISSION : null,
		450
	);
	const questionVisible = questionDeferred.visiblePrompt;
	const permissionVisible = permissionDeferred.visiblePrompt;

	const handleDraftChange = (next: string) => {
		setDraft(next);
		if (next.length > 0) {
			questionDeferred.markComposerActivity();
			permissionDeferred.markComposerActivity();
		} else {
			questionDeferred.markComposerIdle();
			permissionDeferred.markComposerIdle();
		}
	};
	const returnToComposer = () => {
		setMode("composer");
		questionDeferred.markComposerIdle();
		permissionDeferred.markComposerIdle();
	};

	return (
		<main className="min-h-screen bg-background px-6 py-8 text-foreground">
			<div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
				<div className="space-y-1">
					<p className="font-medium text-muted-foreground text-sm uppercase tracking-(--tracking-section)">
						Composer interaction proof
					</p>
					<h1 className="font-semibold text-2xl tracking-tight">
						Human input takes over the composer
					</h1>
					<p className="max-w-2xl text-muted-foreground text-sm">
						Both pending questions and tool approvals wait for typing to settle,
						then morph the same composer surface into the decision card.
					</p>
				</div>

				<div className="flex flex-wrap gap-2" role="toolbar">
					<button
						className="rounded-full border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
						onClick={() => setMode("composer")}
						type="button"
					>
						Normal composer
					</button>
					<button
						className="rounded-full border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
						onClick={() => setMode("question")}
						type="button"
					>
						Show question with Other
					</button>
					<button
						className="rounded-full border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
						onClick={() => setMode("text-question")}
						type="button"
					>
						Show text question
					</button>
					<button
						className="rounded-full border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
						onClick={() => setMode("permission")}
						type="button"
					>
						Show tool approval
					</button>
					<output
						className="ml-2 self-center text-muted-foreground text-xs"
						data-testid="mode"
					>
						{mode}
					</output>
				</div>

				<div
					className="rounded-3xl border border-border/70 bg-card/40 p-3 shadow-sm"
					data-testid="composer-shell"
				>
					<InputBar
						composerPrompt={
							permissionVisible
								? {
										content: (
											<PermissionPrompt
												embedded
												onRespond={returnToComposer}
												permission={permissionVisible}
											/>
										),
										id: permissionVisible.requestId,
									}
								: undefined
						}
						onChange={handleDraftChange}
						onSend={() => undefined}
						onStop={() => undefined}
						questionBar={
							questionVisible
								? {
										allowSkip: false,
										id: "proof-question",
										onSubmit: returnToComposer,
										questions: [questionVisible],
										submitLabel: "Continue",
									}
								: undefined
						}
						status="ready"
						value={draft}
						voice={{
							transcribe: async () => "A spoken answer",
						}}
					/>
				</div>

				<div className="grid gap-3 sm:grid-cols-3">
					<div className="rounded-2xl border border-border/70 bg-muted/30 p-3">
						<p className="font-medium text-sm">One surface</p>
						<p className="mt-1 text-muted-foreground text-xs">
							The textarea and decision card share the same animated shell.
						</p>
					</div>
					<div className="rounded-2xl border border-border/70 bg-muted/30 p-3">
						<p className="font-medium text-sm">Typing-safe</p>
						<p className="mt-1 text-muted-foreground text-xs">
							450ms in this proof; production uses the shared 2.5s idle window.
						</p>
					</div>
					<div className="rounded-2xl border border-border/70 bg-muted/30 p-3">
						<p className="font-medium text-sm">One active request</p>
						<p className="mt-1 text-muted-foreground text-xs">
							The pending card replaces the editor instead of duplicating the
							tool row.
						</p>
					</div>
				</div>
			</div>
		</main>
	);
}

const container = document.getElementById("root");
if (container) {
	createRoot(container).render(<Story />);
}

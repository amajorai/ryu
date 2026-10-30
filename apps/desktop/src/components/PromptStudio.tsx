// apps/desktop/src/components/PromptStudio.tsx
//
// Prompt Studio - a focused authoring surface for agent system prompts.
// Provides a multi-line prompt editor with variable placeholder support
// ({{variable_name}} syntax), a one-shot preview that runs the draft prompt
// against the agent's bound engine, AND a promptfoo-style Test-cases runner.
//
// The preview works by sending the draft prompt as a user message framing,
// since `ChatStreamRequest` has no system_prompt override field. The agent's
// bound engine handles the actual inference.
//
// The Test-cases runner is the gateway-backed path: it sends the draft prompt as
// `system_prompt` (the server substitutes {{vars}} per case and prepends it as a
// system message), the cases as `dataset` (with per-case vars + assertions), and
// the selected model(s). Results are rendered as a per-case × per-model matrix
// with per-assertion pass/fail chips. Prompt history is stored by Core so it is
// durable and shared across desktop sessions.

import { Cancel01Icon, LockedIcon, PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownEditor } from "@/src/components/editor/MarkdownEditor.tsx";
import { PromptLibrary } from "@/src/components/PromptLibrary.tsx";
import { VersionHistory } from "@/src/components/versioning/VersionHistory.tsx";
import {
	createAgentPromptVersion,
	getAgentPromptVersion,
	listAgentPromptVersions,
	restoreAgentPromptVersion,
} from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	escapePromptPlaceholdersForEditor,
	extractPlaceholders,
	hasPromptContent,
	normalizePromptPlaceholders,
	renderPrompt,
} from "./PromptStudio-format.ts";
import { PreviewPanel } from "./PromptStudio-preview-panel.tsx";
import { PromptTestCases } from "./PromptStudio-test-cases.tsx";

// ── Props ──────────────────────────────────────────────────────────────────────

export interface PromptStudioProps {
	/** The agent id used to send the preview chat request. */
	agentId: string | null;
	/** The execution engine. ACP engines bypass the Gateway eval route. */
	engine?: string;
	/** When true, all editing is disabled. Shows a locked affordance. */
	locked: boolean;
	/**
	 * The agent's selected gateway model used for eval/test runs. Defaults to "".
	 */
	model?: string;
	/** Called when the user edits the prompt text. */
	onChange: (value: string) => void;
	/** Core API target (url + token) for the preview request. */
	target: ApiTarget;
	/** Current draft system prompt value (controlled from the parent). */
	value: string;
	/** Current saved version of the agent. Displayed alongside the editor. */
	version: string;
}

// ── Component ──────────────────────────────────────────────────────────────────

export function PromptStudio({
	value,
	onChange,
	locked,
	agentId,
	target,
	version,
	model = "",
	engine = "",
}: PromptStudioProps) {
	const tl = useLiteralMessages();
	const [editorRevision, setEditorRevision] = useState(0);
	const lastEditorValueRef = useRef(value);
	// Variable values entered by the user for the preview substitution.
	const [varValues, setVarValues] = useState<Record<string, string>>({});
	// Whether the preview panel is open.
	const [previewOpen, setPreviewOpen] = useState(false);
	// A stable, ephemeral conversation id per preview session so Core doesn't
	// accumulate junk conversation rows across many preview runs.
	const previewConvIdRef = useRef<string>(`preview-${crypto.randomUUID()}`);

	const placeholders = useMemo(() => extractPlaceholders(value), [value]);
	useEffect(() => {
		if (lastEditorValueRef.current === value) {
			return;
		}
		lastEditorValueRef.current = value;
		setEditorRevision((revision) => revision + 1);
	}, [value]);
	const promptVersionScope = useMemo(
		() => ({}),
		[agentId, target.url, target.token, target.userJwt]
	);
	const activePromptVersionScope = useRef(promptVersionScope);
	activePromptVersionScope.current = promptVersionScope;
	const promptVersionMounted = useRef(true);
	useEffect(() => {
		promptVersionMounted.current = true;
		return () => {
			promptVersionMounted.current = false;
		};
	}, []);
	const promptVersionSource = useMemo(() => {
		if (!agentId) {
			return null;
		}
		return {
			scope: promptVersionScope,
			getValue: (versionId: string) =>
				getAgentPromptVersion(target, agentId, versionId),
			list: async () =>
				(await listAgentPromptVersions(target, agentId)).map((saved) => ({
					createdAt: saved.createdAt,
					id: saved.id,
					label: saved.label,
				})),
			restore: async (versionId: string) => {
				const restored = await restoreAgentPromptVersion(
					target,
					agentId,
					versionId
				);
				if (
					!promptVersionMounted.current ||
					activePromptVersionScope.current !== promptVersionScope
				) {
					return;
				}
				onChange(restored);
			},
			snapshot: () => createAgentPromptVersion(target, agentId, value),
		};
	}, [agentId, onChange, target, value, promptVersionScope]);

	// Reset unknown var values when the placeholder set changes — avoid stale keys
	// polluting the rendered prompt.
	// varValues is read but deliberately excluded to avoid an update loop; only the placeholder set drives the reset.
	useEffect(() => {
		const kept: Record<string, string> = {};
		for (const name of placeholders) {
			kept[name] = varValues[name] ?? "";
		}
		setVarValues(kept);
	}, [placeholders]);

	const handleVarChange = useCallback((name: string, val: string) => {
		setVarValues((prev) => ({ ...prev, [name]: val }));
	}, []);

	const handleOpenPreview = useCallback(() => {
		// Rotate the ephemeral conversation id on each open so Core doesn't confuse
		// repeated previews with a real conversation.
		previewConvIdRef.current = `preview-${crypto.randomUUID()}`;
		setPreviewOpen(true);
	}, []);

	const handleClosePreview = useCallback(() => {
		setPreviewOpen(false);
	}, []);

	return (
		<div className="flex flex-col gap-4">
			{/* Header */}
			<div className="flex items-center gap-2">
				<span className="font-medium text-base">Prompt Studio</span>
				<Badge className="ml-1" size="compact" variant="secondary">
					v{version}
				</Badge>
				<div className="ml-auto flex items-center gap-2">
					<PromptLibrary
						currentPrompt={value}
						locked={locked}
						onUsePrompt={onChange}
						target={target}
					/>
					{promptVersionSource ? (
						<VersionHistory
							currentValue={value}
							disabled={locked}
							source={promptVersionSource}
						/>
					) : null}
					{locked ? (
						<Badge variant="secondary">
							<HugeiconsIcon className="size-3" icon={LockedIcon} />
							Locked — read only
						</Badge>
					) : null}
				</div>
			</div>

			{locked ? (
				<p className="text-muted-foreground text-xs">
					This agent is locked. Unlock it from the settings before editing the
					system prompt.
				</p>
			) : null}

			{/* Editor */}
			<div className="flex flex-col gap-2">
				<Label htmlFor="prompt-studio-editor">
					System prompt
					{placeholders.length > 0 ? (
						<span className="ml-2 font-normal text-muted-foreground text-xs">
							{tl(
								"— {count, plural, one {# variable} other {# variables}} detected",
								{ count: placeholders.length }
							)}
						</span>
					) : null}
				</Label>
				{locked ? (
					<div
						className="min-h-48 whitespace-pre-wrap rounded-md bg-muted/30 p-3 font-mono text-muted-foreground text-sm"
						id="prompt-studio-editor"
					>
						{value || "No system prompt set."}
					</div>
				) : (
					// Rich Markdown editor (PlateJS) for the agent instructions. Keyed by
					// agent so it re-mounts with fresh content when the agent changes
					// (the editor deserializes initialMarkdown once on mount).
					<div className="rounded-md border" id="prompt-studio-editor">
						<MarkdownEditor
							initialMarkdown={escapePromptPlaceholdersForEditor(value)}
							key={`${agentId ?? "new"}:${editorRevision}`}
							onChangeMarkdown={(markdown) => {
								const nextValue = normalizePromptPlaceholders(markdown);
								lastEditorValueRef.current = nextValue;
								onChange(nextValue);
							}}
						/>
					</div>
				)}
				<p className="text-muted-foreground text-xs">
					Use{" "}
					<code className="type-caption rounded bg-muted px-1 font-mono">
						{"{{variable_name}}"}
					</code>{" "}
					for named placeholders. Fill them in below before previewing.
				</p>
			</div>

			{/* Variable fill-in area */}
			{placeholders.length > 0 ? (
				<div className="flex flex-col gap-3 rounded-lg bg-muted/30 p-3">
					<p className="font-medium text-xs">Preview variables</p>
					<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
						{placeholders.map((name) => (
							<div className="flex flex-col gap-1" key={name}>
								<Label htmlFor={`var-${name}`} size="compact">
									{name}
								</Label>
								<Input
									autoComplete="off"
									id={`var-${name}`}
									name={`preview-variable-${name}`}
									onChange={(e) => handleVarChange(name, e.target.value)}
									placeholder={`Value for {{${name}}}`}
									size="compact"
									value={varValues[name] ?? ""}
								/>
							</div>
						))}
					</div>
				</div>
			) : null}

			{/* Test-cases runner (gateway-backed, system-prompt-aware) */}
			<PromptTestCases
				agentId={agentId}
				engine={engine}
				locked={locked}
				model={model}
				onPromptChange={onChange}
				promptDraft={value}
				target={target}
			/>

			{/* Preview trigger */}
			<div className="flex items-center gap-2">
				<Button
					disabled={!(agentId && hasPromptContent(value))}
					onClick={handleOpenPreview}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-3" icon={PlayIcon} />
					Preview prompt
				</Button>
				{previewOpen ? (
					<Button onClick={handleClosePreview} size="sm" variant="ghost">
						<HugeiconsIcon className="size-3" icon={Cancel01Icon} />
						Close preview
					</Button>
				) : null}
			</div>

			{/* Inline preview panel */}
			{previewOpen && agentId ? (
				<PreviewPanel
					agentId={agentId}
					convId={previewConvIdRef.current}
					prompt={renderPrompt(value, varValues)}
					target={target}
				/>
			) : null}
		</div>
	);
}

"use client";

import { ArrowExpand01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComposerModelSection } from "@ryu/blocks/composer/composer-acp-sections.ts";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { ComposerEditor } from "@ryu/ui/components/editor/composer-editor.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useEffect, useMemo, useState } from "react";
import { useComposerAgentControls } from "@/components/agent-elements/input/composer-agent-controls.tsx";
import { MarkdownEditor } from "@/src/components/editor/MarkdownEditor.tsx";
import { useEngineModelsState } from "@/src/hooks/useEngineModels.ts";
import {
	agentIdForEngine,
	engineForAgentSelection,
} from "@/src/lib/agent-engine.ts";
import type { AgentIdentityMode, AgentSummary } from "@/src/lib/api/agents.ts";
import { modelsForAgent } from "@/src/lib/models.ts";

export interface AgentSetupComposerProps {
	agents: AgentSummary[];
	className?: string;
	disabled?: boolean;
	/** Runtime/agent selection, e.g. `acp:pi` or `acp:claude`. */
	engine: string;
	/** One line under the engine picker about how the engine runs. */
	engineNote?: string | null;
	/** The agent's identity mode, which can decide which engines start. */
	identityMode?: AgentIdentityMode;
	instructions: string;
	model: string;
	/** Provider/runtime saved in the agent's chat-model slot. */
	modelEngine: string | null;
	onEngineChange: (engine: string) => void;
	onInstructionsChange: (instructions: string) => void;
	onModelChange: (model: string) => void;
	onModelEngineChange: (engine: string | null) => void;
	placeholder?: string;
}

/**
 * The compact agent setup surface: instructions and the same agent/provider
 * controls used by chat live in one composer. The editor expands into the full
 * PlateJS Markdown surface, so setup starts simple without creating a second
 * writing experience.
 */
export function AgentSetupComposer({
	agents,
	disabled = false,
	engine,
	engineNote = null,
	identityMode,
	instructions,
	model,
	modelEngine,
	onEngineChange,
	onInstructionsChange,
	onModelChange,
	onModelEngineChange,
	placeholder = "Describe what this agent should do, and how it should behave…",
	className,
}: AgentSetupComposerProps) {
	const [expanded, setExpanded] = useState(false);
	const selectableAgents = useMemo(
		() => agents.filter((agent) => agent.lifecycleStatus !== "draft"),
		[agents]
	);
	const { models: engineModels, settled: engineModelsSettled } =
		useEngineModelsState();
	const agentId = agentIdForEngine(engine, selectableAgents);
	const modelOptions = useMemo(() => {
		const options = modelsForAgent(agentId, selectableAgents, engineModels);
		if (model && !options.some((option) => option.id === model)) {
			return [{ id: model, name: model }, ...options];
		}
		return options;
	}, [agentId, engineModels, model, selectableAgents]);
	const modelSection = useMemo<ComposerModelSection>(
		() => ({
			items: modelOptions.map((option) => ({
				id: option.id,
				name: option.name,
			})),
			onChange: onModelChange,
			value: model || undefined,
		}),
		[model, modelOptions, onModelChange]
	);

	// A newly selected runtime should always have a usable model in the bottom
	// control. Existing non-empty selections are preserved so an explicitly saved
	// model that is not in the offline catalog is never erased while it loads.
	// The pick waits for Core's catalog to answer: the composer can mount with
	// the engine already known (the New agent dialog's details step follows its
	// identity step), and picking from the offline fallback then would keep a
	// placeholder model instead of Core's default.
	useEffect(() => {
		if (engine && !model && engineModelsSettled && modelOptions.length > 0) {
			onModelChange(modelOptions[0].id);
		}
	}, [engine, engineModelsSettled, model, modelOptions, onModelChange]);

	const handleSelectAgent = (nextAgentId: string) => {
		const nextAgent = selectableAgents.find(
			(agent) => agent.id === nextAgentId
		);
		if (!nextAgent) {
			return;
		}
		onEngineChange(engineForAgentSelection(nextAgent));
		onModelEngineChange(null);
		const nextModels = modelsForAgent(
			nextAgentId,
			selectableAgents,
			engineModels
		);
		onModelChange(nextModels[0]?.id ?? "");
	};

	const handleUseProvider = (providerId: string, modelId: string | null) => {
		onModelEngineChange(providerId);
		if (modelId) {
			onModelChange(modelId);
		}
	};

	const handleSelectProviderModel = (providerId: string, modelId: string) => {
		onModelEngineChange(providerId);
		onModelChange(modelId);
	};

	const controls = useComposerAgentControls({
		agentId,
		agents: selectableAgents,
		extraSections: [],
		forceModelPicker: true,
		model: model || null,
		modelOptions,
		modelSection,
		onModelChange,
		onSelectAgent: handleSelectAgent,
		onSelectProviderModel: handleSelectProviderModel,
		onSelectProviderThinking: () => undefined,
		onUseProvider: handleUseProvider,
		placement: "composer",
		surface: "dashboard",
	});

	const renderPicker = () => (
		<div className="flex min-w-0 items-center" data-testid="agent-setup-picker">
			{controls.picker}
		</div>
	);

	return (
		<div
			className={cn(
				"overflow-hidden rounded-2xl border border-border bg-muted/50",
				className
			)}
			data-identity-mode={identityMode}
			data-model-engine={modelEngine ?? undefined}
			data-testid="agent-setup-composer"
		>
			<div className="min-h-36 px-4 pt-3 pb-2">
				<ComposerEditor
					disabled={disabled}
					markdown={instructions}
					onChange={onInstructionsChange}
					placeholder={placeholder}
				/>
			</div>
			<div className="flex h-10 items-center justify-between gap-2 px-2">
				{expanded ? <span /> : renderPicker()}
				<Button
					aria-label="Expand instructions editor"
					disabled={disabled}
					onClick={() => setExpanded(true)}
					size="icon-sm"
					title="Expand instructions editor"
					variant="ghost-muted"
				>
					<HugeiconsIcon className="size-4" icon={ArrowExpand01Icon} />
				</Button>
			</div>
			{engineNote ? (
				<p
					className="border-border border-t px-4 py-2 text-detail text-muted-foreground"
					data-testid="agent-setup-engine-note"
				>
					{engineNote}
				</p>
			) : null}

			<Dialog onOpenChange={setExpanded} open={expanded}>
				<DialogContent
					appearance="agent-editor"
					data-testid="agent-setup-full-editor"
				>
					<DialogHeader className="shrink-0" purpose="agent-editor">
						<DialogTitle>Agent instructions</DialogTitle>
						<DialogDescription>
							Write in Markdown, then choose the agent and model from the same
							composer controls below.
						</DialogDescription>
					</DialogHeader>
					<div className="min-h-0 flex-1 overflow-hidden px-2">
						<MarkdownEditor
							initialMarkdown={instructions}
							onChangeMarkdown={onInstructionsChange}
							toolbar="inline"
						/>
					</div>
					<DialogFooter
						className="shrink-0 items-center justify-between sm:flex-row sm:justify-between"
						purpose="agent-editor"
					>
						{renderPicker()}
						<Button onClick={() => setExpanded(false)} type="button">
							Done
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

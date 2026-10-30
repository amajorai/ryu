import {
	ArrowDown01Icon,
	ArrowTurnBackwardIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Input } from "@ryu/ui/components/input.tsx";
import { useState } from "react";
import {
	AgentAvatar,
	AgentLogo,
	engineForAgent,
} from "@/src/lib/agent-logos.tsx";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import type { AgentSelection } from "@/src/lib/api/preferences.ts";
import { ProviderBrandLogo } from "@/src/lib/provider-brand.tsx";

/** Non-empty sentinel: Base UI Select is unreliable with empty-string values. */
export const INHERIT = "__inherit__";

/** Map a Pi provider id to its brand-logo key (mirrors `useUniversalPicker`). */
export const PROVIDER_ENGINE_KEY = new Map<string, string>([
	["google", "gemini"],
	["claude-pro-max", "claude"],
	["openai-codex", "codex"],
	["chatgpt", "chatgpt"],
]);

export const NOOP = () => {
	// Field mode never reaches the composer-only actions (upsell / install /
	// configure-credentials / live save).
};

/** Free-text escape hatch: local, pinned and fine-tuned ids are in no catalog. */
export function CustomModelRow({
	current,
	onCommit,
}: {
	current: string;
	onCommit: (id: string) => void;
}) {
	const [draft, setDraft] = useState(current);
	const commit = () => {
		const next = draft.trim();
		if (next) {
			onCommit(next);
		}
	};
	return (
		<div>
			<span className="px-1.5 pb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
				Custom model
			</span>
			<div className="flex items-center gap-1">
				<Input
					aria-label="Custom model id"
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						e.stopPropagation();
						if (e.key === "Enter") {
							e.preventDefault();
							commit();
						}
					}}
					placeholder="Any model id (e.g. a local or pinned model)"
					purpose="model-identifier"
					value={draft}
				/>
				<button
					aria-label="Use this model"
					className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/40 hover:text-foreground disabled:opacity-40"
					disabled={!draft.trim()}
					onClick={commit}
					type="button"
				>
					<HugeiconsIcon icon={ArrowDown01Icon} size={14} />
				</button>
			</div>
		</div>
	);
}

/** "Use the default" row — the only way back to an unset field once picked. */
export function InheritRow({ onClear }: { onClear: () => void }) {
	return (
		<div>
			<button
				className="text-(length:--text-detail) flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
				onClick={onClear}
				type="button"
			>
				<HugeiconsIcon icon={ArrowTurnBackwardIcon} size={14} />
				<span>Use the default</span>
			</button>
		</div>
	);
}

/** The trigger's leading brand/agent mark for the current selection, or null. */
export function SelectionMark({
	agent,
	selection,
}: {
	agent: AgentSummary | null;
	selection: AgentSelection;
}) {
	if (selection.agent_id) {
		if (agent?.avatarGlyph) {
			return (
				<AgentAvatar
					className="size-4 shrink-0 object-contain"
					engine={agent ? engineForAgent(agent) : null}
					glyph={agent.avatarGlyph}
					size="16px"
				/>
			);
		}
		return (
			<AgentLogo
				className="size-4 shrink-0"
				engine={agent ? engineForAgent(agent) : null}
				size="16px"
			/>
		);
	}
	if (selection.provider) {
		return (
			<ProviderBrandLogo
				className="size-4 shrink-0"
				providerKey={selection.provider}
				size={16}
			/>
		);
	}
	return null;
}

/** One-line summary of a selection, e.g. `Claude Code · plan` or `gpt-5 · high`. */
export function summarize(
	selection: AgentSelection,
	agent: AgentSummary | null
): string {
	const parts: string[] = [];
	if (selection.agent_id) {
		parts.push(agent?.name ?? selection.agent_id);
		if (selection.model) {
			parts.push(selection.model);
		}
		if (selection.access_mode) {
			parts.push(selection.access_mode);
		}
	} else if (selection.model) {
		parts.push(selection.model);
	}
	if (selection.thinking_level) {
		parts.push(selection.thinking_level);
	}
	if (selection.effort && selection.effort !== selection.thinking_level) {
		parts.push(selection.effort);
	}
	return parts.join(" · ");
}

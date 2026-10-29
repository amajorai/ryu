import { useProviderCatalog } from "@/src/hooks/provider-query-scope.ts";
// apps/desktop/src/components/settings/shared/SideModelPicker.tsx
//
// Shared "model + effort" picker for side models — used by the double-check
// reviewer, the goal judge, meetings and chat-rename settings. The model field
// is the SAME universal provider→model picker the chat composer and plugin
// settings use (`AgentModelPickerField`), so every surface gets one consistent
// picker: brand logos, per-provider model lists, live discovery, and a
// free-text custom row for anything gateway-routable the catalog doesn't list
// (e.g. `openrouter/google/gemini-...`). Picking from a provider's list also
// records that provider as the routing hint; a free-typed id clears it. Effort
// is forwarded as `reasoning_effort` by Core (reaches OpenAI-compatible /
// local / OpenRouter providers; Anthropic-direct ignores it).

import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { AgentModelPickerField } from "@/components/agent-elements/input/agent-model-picker-field.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { SideModelConfig } from "@/src/lib/api/preferences.ts";

// Non-empty sentinel: Base UI Select is unreliable with empty-string values, so
// "provider default" uses a real token mapped to "" at the edge.
const DEFAULT_EFFORT = "__default__";

interface SelItem {
	label: string;
	value: string;
}

export interface SideModelPickerProps {
	onChange: (cfg: SideModelConfig) => void;
	target: ApiTarget;
	value: SideModelConfig;
}

export function SideModelPicker({
	value,
	onChange,
	target,
}: SideModelPickerProps) {
	const { data: catalog } = useProviderCatalog(target, {});

	const effortItems: SelItem[] = [
		{ value: DEFAULT_EFFORT, label: "Provider default" },
		...(catalog?.thinkingLevels ?? []).map((l) => ({ value: l, label: l })),
	];
	const effortValue = value.effort || DEFAULT_EFFORT;

	return (
		<div className="space-y-3">
			<div className="flex flex-col gap-1.5">
				<Label size="compact" tone="muted">
					Model
				</Label>
				<AgentModelPickerField
					ariaLabel="Model"
					mode="model"
					onChange={(model) => onChange({ ...value, model })}
					onModelPick={(providerId, model) =>
						onChange({ ...value, provider: providerId ?? "", model })
					}
					placeholder="Use default model"
					target={target}
					value={value.model}
				/>
			</div>

			<div className="flex flex-col gap-1.5">
				<Label size="compact" tone="muted">
					Thinking / effort level
				</Label>
				<Select
					items={effortItems}
					onValueChange={(v) =>
						onChange({ ...value, effort: v && v !== DEFAULT_EFFORT ? v : "" })
					}
					value={effortValue}
				>
					<SelectTrigger className="h-8">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{effortItems.map((it) => (
							<SelectItem key={it.value} value={it.value}>
								{it.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
		</div>
	);
}

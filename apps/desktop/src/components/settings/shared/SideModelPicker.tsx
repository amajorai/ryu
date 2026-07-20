// apps/desktop/src/components/settings/shared/SideModelPicker.tsx
//
// Shared "provider + model + effort" picker for side models — used by both the
// double-check reviewer and the goal judge. The provider/model dropdowns are
// SUGGESTIONS, never a hard constraint: the stored model is a free,
// gateway-routable id (you can type any model the Gateway can route, e.g.
// `openrouter/google/gemini-...`), and the provider/effort lists come from the
// Pi config catalog (`/api/pi-config/catalog`) only to help pick. Effort is
// forwarded as `reasoning_effort` by Core (reaches OpenAI-compatible / local /
// OpenRouter providers; Anthropic-direct ignores it).

import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { useQuery } from "@tanstack/react-query";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { fetchPiCatalog } from "@/src/lib/api/pi-config.ts";
import type { SideModelConfig } from "@/src/lib/api/preferences.ts";

// Non-empty sentinels: Base UI Select is unreliable with empty-string values, so
// "any provider" / "provider default" use real tokens mapped to "" at the edge.
const ANY_PROVIDER = "__any__";
const DEFAULT_EFFORT = "__default__";

interface SelItem {
	label: string;
	value: string;
}

export interface SideModelPickerProps {
	onChange: (cfg: SideModelConfig) => void;
	/** Show the provider suggestion dropdown (default true). */
	showProvider?: boolean;
	target: ApiTarget;
	value: SideModelConfig;
}

export function SideModelPicker({
	value,
	onChange,
	target,
	showProvider = true,
}: SideModelPickerProps) {
	const { data: catalog } = useQuery({
		queryKey: ["pi-catalog", target.url],
		queryFn: () => fetchPiCatalog(target),
	});

	const providers = catalog?.providers ?? [];
	const providerItems: SelItem[] = [
		{ value: ANY_PROVIDER, label: "Any provider" },
		...providers.map((p) => ({ value: p.id, label: p.label })),
	];
	const selectedProvider = providers.find((p) => p.id === value.provider);
	const suggestions = selectedProvider?.suggestedModels ?? [];
	const effortItems: SelItem[] = [
		{ value: DEFAULT_EFFORT, label: "Provider default" },
		...(catalog?.thinkingLevels ?? []).map((l) => ({ value: l, label: l })),
	];

	const providerValue = value.provider || ANY_PROVIDER;
	const effortValue = value.effort || DEFAULT_EFFORT;

	return (
		<div className="space-y-3">
			{showProvider && (
				<div className="flex flex-col gap-1.5">
					<Label className="text-muted-foreground text-xs">
						Provider (suggestions)
					</Label>
					<Select
						items={providerItems}
						onValueChange={(v) =>
							onChange({
								...value,
								provider: v && v !== ANY_PROVIDER ? v : "",
							})
						}
						value={providerValue}
					>
						<SelectTrigger className="h-8 text-sm">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{providerItems.map((it) => (
								<SelectItem className="text-sm" key={it.value} value={it.value}>
									{it.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			)}

			<div className="flex flex-col gap-1.5">
				<Label className="text-muted-foreground text-xs">Model</Label>
				<Input
					className="h-8 text-sm"
					onChange={(e) => onChange({ ...value, model: e.target.value })}
					placeholder="Use default model"
					value={value.model}
				/>
				{suggestions.length > 0 && (
					<div className="flex flex-wrap gap-1">
						{suggestions.map((m) => (
							<Button
								className="h-6 rounded-full px-2 text-xs"
								key={m}
								onClick={() => onChange({ ...value, model: m })}
								size="sm"
								type="button"
								variant={value.model === m ? "secondary" : "ghost"}
							>
								{m}
							</Button>
						))}
					</div>
				)}
			</div>

			<div className="flex flex-col gap-1.5">
				<Label className="text-muted-foreground text-xs">
					Thinking / effort level
				</Label>
				<Select
					items={effortItems}
					onValueChange={(v) =>
						onChange({ ...value, effort: v && v !== DEFAULT_EFFORT ? v : "" })
					}
					value={effortValue}
				>
					<SelectTrigger className="h-8 text-sm">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{effortItems.map((it) => (
							<SelectItem className="text-sm" key={it.value} value={it.value}>
								{it.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
		</div>
	);
}

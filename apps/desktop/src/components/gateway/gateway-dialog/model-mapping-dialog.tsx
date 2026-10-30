import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import type { ReactElement } from "react";
import { useState } from "react";
import type { ModelMapping, ProviderKind } from "@/src/lib/api/gateway.ts";
import { modalityProviderLabel } from "./modality-mapping-dialog.tsx";

// ── RoutingCard ───────────────────────────────────────────────────────────────

export const PROVIDER_LABELS = {
	openai: "OpenAI",
	anthropic: "Anthropic",
	local: "Local",
	openrouter: "OpenRouter",
	core: "Core",
	genai: "Gemini",
	mistral: "Mistral",
	huggingface: "Hugging Face",
	nvidia: "NVIDIA NIM",
	together: "Together AI",
	fireworks: "Fireworks AI",
} satisfies Record<ProviderKind, string>;

export const NON_CHAT_POOL_PROVIDERS = new Set([
	"classify",
	"voyage",
	"jina",
	"cohere",
	"deepgram",
	"elevenlabs",
	"inworld",
	"fal",
	"replicate",
]);

export interface ModelMappingFormState {
	model: string;
	provider: string;
	provider_model: string;
}

export function mappingFromForm(form: ModelMappingFormState): ModelMapping {
	const providerModel = form.provider.startsWith("pool:")
		? ""
		: form.provider_model.trim();
	const mapping: ModelMapping = { provider: form.provider };
	if (providerModel) {
		mapping.provider_model = providerModel;
	}
	return mapping;
}

const DEFAULT_MAPPING_FORM: ModelMappingFormState = {
	model: "",
	provider: "openai",
	provider_model: "",
};

export function ModelMappingDialog({
	trigger,
	title,
	description,
	initial,
	modelReadOnly,
	providers,
	onSave,
}: {
	trigger: ReactElement;
	title: string;
	description: string;
	initial?: ModelMappingFormState;
	modelReadOnly?: boolean;
	providers: string[];
	onSave: (form: ModelMappingFormState) => Promise<void>;
}) {
	const [open, setOpen] = useState(false);
	const [form, setForm] = useState<ModelMappingFormState>(
		initial ?? DEFAULT_MAPPING_FORM
	);
	const [saving, setSaving] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	const handleOpenChange = (next: boolean) => {
		if (next) {
			setForm(initial ?? DEFAULT_MAPPING_FORM);
			setErr(null);
		}
		setOpen(next);
	};

	const handleSave = async () => {
		if (!form.model.trim()) {
			setErr("Model name is required.");
			return;
		}
		setSaving(true);
		setErr(null);
		try {
			await onSave(form);
			setOpen(false);
		} catch (e) {
			setErr(e instanceof Error ? e.message : "Failed to save mapping.");
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog onOpenChange={handleOpenChange} open={open}>
			<DialogTrigger render={trigger} />
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-4 py-2">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="mapping-model">Model name (request)</Label>
						<Input
							disabled={modelReadOnly}
							id="mapping-model"
							onChange={(e) =>
								setForm((f) => ({ ...f, model: e.target.value }))
							}
							placeholder="e.g. gpt-4 or openrouter/auto"
							value={form.model}
						/>
						<p className="text-muted-foreground text-xs">
							Exact or prefix match against the model name in the request. Use{" "}
							<span className="font-mono">openrouter/auto</span> for general
							requests, or{" "}
							<span className="font-mono">openrouter/pareto-code</span> for
							coding-focused selection.
						</p>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="mapping-provider">Provider</Label>
						<Select
							items={providers.map((p) => ({
								value: p,
								label: modalityProviderLabel(p),
							}))}
							onValueChange={(v) =>
								v && setForm((f) => ({ ...f, provider: v }))
							}
							value={form.provider}
						>
							<SelectTrigger id="mapping-provider">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{providers.map((p) => (
									<SelectItem key={p} value={p}>
										{modalityProviderLabel(p)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					{form.provider.startsWith("pool:") ? (
						<p className="text-muted-foreground text-xs">
							Each pool member uses the exact upstream model saved in that pool.
						</p>
					) : (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="mapping-provider-model">
								Provider model name (optional)
							</Label>
							<Input
								id="mapping-provider-model"
								onChange={(e) =>
									setForm((f) => ({
										...f,
										provider_model: e.target.value,
									}))
								}
								placeholder="e.g. gpt-4o (leave blank to keep original)"
								value={form.provider_model}
							/>
							<p className="text-muted-foreground text-xs">
								Rewrite the model name when forwarding to the provider.
							</p>
						</div>
					)}
					{err ? (
						<p className="text-sm text-status-destructive">{err}</p>
					) : null}
				</div>
				<DialogFooter>
					<Button
						disabled={saving}
						onClick={() => setOpen(false)}
						variant="ghost"
					>
						Cancel
					</Button>
					<Button
						loading={saving}
						onClick={() => handleSave()}
						variant="outline"
					>
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

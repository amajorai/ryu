import { useLiteralMessages } from "@ryu/i18n/react";
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
import type { Modality } from "@/src/lib/api/gateway.ts";
import { PROVIDER_LABELS } from "./model-mapping-dialog.tsx";

// ── Modality routing ─────────────────────────────────────────────────────────

/**
 * Display names for every provider id that can appear in `routing.modality_map`,
 * which is a strictly WIDER set than {@link PROVIDER_LABELS}.
 *
 * `PROVIDER_LABELS` is `Record<ProviderKind, string>`, and `ProviderKind` covers
 * only the chat-capable passthroughs. The media providers registered in
 * `apps/gateway/src/providers/mod.rs` — `modal`, `replicate`, `fal` — plus the
 * `classify` tier alias are NOT in that union, so the model-map editor's
 * `configuredProviders.filter((p) => p in PROVIDER_LABELS)` drops them. Reusing
 * that filtered list here would have left the modality editor unable to select
 * the exact three providers the modality map exists to select. Unknown ids fall
 * through to the raw id rather than being hidden.
 *
 * DELIBERATE DIVERGENCE from the model-map rows directly above, so nobody
 * "tidies" the two back together: those rows filter, these do not. `provider` in
 * `ModalityMapping` is an open `ProviderId`, and this editor offers whatever
 * `available_providers()` reports. One visible consequence is `classify`, which
 * IS registered on every Core-spawned gateway (Core publishes
 * `RYU_CLASSIFY_LLM_URL` unconditionally) and so appears in this dropdown while
 * the model-map dropdown hides it. Offering it is honest — the gateway would
 * accept it — and hardcoding a media-only allowlist here is exactly the closed
 * list that broke `fal`/`replicate`/`modal` in the first place.
 */
const MODALITY_PROVIDER_LABELS = new Map<string, string>(
	Object.entries({
		...PROVIDER_LABELS,
		modal: "Modal",
		replicate: "Replicate",
		fal: "fal.ai",
		classify: "Classify tier",
		kiro: "Kiro",
		// Credit-pool providers: the Gateway registers these as ALIASES over the
		// OpenAI / Anthropic impls (`register_as` in `apps/gateway/src/providers/mod.rs`),
		// so they carry their own ids and belong here like any other selectable
		// provider. They are named for what an operator configured, not for the impl
		// underneath — an operator who set up a segregated Bedrock pool must not see
		// it presented as "Anthropic".
		cloudflare: "Cloudflare Workers AI",
		bedrock: "Amazon Bedrock",
		vertex: "Google Vertex AI",
		// The donated OpenAI allowance is its own id so its spend is never mixed
		// with the operator's own `openai` key; its label keeps the two apart too.
		"openai-credits": "OpenAI (donated credits)",
		voyage: "Voyage AI",
		jina: "Jina AI",
		cohere: "Cohere",
		deepgram: "Deepgram",
		assemblyai: "AssemblyAI",
		elevenlabs: "ElevenLabs",
		inworld: "Inworld",
		qwen: "Qwen",
	})
);

export function modalityProviderLabel(id: string): string {
	if (id.startsWith("pool:")) {
		return `Pool · ${id.slice(5)}`;
	}
	return MODALITY_PROVIDER_LABELS.get(id) ?? id;
}

/**
 * Row copy for each `Modality` variant. Keyed by the enum's wire form, so a
 * variant added on the Rust side surfaces here as a type error rather than as a
 * quietly missing row.
 */
export const MODALITY_COPY = {
	chat: {
		label: "Chat",
		note: "Rarely reached. Ordinary chat is routed by the model map above, not by this row. The router only consults the chat entry for an agent that carries a per-agent chat MODEL slot and no provider slot; with a provider slot set, that slot wins outright.",
	},
	image: {
		label: "Image generation",
		note: "Used by POST /v1/images/generations.",
	},
	tts: {
		label: "Audio",
		note: "Used by POST /v1/audio/speech.",
	},
	stt: {
		label: "Voice Recognition",
		note: "Used by POST /v1/audio/transcriptions.",
	},
	video: {
		label: "Video generation",
		note: "Used by POST /v1/videos/generations. It is job-based, so the client polls for the result.",
	},
	audio: {
		label: "Music and sound effects",
		note: "Used by POST /v1/audio/generations. It is job-based like video; speech from text stays on the Audio row.",
	},
} satisfies Record<Modality, { label: string; note: string }>;

interface ModalityMappingFormState {
	model: string;
	provider: string;
}

/**
 * Add/edit dialog for one modality row. Deliberately the same shape as
 * {@link ModelMappingDialog} — provider select, optional model override,
 * validate-on-save, inline error — so the two editors in this card read as one
 * mechanism. Only the two differences the wire format forces: the modality is
 * fixed (it is the map KEY, not a free-text field), and `providers` is
 * `string[]` because `ModalityMapping.provider` is an open `ProviderId`.
 */
export function ModalityMappingDialog({
	trigger,
	modality,
	initial,
	providers,
	onSave,
}: {
	trigger: ReactElement;
	modality: Modality;
	initial: ModalityMappingFormState;
	/** Selectable provider ids: those this node reports, plus the stored one. */
	providers: string[];
	onSave: (form: ModalityMappingFormState) => Promise<void>;
}) {
	const tl = useLiteralMessages();
	const [open, setOpen] = useState(false);
	const [form, setForm] = useState<ModalityMappingFormState>(initial);
	const [saving, setSaving] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	const handleOpenChange = (next: boolean) => {
		if (next) {
			setForm(initial);
			setErr(null);
		}
		setOpen(next);
	};

	const handleSave = async () => {
		if (!form.provider.trim()) {
			setErr("Pick a provider, or clear the row to fall back to the default.");
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

	const label = MODALITY_COPY[modality].label;

	return (
		<Dialog onOpenChange={handleOpenChange} open={open}>
			<DialogTrigger render={trigger} />
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{tl("{label} routing", { label })}</DialogTitle>
					<DialogDescription>
						{tl(
							"Send {label} requests to a specific provider. Checked before the model map; clear the row to fall back to the default provider.",
							{ label: label.toLowerCase() }
						)}
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-4 py-2">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="modality-provider">Provider</Label>
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
							<SelectTrigger id="modality-provider">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{providers.map((p) => (
									<SelectItem key={p} value={p}>
										{modalityProviderLabel(p)}
									</SelectItem>
								))}
								{providers.length === 0 ? (
									<SelectItem disabled value="__none__">
										No providers configured
									</SelectItem>
								) : null}
							</SelectContent>
						</Select>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="modality-model">Model (optional)</Label>
						<Input
							id="modality-model"
							onChange={(e) =>
								setForm((f) => ({ ...f, model: e.target.value }))
							}
							placeholder="e.g. dall-e-3 (blank keeps the request's model)"
							value={form.model}
						/>
						<p className="text-muted-foreground text-xs">
							Pins the model sent to the provider. Left blank, the model name
							from the request is forwarded unchanged.
						</p>
					</div>
					<p className="text-muted-foreground text-xs">
						{MODALITY_COPY[modality].note}
					</p>
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

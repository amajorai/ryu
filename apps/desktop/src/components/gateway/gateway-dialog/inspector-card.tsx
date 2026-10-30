import {
	LockedByBroader,
	LockToggle,
	PipelineBadge,
} from "@ryu/blocks/desktop/guardrails/controls.tsx";
import { GUARDRAIL_ACTION_OPTIONS as POLICY_OPTIONS } from "@ryu/blocks/desktop/guardrails/copy.ts";
import type { GuardrailScopeCtx } from "@ryu/blocks/desktop/guardrails/types.ts";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { AgentModelPickerField } from "@/components/agent-elements/input/agent-model-picker-field.tsx";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type {
	GatewayFirewallOverlay,
	GatewayFirewallView,
	InspectorConfig,
	InspectorMode,
} from "@/src/lib/api/gateway.ts";
import {
	CLASSIFY_MODEL_ID,
	CLASSIFY_TIER_COPY,
	classifyTierCannotServeModel,
	DEFAULT_INSPECTOR,
} from "@/src/lib/api/gateway.ts";
import { ClassifyTierNote, useClassifyTier } from "./classify-tier.tsx";

// ── Hierarchical firewall / DLP cascade (node → org → agent) ──────────────────
//
// The guardrails surface edits a THREE-LEVEL policy cascade. The node base
// (`config.firewall`) is the box admin's baseline; per-org and per-agent
// overlays (`firewall_org_overlays` / `firewall_agent_overlays`) tighten it.
// Every overlay scalar is tri-state: set (override) or unset (inherit the
// broader scope). A broader scope can freeze a field (`locked_fields`); a
// narrower scope then sees it read-only. The gateway resolver is the
// enforcement truth — the lock indicators here are advisory (they can only see
// node → org / node → agent locally, not the request-time org binding).

export type FwScope = "node" | "org" | "agent";

/**
 * Everything a scoped guardrail control needs: the shared editor context from
 * `@ryu/blocks`, bound to this dialog's gateway wire types so the desktop-only
 * cards below (inspector, evaluators) can read the inspector and evaluator
 * slots the shared shape leaves out.
 */
export type ScopeCtx = GuardrailScopeCtx<
	GatewayFirewallView,
	GatewayFirewallOverlay
>;

const INSPECTOR_MODE_ITEMS: { value: InspectorMode; label: string }[] = [
	{ value: "injection", label: "Injection — jailbreak / prompt-injection" },
	{ value: "dlp", label: "DLP — PII / secret leaks" },
	{ value: "both", label: "Both" },
];

/** Clamp a numeric text input to a non-negative integer. */
function clampInt(raw: string, min: number): number {
	const n = Number.parseInt(raw, 10);
	if (Number.isNaN(n) || n < min) {
		return min;
	}
	return n;
}

export function InspectorCard({
	ctx,
	target,
	pipelineStages,
}: {
	ctx: ScopeCtx;
	target: ApiTarget;
	pipelineStages?: string[];
}) {
	const tl = useLiteralMessages();
	const nodeInspector = ctx.node.inspector ?? DEFAULT_INSPECTOR;
	const broaderLocked = ctx.broaderLocked.has("inspector");
	const overlayInspector = ctx.overlay.inspector ?? null;
	const overriding = overlayInspector !== null;
	const effective = overriding ? overlayInspector : nodeInspector;

	const patchInspector = (patch: Partial<InspectorConfig>) => {
		if (ctx.isOverlay) {
			ctx.setOverlayField({ inspector: { ...effective, ...patch } });
		} else {
			ctx.setNodeField({ inspector: { ...nodeInspector, ...patch } });
		}
	};

	const setOverride = (on: boolean) => {
		ctx.setOverlayField({ inspector: on ? { ...nodeInspector } : null });
	};

	const editorDisabled =
		ctx.disabled || (ctx.isOverlay && !(ctx.overlayReady && overriding));

	const classifyTier = useClassifyTier(target, !broaderLocked);
	// What the gateway will ACTUALLY ask, mirrored so this card judges the model the
	// gateway uses rather than the empty string in the box: `de_inspector_model`
	// (apps/gateway/src/config.rs) resolves a blank to the classify-tier classifier
	// as it reads the wire.
	//
	// DISPLAY ONLY — and that is exactly how a real bug hid here. This line made the
	// card behave as if a blank box were already the classifier, while the save path
	// shipped the literal blank; Core reads the proxied body BEFORE the gateway
	// resolves anything (`maybe_start_classify_tier`), took the blank as "no classify
	// selection", and never started the sidecar — so with weights on disk the tier
	// stayed `idle`, `unservedModel` below stayed false, and nothing warned. The save
	// path now normalizes for real (`withResolvedInspectorModels` in lib/api/gateway),
	// so this mirror and the persisted value finally agree.
	const resolvedModel = effective.model.trim() || CLASSIFY_MODEL_ID;
	// The trap the empty box used to be, in its remaining form: the inspector is
	// pointed at the LOCAL classifier on a node that cannot serve it. The call then
	// errors, and the inspector fails open by design (a timeout or provider error is
	// treated as not-flagged), so the guardrail reports "on", shows a Block action,
	// and allows every single turn. Nothing else in this card can reveal that — it is
	// a property of the node, not of the config.
	//
	// The REACHABLE form of it is `unweighted`: the classifier GGUF's onboarding
	// download is non-fatal, and the sidecar it feeds is registered either way, so a
	// node whose download failed looks identical in the run state and bails on every
	// start attempt (logged at `debug`, so nothing surfaces it).
	const unservedModel =
		effective.enabled &&
		classifyTierCannotServeModel(classifyTier, resolvedModel);
	const unservedReason =
		classifyTier === "absent" || classifyTier === "unweighted"
			? CLASSIFY_TIER_COPY[classifyTier].reason
			: null;

	return (
		<SettingsSection
			caption={
				<CaptionInfo
					detail={
						"An optional cheap-LLM traffic inspector that runs alongside the regex scanner on inbound turns. It is a swappable detection method, orthogonal to the policy action. Fail-open: any timeout or error allows the turn."
					}
				>
					{"An optional low-cost model that inspects inbound turns."}
				</CaptionInfo>
			}
			headerAction={
				<div className="flex items-center gap-2">
					<PipelineBadge
						active={pipelineStages?.includes("inspector") ?? true}
					/>
					{ctx.isOverlay ? null : (
						<LockToggle
							disabled={ctx.disabled}
							fieldLabel="LLM inspector"
							locked={ctx.lockedHere.has("inspector")}
							onToggle={() => ctx.toggleLock("inspector")}
						/>
					)}
				</div>
			}
			title="LLM inspector"
		>
			{broaderLocked ? (
				<SettingsCard>
					<LockedByBroader
						summary={
							effective.enabled
								? tl("Inspector locked (on)")
								: tl("Inspector locked (off)")
						}
					/>
				</SettingsCard>
			) : (
				<SettingsGroup>
					{ctx.isOverlay ? (
						<SettingsItem
							actions={
								<Switch
									aria-label="Override inspector"
									checked={overriding}
									disabled={ctx.disabled || !ctx.overlayReady}
									id="inspector-override"
									onCheckedChange={setOverride}
								/>
							}
							description={
								overriding
									? "Override the inherited inspector for this scope"
									: nodeInspector.enabled
										? tl("Inherits the node inspector (on)")
										: tl("Inherits the node inspector (off)")
							}
							title="Override inspector"
						/>
					) : null}
					<SettingsItem
						actions={
							<Switch
								aria-label="Enable LLM inspector"
								checked={effective.enabled}
								disabled={editorDisabled}
								id="inspector-enabled"
								onCheckedChange={(c: boolean) => patchInspector({ enabled: c })}
							/>
						}
						description="Run the inspector on inbound turns"
						title="Enabled"
					/>
					{/* The description describes the WIRE, not the box: the substitution
					    happens in the save transport (`withResolvedInspectorModels`), so
					    the field itself still renders empty until the next refetch. The
					    old copy promised "the box is never really blank" and credited a
					    gateway-side substitution that lands too late to keep the local
					    classifier running. */}
					<SettingsItem
						actions={
							<AgentModelPickerField
								ariaLabel="Inspector model"
								disabled={editorDisabled}
								mode="model"
								onChange={(next) => patchInspector({ model: next })}
								placeholder="Local classifier (Gemma 3 270M)"
								target={target}
								value={effective.model}
							/>
						}
						description="Any routable model id. Leave empty for this node's local classifier (Gemma 3 270M). Saving writes that id explicitly, because a blank value would leave the local classifier stopped."
						title={<Label htmlFor="inspector-model">Model</Label>}
					>
						{unservedModel ? (
							<p className="text-status-destructive text-xs">
								{tl(
									"The inspector is on and pointed at the local classifier, but {unservedReason}. The inspection call will fail, and the inspector fails open, so it will allow every turn while still reporting as enabled. Pick a model this node can reach.",
									{ unservedReason }
								)}
							</p>
						) : null}
						{/* Judged on the RESOLVED model, so a blank box doesn't offer
						    "Use it" for the model the gateway already substitutes. */}
						<ClassifyTierNote
							disabled={editorDisabled}
							onUse={() => patchInspector({ model: CLASSIFY_MODEL_ID })}
							state={classifyTier}
							value={resolvedModel}
						/>
					</SettingsItem>
					<SettingsItem
						actions={
							<Select
								disabled={editorDisabled}
								items={INSPECTOR_MODE_ITEMS}
								onValueChange={(v) => patchInspector({ mode: v ?? "both" })}
								value={effective.mode}
							>
								<SelectTrigger className="w-64" id="inspector-mode">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{INSPECTOR_MODE_ITEMS.map((it) => (
										<SelectItem key={it.value} value={it.value}>
											{it.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						title={<Label htmlFor="inspector-mode">Mode</Label>}
					/>
					<SettingsItem
						actions={
							<Select
								disabled={editorDisabled}
								items={POLICY_OPTIONS}
								onValueChange={(v) =>
									patchInspector({
										action: v ?? "warn_and_continue",
									})
								}
								value={effective.action}
							>
								<SelectTrigger className="w-64" id="inspector-action">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{POLICY_OPTIONS.map((opt) => (
										<SelectItem key={opt.value} value={opt.value}>
											{opt.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						title={<Label htmlFor="inspector-action">Action on flag</Label>}
					/>
					<SettingsItem
						actions={
							<Input
								className="w-28"
								disabled={editorDisabled}
								id="inspector-min-chars"
								inputMode="numeric"
								onChange={(e) =>
									patchInspector({ min_chars: clampInt(e.target.value, 0) })
								}
								value={String(effective.min_chars)}
							/>
						}
						title={<Label htmlFor="inspector-min-chars">Min characters</Label>}
					/>
					<SettingsItem
						actions={
							<Input
								className="w-28"
								disabled={editorDisabled}
								id="inspector-timeout"
								inputMode="numeric"
								onChange={(e) =>
									patchInspector({ timeout_ms: clampInt(e.target.value, 0) })
								}
								value={String(effective.timeout_ms)}
							/>
						}
						title={<Label htmlFor="inspector-timeout">Timeout (ms)</Label>}
					/>
				</SettingsGroup>
			)}
		</SettingsSection>
	);
}

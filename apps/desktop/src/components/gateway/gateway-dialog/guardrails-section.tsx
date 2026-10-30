import {
	DlpCard,
	FirewallCard,
} from "@ryu/blocks/desktop/guardrails/firewall-cards.tsx";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { useEffect, useState } from "react";
import { AgentModelPickerField } from "@/components/agent-elements/input/agent-model-picker-field.tsx";
import { AgentEgressSection } from "@/src/components/gateway/AgentEgressSection.tsx";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import { TrustedFoldersCard } from "@/src/components/gateway/TrustedFoldersCard.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { ApiError, type ApiTarget } from "@/src/lib/api/client.ts";
import type {
	GatewayConfig,
	GatewayFirewallConfig,
	GatewayFirewallOverlay,
} from "@/src/lib/api/gateway.ts";
import {
	fetchGatewayConfig,
	sameGuardrailSections,
	updateGatewayConfig,
} from "@/src/lib/api/gateway.ts";
import { ALERT_TIER_TARGETS_NOTE } from "./budget-form.tsx";
import { CatalogScannerCard } from "./catalog-scanner-card.tsx";
import { CommandApprovalCard } from "./command-approval-card.tsx";
import { EvaluatorsCard } from "./evaluators-card.tsx";
import {
	type FwScope,
	InspectorCard,
	type ScopeCtx,
} from "./inspector-card.tsx";

const SCOPE_ITEMS: { value: FwScope; label: string }[] = [
	{ value: "node", label: "Node (baseline)" },
	{ value: "org", label: "Org overlay" },
	{ value: "agent", label: "Agent overlay" },
];

/** Scope-aware copy for the Guardrails card (replaces the old global caption). */
function scopeCaption(scope: FwScope, id: string, tl: LiteralMessage): string {
	if (scope === "org") {
		return id
			? tl(
					'Editing the overlay for org "{id}". Unset fields inherit the node baseline; set fields apply to every session in this org. A field the node locked is read-only here.',
					{ id }
				)
			: tl(
					"Editing the overlay for an org. Unset fields inherit the node baseline; set fields apply to every session in this org. A field the node locked is read-only here."
				);
	}
	if (scope === "agent") {
		return id
			? tl(
					'Editing the overlay for agent "{id}". Unset fields inherit the node baseline; set fields apply only to this agent. A field a broader scope locked is read-only here.',
					{ id }
				)
			: tl(
					"Editing the overlay for an agent. Unset fields inherit the node baseline; set fields apply only to this agent. A field a broader scope locked is read-only here."
				);
	}
	return "Node baseline: applies to every session on this node unless a narrower scope (org or agent) overrides it. Lock a field so narrower scopes cannot loosen it. Changes persist to gateway.toml.";
}

/**
 * The Guardrails surface: one source of truth (the full gateway config) feeding
 * the Firewall, DLP, and Inspector cards across the node → org → agent scope
 * cascade. Editing a scope writes that scope's overlay (or the node base); Save
 * PUTs the node firewall plus BOTH overlay stores in one full-replacement patch,
 * so the cards can never clobber each other's slice.
 */
export function GuardrailsSection({
	target,
	reachable,
	canConfigure,
}: {
	target: ApiTarget;
	reachable: boolean;
	/** When false the caller lacks `gateway.configure`; controls read-only. */
	canConfigure: boolean;
}) {
	const tl = useLiteralMessages();
	const [config, setConfig] = useState<GatewayConfig | null>(null);
	const [draft, setDraft] = useState<GatewayConfig | null>(null);
	const [configError, setConfigError] = useState<string | null>(null);
	const [scope, setScope] = useState<FwScope>("node");
	const [orgId, setOrgId] = useState("");
	const [agentId, setAgentId] = useState("");
	const [reloadKey, setReloadKey] = useState(0);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saveOk, setSaveOk] = useState(false);

	useEffect(() => {
		if (!reachable || config !== null) {
			return;
		}
		let cancelled = false;
		setConfigError(null);
		fetchGatewayConfig(target)
			.then((cfg) => {
				if (!cancelled) {
					setConfig(cfg);
					setDraft(cfg);
					setConfigError(null);
				}
			})
			.catch((e) => {
				if (!cancelled) {
					setConfigError(
						e instanceof ApiError && e.serverMessage
							? e.serverMessage
							: e instanceof Error
								? e.message
								: "Failed to load guardrails config"
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [reachable, config, reloadKey, target]);

	const clearSaveState = () => {
		setSaveOk(false);
		setSaveError(null);
	};

	const overlayStoreKey =
		scope === "org" ? "firewall_org_overlays" : "firewall_agent_overlays";
	const activeId = (scope === "org" ? orgId : agentId).trim();
	const overlayReady = scope === "node" ? true : activeId.length > 0;

	const setNodeField = (patch: Partial<GatewayFirewallConfig>) => {
		setDraft((prev) =>
			prev ? { ...prev, firewall: { ...prev.firewall, ...patch } } : prev
		);
		clearSaveState();
	};

	const setOverlayField = (patch: Partial<GatewayFirewallOverlay>) => {
		if (scope === "node" || !overlayReady) {
			return;
		}
		setDraft((prev) => {
			if (!prev) {
				return prev;
			}
			const store = { ...prev[overlayStoreKey] };
			store[activeId] = { ...store[activeId], ...patch };
			return { ...prev, [overlayStoreKey]: store };
		});
		clearSaveState();
	};

	const toggleLock = (field: string) => {
		setDraft((prev) => {
			if (!prev) {
				return prev;
			}
			const locked = new Set(prev.firewall.locked_fields ?? []);
			if (locked.has(field)) {
				locked.delete(field);
			} else {
				locked.add(field);
			}
			return {
				...prev,
				firewall: { ...prev.firewall, locked_fields: Array.from(locked) },
			};
		});
		clearSaveState();
	};

	/** Another surface changed the guardrails: reload the settings that won. */
	const showSaveConflict = () => {
		setConfig(null);
		setDraft(null);
		setSaveError(
			"Guardrails changed elsewhere. The latest settings were reloaded; reapply your changes."
		);
	};

	const handleSave = async () => {
		if (!(draft && config)) {
			return;
		}
		setSaving(true);
		setSaveError(null);
		setSaveOk(false);
		try {
			// The draft is loaded once and replaces all three sections, so re-read
			// first: saving over a change made elsewhere meanwhile (the posture card,
			// another window) would silently revert it. Changes to other sections
			// also move the revision but do not conflict with this save. The read's
			// revision then guards the gap between this read and the write.
			const current = await fetchGatewayConfig(target);
			if (!sameGuardrailSections(config, current)) {
				showSaveConflict();
				return;
			}
			// Sent as-drafted on purpose: `updateGatewayConfig` runs every patch through
			// `withResolvedInspectorModels`, so a blank `inspector.model` becomes the
			// classify id before it reaches Core — which reads this body to decide
			// whether to start `llamacpp-classify` and treats a blank as "no". Do not
			// re-implement that here; the transport is the one seam every firewall save
			// in the app (node base and both overlay stores) passes through.
			await updateGatewayConfig(target, {
				firewall: draft.firewall,
				firewall_org_overlays: draft.firewall_org_overlays,
				firewall_agent_overlays: draft.firewall_agent_overlays,
				expectedRevision: current.configRevision ?? undefined,
			});
			// Re-read the stored result as the baseline the next save compares.
			const saved = await fetchGatewayConfig(target).catch(() => null);
			setConfig(saved ?? draft);
			if (saved) {
				setDraft(saved);
			}
			setSaveOk(true);
			setTimeout(() => setSaveOk(false), 3000);
		} catch (e) {
			if (e instanceof ApiError && e.status === 409) {
				showSaveConflict();
				return;
			}
			setSaveError(
				e instanceof ApiError && e.serverMessage
					? e.serverMessage
					: e instanceof Error
						? e.message
						: "Failed to save guardrails config"
			);
		} finally {
			setSaving(false);
		}
	};

	const overlay: GatewayFirewallOverlay =
		scope === "node" ? {} : (draft?.[overlayStoreKey]?.[activeId] ?? {});
	const broaderLocked = new Set(
		scope === "node" ? [] : (draft?.firewall.locked_fields ?? [])
	);
	const lockedHere = new Set(
		scope === "node"
			? (draft?.firewall.locked_fields ?? [])
			: (overlay.locked_fields ?? [])
	);

	const ctx: ScopeCtx | null = draft
		? {
				scope,
				isOverlay: scope !== "node",
				overlayReady,
				overlayId: scope === "node" ? "" : activeId,
				node: draft.firewall,
				overlay,
				broaderLocked,
				lockedHere,
				disabled: !(reachable && canConfigure),
				setNodeField,
				setOverlayField,
				toggleLock,
			}
		: null;

	const dirty = draft !== config;

	return (
		<div className="flex flex-col gap-4">
			<SettingsSection
				caption={
					<CaptionInfo
						detail={
							"The node baseline applies everywhere; org and agent overlays tighten it per the node → org → agent cascade."
						}
					>
						{"Scope the firewall, DLP and inspector policy."}
					</CaptionInfo>
				}
				title="Policy scope"
			>
				<div className="flex flex-col gap-3">
					{reachable ? null : (
						<SettingsCard className="text-muted-foreground text-sm">
							Gateway unreachable, so controls are disabled. Start the gateway
							and refresh to configure guardrails.
						</SettingsCard>
					)}
					{reachable && configError ? (
						<div role="alert">
							<SettingsCard className="flex flex-wrap items-center justify-between gap-3">
								<p className="min-w-0 flex-1 break-words text-muted-foreground text-sm">
									{configError}
								</p>
								<Button
									onClick={() => setReloadKey((current) => current + 1)}
									size="sm"
									variant="secondary"
								>
									Retry
								</Button>
							</SettingsCard>
						</div>
					) : null}

					<SettingsGroup>
						<SettingsItem
							actions={
								<Select
									disabled={!reachable}
									items={SCOPE_ITEMS}
									onValueChange={(v) => setScope(v ?? "node")}
									value={scope}
								>
									<SelectTrigger className="w-48" id="fw-scope">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{SCOPE_ITEMS.map((it) => (
											<SelectItem key={it.value} value={it.value}>
												{it.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							}
							title={<Label htmlFor="fw-scope">Scope</Label>}
						/>
						{scope === "org" ? (
							<SettingsItem
								actions={
									<>
										<Input
											className="w-56"
											disabled={!reachable}
											id="fw-org-id"
											list="fw-org-ids"
											onChange={(e) => setOrgId(e.target.value)}
											placeholder="Org id (x-ryu-org-id)"
											value={orgId}
										/>
										<datalist id="fw-org-ids">
											{Object.keys(draft?.firewall_org_overlays ?? {}).map(
												(id) => (
													<option key={id} value={id} />
												)
											)}
										</datalist>
									</>
								}
								description={
									overlayReady
										? undefined
										: "Enter an org id to author its overlay."
								}
								title={<Label htmlFor="fw-org-id">Org id</Label>}
							/>
						) : null}
						{scope === "agent" ? (
							<SettingsItem
								actions={
									<AgentModelPickerField
										ariaLabel="Agent"
										disabled={!reachable}
										mode="agent"
										onChange={setAgentId}
										placeholder="Agent id (x-ryu-agent-id)"
										target={target}
										value={agentId}
									/>
								}
								description={
									overlayReady
										? undefined
										: "Choose or enter an agent id to author its overlay."
								}
								title={<Label htmlFor="fw-agent-id">Agent</Label>}
							/>
						) : null}
					</SettingsGroup>
				</div>
			</SettingsSection>

			{ctx ? (
				<>
					<FirewallCard
						alertNote={ALERT_TIER_TARGETS_NOTE}
						caption={scopeCaption(scope, activeId, tl)}
						ctx={ctx}
					/>
					<DlpCard ctx={ctx} />
					<InspectorCard
						ctx={ctx}
						pipelineStages={draft?.pipeline_stages}
						target={target}
					/>
					<EvaluatorsCard
						ctx={ctx}
						pipelineStages={draft?.pipeline_stages}
						target={target}
					/>
					<div className="flex flex-wrap items-center gap-3 px-3">
						<Button
							disabled={!(reachable && dirty && canConfigure)}
							loading={saving}
							onClick={() => handleSave()}
							size="sm"
							variant="outline"
						>
							Save guardrails
						</Button>
						{saveOk ? (
							<span
								aria-live="polite"
								className="text-sm text-status-success"
								role="status"
							>
								Saved.
							</span>
						) : null}
						{saveError ? (
							<span className="text-sm text-status-destructive" role="alert">
								{saveError}
							</span>
						) : null}
					</div>
				</>
			) : null}

			<CommandApprovalCard canConfigure={canConfigure} target={target} />
			<TrustedFoldersCard canConfigure={canConfigure} target={target} />
			<CatalogScannerCard canConfigure={canConfigure} target={target} />

			{/* Which agents these filters actually see. Every rule above only
			    applies to model calls that traverse the gateway, and three of the
			    four agent families route through it only when opted in — so a
			    guardrails page without this list overstates its own reach. */}
			<AgentEgressSection target={target} />
		</div>
	);
}

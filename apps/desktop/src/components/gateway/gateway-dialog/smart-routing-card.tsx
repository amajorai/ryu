import { Button } from "@ryu/ui/components/button.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useEffect, useState } from "react";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import { RoutePoolFields } from "@/src/components/gateway/RoutePoolFields.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useFriendlyMode } from "@/src/hooks/useFriendlyMode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type {
	GatewayRoutingConfig,
	ModelRouterType,
	SmartRoutingConfig,
} from "@/src/lib/api/gateway.ts";
import {
	CLASSIFY_MODEL_ID,
	CLASSIFY_TIER_COPY,
	classifyTierCannotServeModel,
	DEFAULT_SMART_ROUTING,
	fetchGatewayConfig,
	formatPoolList,
	routeStrategyCopy,
	routingViewIncludesSmartRouting,
	updateGatewayConfig,
} from "@/src/lib/api/gateway.ts";
import { type RuleRow, useClassifyTier } from "./classify-tier.tsx";
import { SmartRouterAlgorithmFields } from "./smart-router-algorithm-fields.tsx";
import { SmartRoutingRulesEditor } from "./smart-routing-rules-editor.tsx";
import {
	buildSmartRoutingConfig,
	smartRoutingRulesError,
} from "./smart-routing-save.ts";

export function SmartRoutingCard({
	target,
	reachable,
	canConfigure,
}: {
	target: ApiTarget;
	reachable: boolean;
	/** When false the caller lacks `gateway.configure`; controls read-only. */
	canConfigure: boolean;
}) {
	// The app-wide "Friendly names" toggle picks which of the two vocabularies this
	// picker speaks. Read per-surface rather than threaded through props: all three
	// places that render this control now share one copy table, so each just asks.
	const [friendly] = useFriendlyMode();
	const strategyCopy = routeStrategyCopy(friendly);
	const [config, setConfig] = useState<SmartRoutingConfig | null>(null);
	const [draft, setDraft] = useState<SmartRoutingConfig | null>(null);
	const [rules, setRules] = useState<RuleRow[]>([]);
	// The pool fields are edited as typed text and parsed on save, so a trailing
	// comma or space survives the keystroke that types it.
	const [poolModels, setPoolModels] = useState("");
	const [poolProviders, setPoolProviders] = useState("");
	const [loadAttempt, setLoadAttempt] = useState(0);
	// Did this gateway actually report `routing.smart_routing`? Three-state on
	// purpose, exactly like `modalityMapServed`: `null` = not loaded yet. Folding
	// "unknown" into `false` would flash a data-loss warning at every healthy,
	// current gateway for the duration of the first fetch.
	//
	// This exists because the card cannot otherwise tell "the node says smart
	// routing is off" from "the node never mentioned smart routing". Both render
	// as a switch in the off position, but only one of them is a fact. Saving in
	// the second case WRITES that fabricated off — `put_config` replaces the
	// routing section wholesale and `RoutingConfig::smart_routing` is
	// `#[serde(default)]`, so a hand-written `[routing.smart_routing]` in
	// `gateway.toml` is silently turned off by a user who came here to change a
	// rule. `fetchGatewayConfig` no longer coalesces the field precisely so this
	// distinction survives the client; consuming it here is the other half.
	const [served, setServed] = useState<boolean | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saveOk, setSaveOk] = useState(false);
	// Only polled while the node answers at all — a down node would otherwise
	// retry the sidecar status every 5s behind an already-explained error.
	const classifyTier = useClassifyTier(target, reachable);

	useEffect(() => {
		if (!reachable || config !== null) {
			return;
		}
		let cancelled = false;
		fetchGatewayConfig(target)
			.then((cfg) => {
				if (cancelled) {
					return;
				}
				setServed(routingViewIncludesSmartRouting(cfg.routing));
				// The `??` stays: React Selects and Switches bound to `undefined`
				// go uncontrolled. It is now only a *rendering* stand-in — `served`
				// carries the truth, and the save path refuses to write this
				// stand-in back.
				const sr = cfg.routing.smart_routing ?? DEFAULT_SMART_ROUTING;
				setConfig(sr);
				setDraft(sr);
				setPoolModels(formatPoolList(sr.allowed_models));
				setPoolProviders(formatPoolList(sr.allowed_providers));
				setRules(
					sr.rules.map((r) => ({
						id: crypto.randomUUID(),
						description: r.description,
						model: r.model,
						weight: String(r.weight ?? 1),
					}))
				);
				setLoadError(null);
			})
			.catch((e) => {
				if (!cancelled) {
					setLoadError(
						e instanceof Error ? e.message : "Failed to load smart routing"
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [reachable, config, target, loadAttempt]);

	const patch = (p: Partial<SmartRoutingConfig>) => {
		setDraft((prev) => (prev ? { ...prev, ...p } : prev));
		setSaveOk(false);
		setSaveError(null);
	};

	const updateRule = (
		id: string,
		field: "description" | "model" | "weight",
		value: string
	) => {
		setRules((prev) =>
			prev.map((r) => (r.id === id ? { ...r, [field]: value } : r))
		);
		setSaveOk(false);
		setSaveError(null);
	};

	const addRule = () => {
		setRules((prev) => [
			...prev,
			{ id: crypto.randomUUID(), description: "", model: "", weight: "1" },
		]);
		setSaveOk(false);
	};

	const removeRule = (id: string) => {
		setRules((prev) => prev.filter((r) => r.id !== id));
		setSaveOk(false);
		setSaveError(null);
	};

	const handleSave = async () => {
		// `served === false` is a hard refusal, not belt-and-braces behind a
		// disabled button: writing here replaces a section this app never received
		// with a fabricated default — destroying config in order to "save" it.
		// `null` (not loaded yet) is refused for the same reason.
		if (!draft || served !== true) {
			return;
		}
		// A newly added rule starts blank. Silently filtering that row in
		// `cleanRules` makes Save look successful while discarding the user's
		// unfinished target. Random routing also requires two positive-weight
		// targets to be active, so do not report a successful one-target save.
		const ruleError = smartRoutingRulesError(rules, routerType);
		if (ruleError) {
			setSaveError(ruleError);
			setSaveOk(false);
			return;
		}
		setSaving(true);
		setSaveError(null);
		setSaveOk(false);
		try {
			// Re-fetch so the PUT carries the full routing object (preserving
			// default_provider / model_map / fallback_chain) with only the
			// smart_routing section replaced.
			const cfg = await fetchGatewayConfig(target);
			// Re-checked against the FRESH config, not the one from mount. The
			// gateway can be restarted (or swapped for an older build) between the
			// two fetches, and it is this object that is about to be written back.
			if (!routingViewIncludesSmartRouting(cfg.routing)) {
				setServed(false);
				setSaveError(
					"This gateway no longer reports its smart-routing config, so saving would overwrite it. Nothing was changed."
				);
				return;
			}
			const smart_routing = buildSmartRoutingConfig({
				draft,
				fresh: cfg.routing.smart_routing,
				poolModels,
				poolProviders,
				routerType,
				rules,
			});
			const next: GatewayRoutingConfig = { ...cfg.routing, smart_routing };
			await updateGatewayConfig(target, {
				routing: next,
				expectedRevision: cfg.configRevision ?? undefined,
			});
			setConfig(smart_routing);
			setDraft(smart_routing);
			setPoolModels(formatPoolList(smart_routing.allowed_models));
			setPoolProviders(formatPoolList(smart_routing.allowed_providers));
			setRules(
				smart_routing.rules.map((rule) => ({
					id: crypto.randomUUID(),
					description: rule.description,
					model: rule.model,
					weight: String(rule.weight ?? 1),
				}))
			);
			setSaveOk(true);
			setTimeout(() => setSaveOk(false), 3000);
		} catch (e) {
			setSaveError(
				e instanceof Error ? e.message : "Failed to save smart routing"
			);
		} finally {
			setSaving(false);
		}
	};

	// `served === false` disables every control for the same reason the modality
	// rows render nothing: this app cannot round-trip a field the node never sent,
	// so an editable control here is an affordance that can only lose data.
	const isDisabled =
		!reachable || draft === null || !canConfigure || served === false;

	// Smart routing's one remaining enabled-but-broken state, plus the blank the
	// gateway now fills in for us.
	//
	//  - a blank classifier model is NO LONGER inert. `classifier_model` carries
	//    `deserialize_with = "de_classifier_model"`, which resolves a blank to the
	//    classify tier's id as the config comes off the wire — the same treatment
	//    `inspector.model` has always had. It used to be genuinely inert
	//    (`is_active` required a non-empty id), and this card's copy still said so
	//    for a while after the field changed; saying "it never runs" about a
	//    feature that now runs is the more expensive kind of wrong, because the
	//    user acts on it. It is an informational default now, not a warning.
	//  - a classifier model served only by the local classify tier on a node that
	//    cannot serve it — either no such tier at all, or (the reachable case) the
	//    tier's weights were never downloaded so its sidecar can never start. The
	//    classification call errors, and smart routing fails open by design. THIS
	//    is the one that stayed a warning, and resolving the blank made it strictly
	//    more important: a cleared box now lands on the local tier by default, so
	//    the unreachable case is easier to hit than it was.
	const classifierModel = draft?.classifier_model.trim() ?? "";
	const routerType: ModelRouterType = draft?.router_type ?? "llm_classifier";
	const smartLlm =
		draft?.enabled === true &&
		routerType === "llm_classifier" &&
		(draft.strategy ?? "llm") === "llm";
	// What the GATEWAY will actually use. `de_classifier_model` resolves a blank
	// `classifier_model` to the classify tier's id as it comes off the wire, so a
	// cleared box is not "off" — it is "the local classifier". Both the note and
	// the reachability probe below have to reason about the RESOLVED id, or a
	// cleared box silently skips the one warning that still matters.
	const classifierDefaulted = smartLlm && classifierModel === "";
	const resolvedClassifier = classifierModel || CLASSIFY_MODEL_ID;
	const classifierUnserved =
		smartLlm && classifyTierCannotServeModel(classifyTier, resolvedClassifier);
	const classifierUnservedReason =
		classifyTier === "absent" || classifyTier === "unweighted"
			? CLASSIFY_TIER_COPY[classifyTier].reason
			: null;

	return (
		<SettingsSection
			caption={
				<CaptionInfo
					detail={
						"The selected model then follows Ryu's normal provider routing, governance, budgets, and audit path."
					}
				>
					{"Choose how Gateway picks a model for each chat request."}
				</CaptionInfo>
			}
			headerAction={
				<Button
					disabled={isDisabled}
					loading={saving}
					onClick={() => handleSave()}
					size="sm"
					variant="ghost"
				>
					Save
				</Button>
			}
			title="Smart routing"
		>
			<div className="flex flex-col gap-3">
				{reachable && loadError ? (
					<div role="alert">
						<SettingsCard className="flex flex-wrap items-center justify-between gap-3">
							<p className="min-w-0 flex-1 break-words text-muted-foreground text-sm">
								{loadError}
							</p>
							<Button
								onClick={() => {
									setLoadError(null);
									setLoadAttempt((attempt) => attempt + 1);
								}}
								size="sm"
								variant="secondary"
							>
								Retry
							</Button>
						</SettingsCard>
					</div>
				) : null}
				{reachable ? null : (
					<SettingsCard className="text-muted-foreground text-sm">
						Gateway unreachable. Start the gateway and refresh to configure
						smart routing.
					</SettingsCard>
				)}
				{served === false ? (
					<SettingsCard className="text-sm text-status-warning">
						This gateway does not report its smart-routing config, so it cannot
						be edited here, and it cannot be preserved either: saving anything
						in this card replaces the whole routing section, so a{" "}
						<span className="font-mono">[routing.smart_routing]</span> written
						by hand in <span className="font-mono">gateway.toml</span> would be
						dropped. The switch below shows off because nothing was reported,
						not because routing is off. Update the gateway to configure smart
						routing from the app.
					</SettingsCard>
				) : null}

				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								aria-label="Enable smart routing"
								checked={draft?.enabled ?? false}
								disabled={isDisabled}
								onCheckedChange={(v) => patch({ enabled: v })}
							/>
						}
						description="Enable one model-selection algorithm for unpinned chat requests."
						title="Enable smart routing"
					/>
				</SettingsGroup>

				{/* The router form is one card: each algorithm's fields stack inside it
				    rather than in a bordered box of their own. */}
				<SettingsCard className="flex flex-col gap-4">
					<SmartRouterAlgorithmFields
						classifierDefaulted={classifierDefaulted}
						classifierUnserved={classifierUnserved}
						classifierUnservedReason={classifierUnservedReason}
						classifyTier={classifyTier}
						draft={draft}
						isDisabled={isDisabled}
						patch={patch}
						routerType={routerType}
						strategyCopy={strategyCopy}
						target={target}
					/>
					<SmartRoutingRulesEditor
						addRule={addRule}
						draft={draft}
						isDisabled={isDisabled}
						patch={patch}
						removeRule={removeRule}
						routerType={routerType}
						rules={rules}
						target={target}
						updateRule={updateRule}
					/>
				</SettingsCard>

				<SettingsCard className="flex flex-col gap-3">
					<div className="flex flex-col gap-0.5">
						<span className="text-sm">Routing pool</span>
						<p className="text-muted-foreground text-xs">
							Limit which targets smart routing may pick on this node. Rules and
							tiers outside the pool are skipped. Each agent can narrow this
							pool further in its own settings, but never widen it.
						</p>
					</div>
					<RoutePoolFields
						disabled={isDisabled}
						idPrefix="smart-routing"
						models={poolModels}
						onModelsChange={(next) => {
							setSaveError(null);
							setPoolModels(next);
						}}
						onProvidersChange={(next) => {
							setSaveError(null);
							setPoolProviders(next);
						}}
						providers={poolProviders}
					/>
				</SettingsCard>

				{saveError ? (
					<p className="px-3 text-sm text-status-destructive" role="alert">
						{saveError}
					</p>
				) : null}
				{saveOk ? (
					<p className="px-3 text-sm text-status-success">
						Saved. New requests use the updated router.
					</p>
				) : null}
			</div>
		</SettingsSection>
	);
}

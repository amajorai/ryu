"use client";

// One row per firewall field, rendered for the active scope: a base scope gets
// a concrete control plus a lock toggle, an overlay gets an Inherit selector,
// and a field a broader scope froze renders read-only.

import { Label } from "@ryu/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Switch } from "@ryu/ui/components/switch";
import type { ReactElement, ReactNode } from "react";
import { SettingsItem } from "../settings-items.tsx";
import { LockedByBroader, LockToggle, TriStateBool } from "./controls.tsx";
import {
	GUARDRAIL_ACTION_LABELS,
	GUARDRAIL_ACTION_OPTIONS,
	GUARDRAIL_ALERT_TIER_LABELS,
	GUARDRAIL_ALERT_TIER_OPTIONS,
} from "./copy.ts";
import type {
	GuardrailAlertTier,
	GuardrailFirewallAction,
	GuardrailFirewallBase,
	GuardrailFirewallBoolField,
	GuardrailFirewallOverlay,
	GuardrailScopeCtx,
} from "./types.ts";

/** The parenthesised inherit hint, or nothing when the base is not known. */
function inheritHint(
	ctx: GuardrailScopeCtx,
	label: string
): string | undefined {
	return ctx.inheritedUnknown ? undefined : label;
}

function inheritOption(
	ctx: GuardrailScopeCtx,
	label: string | undefined
): { label: string; value: string } {
	const hint = label === undefined ? undefined : inheritHint(ctx, label);
	return { value: "inherit", label: hint ? `Inherit (${hint})` : "Inherit" };
}

/**
 * The overlay patch for one boolean field. In add-only mode (a named policy)
 * `false` becomes `null` (inherit): a policy can turn a protection on, and the
 * API refuses one that tries to turn it off.
 */
export function overlayBoolPatch(
	field: GuardrailFirewallBoolField,
	value: boolean | null,
	addOnly = false
): Partial<GuardrailFirewallOverlay> {
	const patch: Partial<GuardrailFirewallOverlay> = {};
	patch[field] = addOnly && value === false ? null : value;
	return patch;
}

function baseBoolPatch(
	field: GuardrailFirewallBoolField,
	value: boolean
): Partial<GuardrailFirewallBase> {
	const patch: Partial<GuardrailFirewallBase> = {};
	patch[field] = value;
	return patch;
}

/** The action a select value names, or `null` for Inherit. */
function actionFrom(value: string | null): GuardrailFirewallAction | null {
	return (
		GUARDRAIL_ACTION_OPTIONS.find((option) => option.value === value)?.value ??
		null
	);
}

/** The tier a select value names, or `null` for Inherit. */
function alertTierFrom(value: string | null): GuardrailAlertTier | null {
	return (
		GUARDRAIL_ALERT_TIER_OPTIONS.find((option) => option.value === value)
			?.value ?? null
	);
}

function actionLabel(action: GuardrailFirewallAction | undefined | null) {
	return action ? GUARDRAIL_ACTION_LABELS[action] : undefined;
}

/** One boolean guardrail field, rendered per the active scope. */
export function GuardrailBoolRow({
	ctx,
	field,
	title,
	description,
}: {
	ctx: GuardrailScopeCtx;
	description?: string;
	field: GuardrailFirewallBoolField;
	title: string;
}) {
	const nodeValue = Boolean(ctx.node[field]);
	const overlayValue = ctx.overlay[field];
	const resolved =
		overlayValue === null || overlayValue === undefined
			? nodeValue
			: overlayValue;

	let actions: ReactElement;
	if (ctx.broaderLocked.has(field)) {
		actions = <LockedByBroader summary={resolved ? "On" : "Off"} />;
	} else if (ctx.isOverlay) {
		actions = (
			<TriStateBool
				addOnly={ctx.addOnly}
				ariaLabel={title}
				disabled={ctx.disabled || !ctx.overlayReady}
				id={`fw-${field}`}
				inheritedLabel={inheritHint(ctx, nodeValue ? "On" : "Off")}
				onChange={(next) =>
					ctx.setOverlayField(overlayBoolPatch(field, next, ctx.addOnly))
				}
				value={overlayValue}
			/>
		);
	} else {
		actions = (
			<div className="flex items-center gap-2">
				<LockToggle
					disabled={ctx.disabled}
					fieldLabel={title}
					locked={ctx.lockedHere.has(field)}
					onToggle={() => ctx.toggleLock(field)}
				/>
				<Switch
					aria-label={title}
					checked={nodeValue}
					disabled={ctx.disabled}
					id={`fw-${field}`}
					onCheckedChange={(checked: boolean) =>
						ctx.setNodeField(baseBoolPatch(field, checked))
					}
				/>
			</div>
		);
	}

	return (
		<SettingsItem actions={actions} description={description} title={title} />
	);
}

/** The firewall action field, rendered per the active scope. */
export function GuardrailPolicyRow({
	ctx,
	title = "Policy",
}: {
	ctx: GuardrailScopeCtx;
	title?: string;
}) {
	const nodeValue = ctx.node.policy;
	const overlayValue = ctx.overlay.policy;
	const resolved = overlayValue ?? nodeValue;

	if (ctx.broaderLocked.has("policy")) {
		return (
			<SettingsItem
				actions={<LockedByBroader summary={actionLabel(resolved) ?? ""} />}
				title={title}
			/>
		);
	}

	if (ctx.isOverlay) {
		const items = [
			inheritOption(ctx, actionLabel(nodeValue)),
			...GUARDRAIL_ACTION_OPTIONS,
		];
		return (
			<SettingsItem
				actions={
					<Select
						disabled={ctx.disabled || !ctx.overlayReady}
						items={items}
						onValueChange={(next: string | null) =>
							ctx.setOverlayField({
								policy: actionFrom(next),
							})
						}
						value={overlayValue ?? "inherit"}
					>
						<SelectTrigger className="w-64" id="fw-policy">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{items.map((option) => (
								<SelectItem key={option.value} value={option.value}>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				}
				title={<Label htmlFor="fw-policy">{title}</Label>}
			/>
		);
	}

	return (
		<SettingsItem
			actions={
				<div className="flex items-center gap-2">
					<LockToggle
						disabled={ctx.disabled}
						fieldLabel={title}
						locked={ctx.lockedHere.has("policy")}
						onToggle={() => ctx.toggleLock("policy")}
					/>
					<Select
						disabled={ctx.disabled}
						items={GUARDRAIL_ACTION_OPTIONS}
						onValueChange={(next: string | null) =>
							ctx.setNodeField({
								policy: actionFrom(next) ?? "warn_and_continue",
							})
						}
						value={nodeValue}
					>
						<SelectTrigger className="w-64" id="fw-policy">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{GUARDRAIL_ACTION_OPTIONS.map((option) => (
								<SelectItem key={option.value} value={option.value}>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			}
			title={<Label htmlFor="fw-policy">{title}</Label>}
		/>
	);
}

/**
 * Who is told when the firewall matches, beside `policy` (which decides what
 * happens to the request). The two are orthogonal in the gateway. A locked
 * tier lets a narrower scope only raise it.
 */
export function GuardrailAlertRow({
	ctx,
}: {
	ctx: GuardrailScopeCtx;
	/**
	 * Footer caption read by the enclosing `SettingsGroup`; unused here, which
	 * is how a wrapper row opts into it.
	 */
	description?: ReactNode;
}) {
	// `??` at every read: `alert` is optional on the wire for older gateways, and
	// a Select bound to `undefined` renders uncontrolled.
	const nodeValue: GuardrailAlertTier = ctx.node.alert ?? "silent";
	const overlayValue = ctx.overlay.alert;
	const resolved: GuardrailAlertTier = overlayValue ?? nodeValue;

	if (ctx.broaderLocked.has("alert")) {
		return (
			<SettingsItem
				actions={
					<LockedByBroader summary={GUARDRAIL_ALERT_TIER_LABELS[resolved]} />
				}
				title="Alerts"
			/>
		);
	}

	if (ctx.isOverlay) {
		const items = [
			inheritOption(ctx, GUARDRAIL_ALERT_TIER_LABELS[nodeValue]),
			...GUARDRAIL_ALERT_TIER_OPTIONS,
		];
		return (
			<SettingsItem
				actions={
					<Select
						disabled={ctx.disabled || !ctx.overlayReady}
						items={items}
						onValueChange={(next: string | null) =>
							ctx.setOverlayField({
								alert: alertTierFrom(next),
							})
						}
						value={overlayValue ?? "inherit"}
					>
						<SelectTrigger className="w-64" id="fw-alert">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{items.map((option) => (
								<SelectItem key={option.value} value={option.value}>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				}
				title={<Label htmlFor="fw-alert">Alerts</Label>}
			/>
		);
	}

	return (
		<SettingsItem
			actions={
				<div className="flex items-center gap-2">
					<LockToggle
						disabled={ctx.disabled}
						fieldLabel="Alerts"
						locked={ctx.lockedHere.has("alert")}
						onToggle={() => ctx.toggleLock("alert")}
					/>
					<Select
						disabled={ctx.disabled}
						items={GUARDRAIL_ALERT_TIER_OPTIONS}
						onValueChange={(next: string | null) =>
							ctx.setNodeField({ alert: alertTierFrom(next) ?? "silent" })
						}
						value={nodeValue}
					>
						<SelectTrigger className="w-64" id="fw-alert">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{GUARDRAIL_ALERT_TIER_OPTIONS.map((option) => (
								<SelectItem key={option.value} value={option.value}>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			}
			title={<Label htmlFor="fw-alert">Alerts</Label>}
		/>
	);
}

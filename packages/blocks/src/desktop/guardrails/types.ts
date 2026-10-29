// Structural types for the shared guardrail editors.
//
// The editors render a firewall config (the node baseline) and an overlay that
// tightens it (an org or agent overlay on the desktop, a named policy on the web
// console). These types are a decoupled subset of the desktop wire types in
// `apps/desktop/src/lib/api/gateway.ts` (`GatewayFirewallConfig`,
// `GatewayFirewallOverlay`) so this package never imports app code. The desktop
// passes its own types through the generic `GuardrailScopeCtx`, which is where
// any drift between the two shapes would fail to type-check.

/** The three firewall actions, in the gateway's snake_case wire form. */
export type GuardrailFirewallAction =
	| "block"
	| "warn_and_continue"
	| "sanitize";

/** Alert tiers, ascending in severity (the gateway's `AlertTier` order). */
export const GUARDRAIL_ALERT_TIERS = [
	"silent",
	"warn",
	"fanout",
	"email",
] as const;
export type GuardrailAlertTier = (typeof GUARDRAIL_ALERT_TIERS)[number];

/** Which built-in category a custom pattern is merged into. */
export type GuardrailPatternKind = "pii" | "secret" | "prompt_injection";

/** One user-defined firewall pattern (Rust `regex` syntax). */
export interface GuardrailPattern {
	kind: GuardrailPatternKind;
	name: string;
	regex: string;
}

/** Boolean-valued firewall fields. */
export type GuardrailFirewallBoolField =
	| "enabled"
	| "scan_inbound"
	| "scan_outbound"
	| "log_detections"
	| "redact_pii"
	| "redact_secrets";

/** The concrete baseline the overlay inherits from. Every field may be absent. */
export interface GuardrailFirewallBase {
	alert?: GuardrailAlertTier;
	custom_patterns?: GuardrailPattern[];
	enabled?: boolean;
	locked_fields?: string[];
	log_detections?: boolean;
	policy?: GuardrailFirewallAction;
	redact_pii?: boolean;
	redact_secrets?: boolean;
	scan_inbound?: boolean;
	scan_outbound?: boolean;
}

/** A partial config that tightens the base. `null` or absent inherits. */
export interface GuardrailFirewallOverlay {
	alert?: GuardrailAlertTier | null;
	custom_patterns?: GuardrailPattern[];
	enabled?: boolean | null;
	locked_fields?: string[];
	log_detections?: boolean | null;
	policy?: GuardrailFirewallAction | null;
	redact_pii?: boolean | null;
	redact_secrets?: boolean | null;
	scan_inbound?: boolean | null;
	scan_outbound?: boolean | null;
}

/**
 * Everything a scoped guardrail control needs to render and edit one field.
 *
 * - Base scope (`isOverlay: false`): concrete switches with lock toggles.
 * - Overlay scope: Inherit, On or Off per field; a field the base locked is
 *   read-only.
 * - Add-only overlay (`addOnly: true`, a named policy): Inherit or On only,
 *   because a policy can turn protections on but never off.
 */
export interface GuardrailScopeCtx<
	Base extends GuardrailFirewallBase = GuardrailFirewallBase,
	Overlay extends GuardrailFirewallOverlay = GuardrailFirewallOverlay,
> {
	/** Overlay booleans offer Inherit and On only, never Off. */
	addOnly?: boolean;
	/** Fields frozen by a broader scope: read-only here. */
	broaderLocked: ReadonlySet<string>;
	/** Not editable (unreachable, not loaded, or no permission). */
	disabled: boolean;
	/**
	 * The inherited value is not known at authoring time (a named policy can
	 * be assigned anywhere), so Inherit options omit the base value.
	 */
	inheritedUnknown?: boolean;
	isOverlay: boolean;
	/** Fields this scope currently freezes. */
	lockedHere: ReadonlySet<string>;
	/** The base config (the inherit source for overlays). */
	node: Base;
	/** The overlay being edited (`{}` at base scope). */
	overlay: Overlay;
	/** Active overlay id ("" at base scope). Used for remount keys. */
	overlayId: string;
	/** Overlay scope has a concrete id selected. */
	overlayReady: boolean;
	/** Free-form scope name, for example "node", "org", "agent" or "policy". */
	scope: string;
	setNodeField(patch: Partial<Base>): void;
	setOverlayField(patch: Partial<Overlay>): void;
	toggleLock(field: string): void;
}

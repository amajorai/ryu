import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rpcJsonResponseSchema } from "@ryu/app-host/rpc";
import { z } from "zod";
import { fetchGatewayConfig, type GatewayRoutingConfig } from "./gateway.ts";

const REPO_ROOT = join(import.meta.dir, "../../../../..");

export function rustSource(relative: string): string {
	const path = join(REPO_ROOT, relative);
	try {
		return readFileSync(path, "utf8");
	} catch (e) {
		throw new Error(
			`mirror test cannot read ${relative} (resolved ${path}): ${e instanceof Error ? e.message : e}`
		);
	}
}

/**
 * The gateway dialog's source: `GatewayDialog.tsx` plus the section modules it
 * was split into under `gateway-dialog/`, read as one text (the dialog file
 * first, so a search for a JSX usage finds the renderer before a definition).
 */
export function gatewayDialogSource(): string {
	const dialog = "apps/desktop/src/components/gateway/GatewayDialog.tsx";
	const dir = "apps/desktop/src/components/gateway/gateway-dialog";
	const parent = "apps/desktop/src/components/gateway";
	// `GatewayDialog-*.ts(x)` files the dialog itself was split into, if any.
	const siblings = readdirSync(join(REPO_ROOT, parent))
		.filter(
			(f) =>
				f.startsWith("GatewayDialog-") &&
				/\.tsx?$/.test(f) &&
				!f.includes(".test.")
		)
		.sort()
		.map((f) => rustSource(`${parent}/${f}`));
	const parts = readdirSync(join(REPO_ROOT, dir))
		.filter((f) => /\.tsx?$/.test(f))
		.sort()
		.map((f) => rustSource(`${dir}/${f}`));
	return [rustSource(dialog), ...siblings, ...parts].join("\n");
}

export const GATEWAY_CONFIG_RS = "apps/gateway/src/config.rs";
const ROUTER_RS = "crates/gateway/router/src/lib.rs";
export const CLASSIFY_SIDECAR_RS =
	"apps/core/src/sidecar/providers/llamacpp/classify.rs";
// `AlertTier` lives in the neutral contracts crate, not in the gateway binary —
// it crosses stage boundaries (budget ↔ firewall ↔ pipeline), and Core mirrors it
// again in `policy_alerts`. The wire values a UI can offer are defined HERE.
export const CONTRACTS_RS = "crates/gateway/contracts/src/lib.rs";
export const BUDGET_RS = "crates/gateway/budget/src/lib.rs";
// Core's own re-declaration of `AlertTier`. Core does not depend on the gateway
// contracts crate, so the two enums are coupled only by their serde wire strings —
// and they are spelled with DIFFERENT rename rules (`lowercase` here vs
// `snake_case` there). The test below pins them equal.
export const CORE_POLICY_ALERTS_RS = "apps/core/src/policy_alerts/mod.rs";

export const gatewayConfigRs = rustSource(GATEWAY_CONFIG_RS);
export const routerRs = rustSource(ROUTER_RS);
export const classifySidecarRs = rustSource(CLASSIFY_SIDECAR_RS);
export const contractsRs = rustSource(CONTRACTS_RS);
export const budgetRs = rustSource(BUDGET_RS);
export const corePolicyAlertsRs = rustSource(CORE_POLICY_ALERTS_RS);

/** Anchor a regex in a named file, or fail loudly naming both. */
export function match(
	source: string,
	file: string,
	re: RegExp,
	what: string
): string {
	const found = re.exec(source);
	if (!found?.[1]) {
		throw new Error(
			`mirror test could not find ${what} in ${file} (pattern ${re.source}) — the Rust side moved; update this test, not just the constant`
		);
	}
	return found[1];
}

/** `pub const NAME: &str = "value";` */
export function rustStrConst(
	source: string,
	file: string,
	name: string
): string {
	return match(
		source,
		file,
		new RegExp(`const ${name}: &str = "([^"]*)"`),
		`const ${name}`
	);
}

/** A zero-arg fn whose whole body is one integer literal. */
function rustIntFn(source: string, file: string, name: string): number {
	const raw = match(
		source,
		file,
		new RegExp(`fn ${name}\\(\\) -> \\w+ \\{\\s*(\\d+)\\s*\\}`),
		`fn ${name}`
	);
	return Number(raw);
}

/**
 * From the first line that starts with `header` up to the next `\n}` at column 0
 * — i.e. one item's body, which is all these mirrors need to read.
 */
export function rustBlock(
	source: string,
	file: string,
	header: string
): string {
	const start = source.indexOf(header);
	if (start < 0) {
		throw new Error(`mirror test could not find \`${header}\` in ${file}`);
	}
	const end = source.indexOf("\n}", start);
	if (end < 0) {
		throw new Error(`mirror test found \`${header}\` in ${file} but no end`);
	}
	return source.slice(start, end);
}

const CAMEL_BOUNDARY = /(?<=[a-z0-9])(?=[A-Z])/g;

/**
 * The wire value of an enum's `#[default]` variant. Also asserts the enum carries
 * `#[serde(rename_all = "snake_case")]`, because that attribute is the only
 * reason the TS union is `"warn_and_continue"` and not `"WarnAndContinue"` —
 * dropping it would change every wire value while leaving the variant names
 * untouched.
 */
export function rustEnumDefaultWireValue(
	source: string,
	file: string,
	name: string
): string {
	const header = `pub enum ${name}`;
	const declStart = source.indexOf(header);
	if (declStart < 0) {
		throw new Error(`mirror test could not find \`${header}\` in ${file}`);
	}
	// Derive/serde attributes sit immediately above the declaration.
	const attrs = source.slice(Math.max(0, declStart - 400), declStart);
	if (!attrs.includes('#[serde(rename_all = "snake_case")]')) {
		throw new Error(
			`${name} in ${file} lost #[serde(rename_all = "snake_case")] — its wire values are no longer snake_case, so the TS union is wrong`
		);
	}
	const variant = match(
		rustBlock(source, file, header),
		file,
		/#\[default\]\s*(\w+)/,
		`#[default] variant of ${name}`
	);
	return variant.replace(CAMEL_BOUNDARY, "_").toLowerCase();
}

/** A bare `Variant,` line inside an enum body. */
const RUST_VARIANT_LINE = /^([A-Z]\w*),$/;

/**
 * An enum's variants as WIRE values, in declaration order, asserting the serde
 * casing attribute is the one the caller expects.
 *
 * Declaration order is the point for `AlertTier`: the Rust enum derives `Ord` from
 * it and the pipeline takes the `max` tier across every matched rule, so a TS list
 * in a different order would describe a different severity ladder. `rename_all` is
 * asserted for the same reason {@link rustEnumDefaultWireValue} asserts it — the
 * attribute is the ONLY reason the values are lowercase rather than the variant
 * names, and dropping it changes every wire value while leaving Rust compiling.
 */
export function rustEnumWireVariants(
	source: string,
	file: string,
	name: string,
	renameAll: "lowercase" | "snake_case"
): string[] {
	const header = `pub enum ${name}`;
	const declStart = source.indexOf(header);
	if (declStart < 0) {
		throw new Error(`mirror test could not find \`${header}\` in ${file}`);
	}
	const attrs = source.slice(Math.max(0, declStart - 400), declStart);
	if (!attrs.includes(`#[serde(rename_all = "${renameAll}")]`)) {
		throw new Error(
			`${name} in ${file} does not carry #[serde(rename_all = "${renameAll}")] — its wire values are not what the TS union claims`
		);
	}
	const variants: string[] = [];
	for (const line of rustBlock(source, file, header).split("\n")) {
		const found = RUST_VARIANT_LINE.exec(line.trim());
		if (found?.[1]) {
			const variant = found[1];
			variants.push(
				renameAll === "lowercase"
					? variant.toLowerCase()
					: variant.replace(CAMEL_BOUNDARY, "_").toLowerCase()
			);
		}
	}
	if (variants.length === 0) {
		throw new Error(
			`mirror test parsed no variants out of \`${header}\` in ${file}`
		);
	}
	return variants;
}

/**
 * The declared type of `pub <field>: <type>` inside a struct body, or throw.
 * Used to prove a field the TS interface claims actually exists on the Rust
 * struct — a TS-only field is silently dropped by serde, which is the failure
 * this whole file exists to catch.
 */
export function rustStructFieldType(
	source: string,
	file: string,
	struct: string,
	field: string
): string {
	const block = rustBlock(source, file, `pub struct ${struct}`);
	return match(
		block,
		file,
		new RegExp(`pub ${field}: ([^,\\n]+)`),
		`field \`${field}\` on \`${struct}\``
	);
}

/**
 * `impl Default for InspectorConfig`'s field initialisers, as `field → the Rust
 * expression it is set to`. Comment lines are skipped; nothing else is.
 */
export function parseInspectorDefaultImpl() {
	const block = rustBlock(
		gatewayConfigRs,
		GATEWAY_CONFIG_RS,
		"impl Default for InspectorConfig"
	);
	const fields: Record<string, string> = {};
	for (const line of block.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("//")) {
			continue;
		}
		const found = /^(\w+):\s*(.+),$/.exec(trimmed);
		if (found?.[1] && found[2]) {
			fields[found[1]] = found[2];
		}
	}
	if (Object.keys(fields).length === 0) {
		throw new Error(
			`mirror test parsed no fields out of impl Default for InspectorConfig in ${GATEWAY_CONFIG_RS}`
		);
	}
	return fields;
}

/**
 * Resolve one field initialiser to the value it produces. Throws on anything it
 * has not been taught — a new default expression must be understood here before
 * this file can claim to mirror it, which is the whole point.
 */
function resolveRustDefault(expr: string): boolean | number | string {
	if (expr === "true" || expr === "false") {
		return expr === "true";
	}
	if (expr === "default_inspector_model()") {
		// `fn default_inspector_model()` → `classify_model_id()`, which prefers the
		// id Core publishes at runtime and falls back to this const. The desktop
		// cannot read the gateway's environment, so the compile-time fallback is
		// what a TS mirror can honestly claim.
		return rustStrConst(
			gatewayConfigRs,
			GATEWAY_CONFIG_RS,
			"DEFAULT_INSPECTOR_MODEL"
		);
	}
	if (expr === "default_inspector_min_chars()") {
		return rustIntFn(
			gatewayConfigRs,
			GATEWAY_CONFIG_RS,
			"default_inspector_min_chars"
		);
	}
	if (expr === "default_inspector_timeout_ms()") {
		return rustIntFn(
			gatewayConfigRs,
			GATEWAY_CONFIG_RS,
			"default_inspector_timeout_ms"
		);
	}
	const enumDefault = /^(\w+)::default\(\)$/.exec(expr);
	if (enumDefault?.[1]) {
		return rustEnumDefaultWireValue(
			gatewayConfigRs,
			GATEWAY_CONFIG_RS,
			enumDefault[1]
		);
	}
	throw new Error(
		`mirror test does not know how to resolve the Rust default \`${expr}\` — teach resolveRustDefault about it before trusting DEFAULT_INSPECTOR`
	);
}

/** `impl Default for InspectorConfig`, resolved to plain JSON values. */
export function rustInspectorDefault() {
	const out: Record<string, boolean | number | string> = {};
	for (const [field, expr] of Object.entries(parseInspectorDefaultImpl())) {
		out[field] = resolveRustDefault(expr);
	}
	return out;
}

/** The `("<prefix>", "<provider>")` rows of `builtin_prefixes()`, in order. */
export function routerBuiltinPrefixes(): [string, string][] {
	const block = rustBlock(routerRs, ROUTER_RS, "pub fn builtin_prefixes(");
	const rows = [...block.matchAll(/\("([^"]+)",\s*"([^"]+)"\)/g)].map((m) =>
		z.tuple([z.string(), z.string()]).parse([m[1], m[2]])
	);
	if (rows.length === 0) {
		throw new Error(
			`mirror test parsed no prefix rows out of builtin_prefixes() in ${ROUTER_RS}`
		);
	}
	return rows;
}

// ─── Modality routing (routing.modality_map) ─────────────────────────────────
//
// Four kinds of guard, in dependency order:
//
//  1. That the gateway's `RoutingView` really serves `modality_map` /
//     `eval_routing`. The desktop editor is built ON TOP of that, and a field
//     the view stops returning turns the editor into a data-loss machine rather
//     than into a visible error — so the precondition is pinned, not assumed.
//  2. MIRROR tests for the wire vocabulary: the `Modality` variants that are the
//     map's KEYS, and the `ModalityMapping` fields that are its values. A key or
//     field name that Rust does not know is dropped by serde on arrival — the
//     save returns 200 and the setting evaporates.
//  3. Round-trip tests over `withModalityMapping`, the pure half of the save
//     path. `PUT /v1/config { routing }` replaces the section WHOLESALE
//     (`updated_config.routing = routing.clone()`) and every `RoutingConfig`
//     field is `#[serde(default)]`, so any sibling the desktop fails to carry
//     through is a sibling it erases. That is the A7 defect; these pin the fix.
//  4. Textual wiring guards on the dialog, in the same spirit as the
//     buildBudgetRule guards above — the `.tsx` cannot be imported here.

export const GATEWAY_API_CONFIG_RS = "apps/gateway/src/api/config.rs";
export const GATEWAY_PROVIDERS_RS = "apps/gateway/src/providers/mod.rs";
export const gatewayApiConfigRs = rustSource(GATEWAY_API_CONFIG_RS);
export const gatewayProvidersRs = rustSource(GATEWAY_PROVIDERS_RS);
export const gatewayDialogTsx = gatewayDialogSource();
const providerPoolsEditorTsx = rustSource(
	"apps/desktop/src/components/gateway/ProviderPoolsEditor.tsx"
);

/**
 * The dialog's provider label tables, each sliced to its own declaration:
 * `PROVIDER_LABELS` ends at `} satisfies …` and `MODALITY_PROVIDER_LABELS` (a
 * `new Map(Object.entries({…}))`) at `);`, the first column-0 `}` or `)` after
 * the name.
 */
export function dialogProviderLabelTables(): string {
	const labelled = (name: string): string => {
		const start = gatewayDialogTsx.indexOf(`const ${name} `);
		if (start < 0) {
			throw new Error(`wiring test could not find \`${name}\` in the dialog`);
		}
		const end = gatewayDialogTsx.slice(start).search(/\n[})]/);
		if (end < 0) {
			throw new Error(`wiring test found \`${name}\` but not its end`);
		}
		return gatewayDialogTsx.slice(start, start + end);
	};
	return labelled("MODALITY_PROVIDER_LABELS") + labelled("PROVIDER_LABELS");
}

/** The Provider pools editor's own `[id, label]` table, as written. */
export function poolsEditorLabelEntries(): [string, string][] {
	const start = providerPoolsEditorTsx.indexOf("const PROVIDER_LABELS ");
	if (start < 0) {
		throw new Error("wiring test could not find PROVIDER_LABELS in the editor");
	}
	const end = providerPoolsEditorTsx.slice(start).search(/\n\]\);/);
	if (end < 0) {
		throw new Error("wiring test found PROVIDER_LABELS but not its end");
	}
	return [
		...providerPoolsEditorTsx
			.slice(start, start + end)
			.matchAll(/^\t\["([\w-]+)", "([^"]+)"\],$/gm),
	].map((m) => [m[1] ?? "", m[2] ?? ""]);
}

// ─── routing.smart_routing: served vs not served ─────────────────────────────
//
// `fetchGatewayConfig` used to fold `?? DEFAULT_SMART_ROUTING` into the routing
// section it returned. That is the coalesce the modality-map work forbade for
// itself, and it is worse for `smart_routing` than for `modality_map`: an
// unserved map coalesces to `{}` (nothing asserted), while an unserved
// `smart_routing` coalesced to a concrete `enabled: false` — a fabricated
// "classifier routing is off" that the desktop then spread back out on the next
// save of any OTHER routing field, because `PUT /v1/config { routing }` replaces
// the section wholesale and `RoutingConfig::smart_routing` is `#[serde(default)]`.
//
// The pass-through cannot PREVENT that erasure (omission and an explicit default
// deserialize identically on the gateway) — it makes it detectable, which is the
// same conclusion `routingViewIncludesModalityMap` reached and documents.

/**
 * Run `fetchGatewayConfig` against a canned `GET /api/gateway/config` body.
 *
 * A whole-`fetch` stub rather than a `request` mock: `request` is what applies
 * the JSON parse and the ok/!ok split this function rides on, and stubbing it
 * out would test a transport that does not exist.
 */
export async function fetchWithBody(
	body: Parameters<typeof Response.json>[0]
): Promise<Awaited<ReturnType<typeof fetchGatewayConfig>>> {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = Object.assign(
		async () =>
			Response.json({
				auth: { api_keys: [], require_auth: false },
				providers: {
					anthropic: null,
					core: null,
					genai: null,
					local: null,
					openai: null,
					openrouter: null,
				},
				...z.record(z.string(), rpcJsonResponseSchema).parse(body),
			}),
		{
			preconnect: originalFetch.preconnect,
		}
	);
	try {
		return await fetchGatewayConfig({
			url: "http://127.0.0.1:7980",
			token: null,
			userJwt: null,
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
}

/** The routing section a current gateway serves, minus the field under test. */
export const SERVED_ROUTING_BASE: GatewayRoutingConfig = {
	default_provider: "openai",
	model_map: {},
	fallback_chain: [],
	provider_tiers: {},
	modality_map: {},
	eval_routing: { enabled: false, candidates: [], explore_ratio: 0 },
};

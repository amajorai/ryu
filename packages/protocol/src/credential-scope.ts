/**
 * Scoped-credential contract: which level supplies a provider key or a
 * connection for one request.
 *
 * This is the TypeScript twin of the Rust contract
 * `ryu_gw_contracts::credential_scope`. Both sides assert the same golden
 * fixture, `credential-scope-v1.json`, which is the source of truth: any rule
 * change lands as a fixture case first, then in both implementations.
 *
 * It decides which credential reference wins; it never sees, stores or
 * returns a secret value. Two axes are kept separate and never merged:
 *
 * 1. Which value is used: the most specific eligible level wins, in
 *    {@link CREDENTIAL_LADDER} order `user > node > project > team > org`.
 *    `managed` is not a level; it is the caller's fallback after `not_found`,
 *    for inference only.
 * 2. Which levels may supply a value: a {@link SourcePolicy} allowlist that
 *    can only narrow {@link defaultSources}, never widen it. The only way to
 *    admit `user` on a shared node is the org-only `orgAdmitsUser` opt-in.
 *
 * Policy gating happens before both axes and is passed in as a precomputed
 * {@link GateDecision}. Every function here is pure: no clock, no IO, no
 * randomness. Errors carry fixed reasons, never the rejected input.
 */

import { z } from "zod";

/** Version of this contract and of `credential-scope-v1.json`. */
export const CREDENTIAL_SCOPE_CONTRACT_VERSION = 1 as const;

/** Maximum length of one id component (provider id, toolkit, server id). */
export const CREDENTIAL_MAX_ID_LEN = 128;

/** Denial code for a policy with an unknown `allowedCredentialSources` entry. */
export const DENIED_INVALID_SOURCE_POLICY = "invalid_source_policy";

/** Denial code for a hand-built {@link CredentialSlot} outside the grammar. */
export const DENIED_INVALID_SLOT = "invalid_slot";

/** One level of the credential ladder. Wire names are lowercase. */
export type CredentialLevel = "user" | "node" | "project" | "team" | "org";

/** Resolution order, most specific first. */
export const CREDENTIAL_LADDER: readonly CredentialLevel[] = [
	"user",
	"node",
	"project",
	"team",
	"org",
];

/**
 * PR #643's `POLICY_LEVELS`, in that array's order. `node` is deliberately
 * absent: it is a credential-ladder level only.
 */
export const POLICY_LEVEL_NAMES: readonly string[] = [
	"org",
	"team",
	"project",
	"user",
];

const LEVEL_SPELLINGS: ReadonlyMap<string, CredentialLevel> = new Map([
	["user", "user"],
	["personal", "user"],
	["node", "node"],
	["project", "project"],
	["team", "team"],
	["org", "org"],
	["organization", "org"],
]);

/**
 * Parse a canonical level name or one of the two aliases, `organization`
 * (`org`) and `personal` (`user`). Every other spelling, including other
 * casings and surrounding whitespace, returns `null`.
 */
export function parseCredentialLevel(value: string): CredentialLevel | null {
	return LEVEL_SPELLINGS.get(value) ?? null;
}

const LEVEL_RANKS: Readonly<Record<CredentialLevel, number>> = {
	user: 4,
	node: 3,
	project: 2,
	team: 1,
	org: 0,
};

/**
 * Specificity rank: a higher rank is more specific and wins.
 * {@link CREDENTIAL_LADDER} is sorted by descending rank.
 */
export function credentialLevelRank(level: CredentialLevel): number {
	return LEVEL_RANKS[level];
}

/** What a credential is for. Wire names are snake_case. */
export type CredentialPurpose =
	| "inference"
	| "connection_platform"
	| "connection_account"
	| "tool_vendor";

/**
 * The thing a credential unlocks. Its canonical string form is
 * {@link credentialSlotId}; the grammar is closed:
 *
 * - `provider:<id>`: `inference`, provider `<id>`, key `null`;
 * - `platform:composio`, `platform:treg`: `connection_platform`, key `null`;
 * - `connection:composio:<toolkit>`, `connection:mcp:<serverId>`:
 *   `connection_account`, key `<toolkit>` or `<serverId>`;
 * - `tool:<vendor>`: `tool_vendor`, a third-party tool vendor's API key, key
 *   `null`. The vendor id is a price-contract provider id
 *   (`[a-z0-9][a-z0-9-]*`, at most 64 characters).
 *
 * An id component is 1-128 visible ASCII characters (`!`..`~`) and never
 * contains `*`. Inference ids may contain `:` but no empty segment; toolkit
 * and server ids may not contain `:`.
 */
export interface CredentialSlot {
	key: string | null;
	provider: string;
	purpose: CredentialPurpose;
}

/** Fixed-reason parse error. It never carries the rejected input. */
export interface CredentialParseError {
	reason: string;
}

/** The first invalid source entry. It names the entry's index, never its text. */
export interface SourcePolicyError {
	index: number;
	reason: string;
}

export type CredentialScopeResult<T, E> =
	| { ok: true; value: T }
	| { ok: false; error: E };

function succeed<T, E>(value: T): CredentialScopeResult<T, E> {
	return { ok: true, value };
}

function fail<T, E>(error: E): CredentialScopeResult<T, E> {
	return { ok: false, error };
}

const VISIBLE_ASCII_FIRST = 0x21;
const VISIBLE_ASCII_LAST = 0x7e;
const ASTERISK = 0x2a;

function isVisibleAscii(code: number): boolean {
	return code >= VISIBLE_ASCII_FIRST && code <= VISIBLE_ASCII_LAST;
}

function isIdCode(code: number): boolean {
	return isVisibleAscii(code) && code !== ASTERISK;
}

function everyCode(value: string, predicate: (code: number) => boolean) {
	for (let index = 0; index < value.length; index += 1) {
		if (!predicate(value.charCodeAt(index))) {
			return false;
		}
	}
	return true;
}

function validComponent(value: string, allowColon: boolean): boolean {
	if (
		value.length === 0 ||
		value.length > CREDENTIAL_MAX_ID_LEN ||
		!everyCode(value, isIdCode)
	) {
		return false;
	}
	if (allowColon) {
		return value.split(":").every((segment) => segment.length > 0);
	}
	return !value.includes(":");
}

function slotError(
	reason: string
): CredentialScopeResult<CredentialSlot, CredentialParseError> {
	return fail({ reason });
}

function stripPrefix(value: string, prefix: string): string | null {
	return value.startsWith(prefix) ? value.slice(prefix.length) : null;
}

const TOOL_VENDOR_ID = /^[a-z0-9][a-z0-9-]*$/u;

/**
 * A tool vendor id: the price contract's provider id grammar
 * (`isValidProviderId` in `./tool-price.ts`), kept here so this module does
 * not load the price catalog.
 */
function isToolVendorId(value: string): boolean {
	return value.length <= 64 && TOOL_VENDOR_ID.test(value);
}

/** Parse a canonical slot id. Anything outside the grammar is rejected. */
export function parseCredentialSlot(
	value: string
): CredentialScopeResult<CredentialSlot, CredentialParseError> {
	const provider = stripPrefix(value, "provider:");
	if (provider !== null) {
		if (!validComponent(provider, true)) {
			return slotError("provider id must be 1-128 visible ASCII");
		}
		return succeed({ purpose: "inference", provider, key: null });
	}
	const platform = stripPrefix(value, "platform:");
	if (platform !== null) {
		if (platform !== "composio" && platform !== "treg") {
			return slotError("platform must be composio or treg");
		}
		return succeed({
			purpose: "connection_platform",
			provider: platform,
			key: null,
		});
	}
	const rest = stripPrefix(value, "connection:");
	if (rest !== null) {
		const separator = rest.indexOf(":");
		if (separator === -1) {
			return slotError("connection slot needs a provider and an id");
		}
		const connectionProvider = rest.slice(0, separator);
		const key = rest.slice(separator + 1);
		if (connectionProvider !== "composio" && connectionProvider !== "mcp") {
			return slotError("connection provider must be composio or mcp");
		}
		if (!validComponent(key, false)) {
			return slotError("connection id must be 1-128 visible ASCII");
		}
		return succeed({
			purpose: "connection_account",
			provider: connectionProvider,
			key,
		});
	}
	const vendor = stripPrefix(value, "tool:");
	if (vendor !== null) {
		if (!isToolVendorId(vendor)) {
			return slotError("tool vendor must be a provider id");
		}
		return succeed({ purpose: "tool_vendor", provider: vendor, key: null });
	}
	return slotError("unknown slot family");
}

/**
 * Canonical slot id. For a slot built by {@link parseCredentialSlot} this
 * round-trips exactly; {@link isValidCredentialSlot} detects a hand-built slot
 * that does not.
 */
export function credentialSlotId(slot: CredentialSlot): string {
	switch (slot.purpose) {
		case "inference":
			return `provider:${slot.provider}`;
		case "connection_platform":
			return `platform:${slot.provider}`;
		case "connection_account":
			return slot.key === null
				? `connection:${slot.provider}`
				: `connection:${slot.provider}:${slot.key}`;
		case "tool_vendor":
			return `tool:${slot.provider}`;
		default:
			return "";
	}
}

/**
 * True when the slot is exactly what {@link parseCredentialSlot} would build
 * from its own {@link credentialSlotId}.
 */
export function isValidCredentialSlot(slot: CredentialSlot): boolean {
	const parsed = parseCredentialSlot(credentialSlotId(slot));
	return (
		parsed.ok &&
		parsed.value.purpose === slot.purpose &&
		parsed.value.provider === slot.provider &&
		parsed.value.key === slot.key
	);
}

/**
 * How a scope id was established. `node_asserted` never unlocks a value.
 * Wire names are snake_case.
 */
export type ScopeEvidence =
	| "credential_bound"
	| "admin_mapped"
	| "verified_membership"
	| "verified_identity"
	| "node_asserted";

export const SCOPE_EVIDENCE_KINDS: readonly ScopeEvidence[] = [
	"credential_bound",
	"admin_mapped",
	"verified_membership",
	"verified_identity",
	"node_asserted",
];

/** An owner id at one level plus the evidence for it. */
export interface ScopeRef {
	evidence: ScopeEvidence;
	id: string;
}

/** Where the node runs. On a `fleet` node, node keys count as `managed`. */
export type NodeKind = "tenant" | "fleet";

/** The caller's scope, one optional owner per level. */
export interface CredentialScope {
	node: ScopeRef | null;
	nodeKind: NodeKind;
	org: ScopeRef | null;
	/** The authenticated credential is personal; it never reaches shared levels. */
	personal: boolean;
	project: ScopeRef | null;
	team: ScopeRef | null;
	user: ScopeRef | null;
}

/** A redacted pointer to a stored credential. It never carries the value. */
export interface CredentialRef {
	/** A non-secret account fingerprint, used for circuit and cache keys. */
	fingerprint: string;
	id: string;
	version: number;
}

/** Lifecycle status, computed by the caller. */
export type CandidateStatus = "active" | "disabled" | "expired" | "revoked";

/** One stored credential that might serve the slot. It has no value field. */
export interface CredentialCandidate {
	credentialRef: CredentialRef;
	level: CredentialLevel;
	ownerId: string;
	/** Higher wins. */
	priority: number;
	slotId: string;
	status: CandidateStatus;
}

/** The precomputed policy gate. */
export type GateDecision =
	| { type: "allowed" }
	| { type: "denied"; code: string };

/**
 * Which levels may supply a value: the effective `allowedCredentialSources`
 * list plus the org-only member opt-in. The list only narrows
 * {@link defaultSources}; see {@link effectiveRules}.
 */
export interface SourcePolicy {
	allowed: readonly string[];
	/** Read from the org layer only; deny by default. */
	orgAdmitsUser: boolean;
}

/** Which slots a parsed source entry admits. */
export type SlotMatch =
	| { kind: "any" }
	| { kind: "exact"; slotId: string }
	| { kind: "prefix"; prefix: string };

/** One parsed `allowedCredentialSources` entry. */
export interface SourceRule {
	level: CredentialLevel;
	slots: SlotMatch;
}

/** Per-level explanation status. Wire names are snake_case. */
export type TraceStatus =
	| "not_in_scope"
	| "evidence_insufficient"
	| "source_not_allowed"
	| "empty"
	| "selected"
	| "shadowed";

/** One trace line: a level and what happened there. */
export interface TraceEntry {
	level: CredentialLevel;
	status: TraceStatus;
}

/** The result of one resolution. */
export type CredentialOutcome =
	| { type: "selected"; level: CredentialLevel; credentialRef: CredentialRef }
	| { type: "not_found" }
	| { type: "denied"; code: string };

/**
 * Outcome plus a redacted explanation. The trace has one entry per ladder
 * level, in ladder order, unless the outcome is a denial raised before the
 * walk, in which case it is empty.
 */
export interface CredentialResolution {
	outcome: CredentialOutcome;
	trace: TraceEntry[];
}

function validOwnerId(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= CREDENTIAL_MAX_ID_LEN &&
		everyCode(value, isVisibleAscii)
	);
}

/**
 * The owner at `level`, if any. A {@link ScopeRef} whose id is outside the id
 * grammar (1-128 visible ASCII) is treated as absent.
 */
export function credentialScopeOwner(
	scope: CredentialScope,
	level: CredentialLevel
): ScopeRef | null {
	const owner = scope[level];
	return owner !== null && validOwnerId(owner.id) ? owner : null;
}

function scopeHas(
	scope: CredentialScope,
	level: CredentialLevel,
	evidence: ScopeEvidence
): boolean {
	return credentialScopeOwner(scope, level)?.evidence === evidence;
}

const PREFIX_FAMILIES: readonly string[] = [
	"provider:",
	"platform:",
	"connection:",
	"tool:",
];

function parseSourceEntry(
	entry: string
): CredentialScopeResult<SourceRule, CredentialParseError> {
	const separator = entry.indexOf(":");
	const levelText = separator === -1 ? entry : entry.slice(0, separator);
	const level = parseCredentialLevel(levelText);
	if (level === null) {
		return fail({ reason: "unknown level" });
	}
	if (separator === -1) {
		return succeed({ level, slots: { kind: "any" } });
	}
	const slotText = entry.slice(separator + 1);
	if (slotText.endsWith("*")) {
		const prefix = slotText.slice(0, -1);
		const wellFormed =
			prefix.length > 0 &&
			prefix.length <= CREDENTIAL_MAX_ID_LEN * 2 &&
			everyCode(prefix, isIdCode) &&
			PREFIX_FAMILIES.some((family) => prefix.startsWith(family));
		if (!wellFormed) {
			return fail({
				reason:
					"prefix must start with provider:, platform:, connection: or tool:",
			});
		}
		return succeed({ level, slots: { kind: "prefix", prefix } });
	}
	const slot = parseCredentialSlot(slotText);
	if (!slot.ok) {
		return fail(slot.error);
	}
	return succeed({
		level,
		slots: { kind: "exact", slotId: credentialSlotId(slot.value) },
	});
}

/**
 * Parse every entry. One unknown entry fails the whole policy (fail closed:
 * a typo never silently widens or narrows to something else).
 */
export function parseSources(
	policy: SourcePolicy
): CredentialScopeResult<SourceRule[], SourcePolicyError> {
	const rules: SourceRule[] = [];
	for (const [index, entry] of policy.allowed.entries()) {
		const parsed = parseSourceEntry(entry);
		if (!parsed.ok) {
			return fail({ index, reason: parsed.error.reason });
		}
		rules.push(parsed.value);
	}
	return succeed(rules);
}

/**
 * The most a source policy can admit, in ladder order:
 * `[node, project, team, org]`, plus `user` (first) only on a personal
 * credential or when the org-only `orgAdmitsUser` opt-in is set.
 */
export function defaultSources(
	scope: CredentialScope,
	orgAdmitsUser: boolean
): CredentialLevel[] {
	return CREDENTIAL_LADDER.filter(
		(level) => level !== "user" || scope.personal || orgAdmitsUser
	);
}

/**
 * The rules {@link resolveCredential} applies for `scope`: the parsed list
 * narrowed to {@link defaultSources}, or the default itself when the list is
 * empty. A non-empty list never re-reads as the default, even when narrowing
 * leaves nothing.
 */
export function effectiveRules(
	policy: SourcePolicy,
	scope: CredentialScope
): CredentialScopeResult<SourceRule[], SourcePolicyError> {
	const parsed = parseSources(policy);
	if (!parsed.ok) {
		return parsed;
	}
	const defaults = defaultSources(scope, policy.orgAdmitsUser);
	if (parsed.value.length === 0) {
		return succeed(
			defaults.map((level): SourceRule => ({ level, slots: { kind: "any" } }))
		);
	}
	return succeed(parsed.value.filter((rule) => defaults.includes(rule.level)));
}

function ruleAdmits(
	rule: SourceRule,
	level: CredentialLevel,
	slotId: string
): boolean {
	if (rule.level !== level) {
		return false;
	}
	switch (rule.slots.kind) {
		case "any":
			return true;
		case "exact":
			return rule.slots.slotId === slotId;
		case "prefix":
			return slotId.startsWith(rule.slots.prefix);
		default:
			return false;
	}
}

/**
 * Whether the scope's evidence unlocks a value at `level`. It is false when
 * the level has no valid owner.
 *
 * - `user`: `verified_identity`, or `credential_bound` on a personal credential.
 * - `node`: an owner on a `tenant` node (node evidence is not consulted).
 * - `project`: not personal, a `verified_identity` user, an `admin_mapped` project.
 * - `team`: not personal, a `verified_identity` user, a `verified_membership` team.
 * - `org`: not personal, a `credential_bound` org, a `verified_identity` user.
 */
export function evidenceUnlocks(
	level: CredentialLevel,
	scope: CredentialScope
): boolean {
	const verifiedUser = scopeHas(scope, "user", "verified_identity");
	const shared = !scope.personal && verifiedUser;
	switch (level) {
		case "user":
			return (
				verifiedUser ||
				(scope.personal && scopeHas(scope, "user", "credential_bound"))
			);
		case "node":
			return (
				credentialScopeOwner(scope, "node") !== null &&
				scope.nodeKind === "tenant"
			);
		case "project":
			return shared && scopeHas(scope, "project", "admin_mapped");
		case "team":
			return shared && scopeHas(scope, "team", "verified_membership");
		case "org":
			return shared && scopeHas(scope, "org", "credential_bound");
		default:
			return false;
	}
}

/**
 * Compare two strings in Unicode code point order, which is the UTF-8 byte
 * order Rust's `String` ordering uses. UTF-16 code unit order differs for
 * characters above the Basic Multilingual Plane.
 */
function compareCodePoints(left: string, right: string): number {
	let leftIndex = 0;
	let rightIndex = 0;
	while (leftIndex < left.length && rightIndex < right.length) {
		const leftPoint = left.codePointAt(leftIndex) ?? 0;
		const rightPoint = right.codePointAt(rightIndex) ?? 0;
		if (leftPoint !== rightPoint) {
			return leftPoint < rightPoint ? -1 : 1;
		}
		leftIndex += leftPoint > 0xff_ff ? 2 : 1;
		rightIndex += rightPoint > 0xff_ff ? 2 : 1;
	}
	return Math.sign(left.length - leftIndex - (right.length - rightIndex));
}

/**
 * Negative when `left` is the better candidate: highest priority, then the
 * smallest ref id, then the highest version, then the smallest fingerprint.
 */
function compareCandidates(
	left: CredentialCandidate,
	right: CredentialCandidate
): number {
	if (left.priority !== right.priority) {
		return right.priority - left.priority;
	}
	const byId = compareCodePoints(left.credentialRef.id, right.credentialRef.id);
	if (byId !== 0) {
		return byId;
	}
	if (left.credentialRef.version !== right.credentialRef.version) {
		return right.credentialRef.version - left.credentialRef.version;
	}
	return compareCodePoints(
		left.credentialRef.fingerprint,
		right.credentialRef.fingerprint
	);
}

function bestCandidate(
	candidates: readonly CredentialCandidate[],
	level: CredentialLevel,
	ownerId: string,
	slotId: string
): CredentialCandidate | null {
	let best: CredentialCandidate | null = null;
	for (const candidate of candidates) {
		const matches =
			candidate.level === level &&
			candidate.status === "active" &&
			candidate.ownerId === ownerId &&
			candidate.slotId === slotId;
		if (matches && (best === null || compareCandidates(candidate, best) < 0)) {
			best = candidate;
		}
	}
	return best;
}

function deniedResolution(code: string): CredentialResolution {
	return { outcome: { type: "denied", code }, trace: [] };
}

function copyRef(credentialRef: CredentialRef): CredentialRef {
	return {
		id: credentialRef.id,
		version: credentialRef.version,
		fingerprint: credentialRef.fingerprint,
	};
}

type LevelCheck =
	| {
			status: Exclude<TraceStatus, "selected" | "shadowed">;
			best: null;
	  }
	| { status: "hit"; best: CredentialCandidate };

interface LevelInputs {
	candidates: readonly CredentialCandidate[];
	rules: readonly SourceRule[];
	scope: CredentialScope;
	slotId: string;
}

/** The checks at one level, in order: owner, evidence, source, candidates. */
function checkLevel(level: CredentialLevel, inputs: LevelInputs): LevelCheck {
	const owner = credentialScopeOwner(inputs.scope, level);
	if (owner === null) {
		return { status: "not_in_scope", best: null };
	}
	if (!evidenceUnlocks(level, inputs.scope)) {
		return { status: "evidence_insufficient", best: null };
	}
	if (!inputs.rules.some((rule) => ruleAdmits(rule, level, inputs.slotId))) {
		return { status: "source_not_allowed", best: null };
	}
	const best = bestCandidate(inputs.candidates, level, owner.id, inputs.slotId);
	if (best === null) {
		return { status: "empty", best: null };
	}
	return { status: "hit", best };
}

/**
 * Pick the credential for `slot`.
 *
 * 1. A gate denial is returned unchanged with an empty trace.
 * 2. A slot outside the grammar is denied with `invalid_slot`.
 * 3. A policy with any unknown entry is denied with `invalid_source_policy`.
 * 4. The policy is narrowed to {@link defaultSources}.
 * 5. Walk the ladder, one trace entry per level: owner present
 *    (`not_in_scope`), evidence (`evidence_insufficient`), source policy
 *    (`source_not_allowed`), then active candidates whose level, owner and
 *    slot match exactly (`empty`). The first level with a hit is `selected`;
 *    any later level with a hit is `shadowed`.
 * 6. `not_found` when no level yields a value.
 */
export function resolveCredential(
	slot: CredentialSlot,
	scope: CredentialScope,
	candidates: readonly CredentialCandidate[],
	gate: GateDecision,
	policy: SourcePolicy
): CredentialResolution {
	if (gate.type !== "allowed") {
		return deniedResolution(gate.code);
	}
	if (!isValidCredentialSlot(slot)) {
		return deniedResolution(DENIED_INVALID_SLOT);
	}
	const rules = effectiveRules(policy, scope);
	if (!rules.ok) {
		return deniedResolution(DENIED_INVALID_SOURCE_POLICY);
	}
	const inputs: LevelInputs = {
		scope,
		candidates,
		rules: rules.value,
		slotId: credentialSlotId(slot),
	};
	let selected: CredentialOutcome | null = null;
	const trace: TraceEntry[] = [];
	for (const level of CREDENTIAL_LADDER) {
		const check = checkLevel(level, inputs);
		if (check.status !== "hit") {
			trace.push({ level, status: check.status });
		} else if (selected === null) {
			selected = {
				type: "selected",
				level,
				credentialRef: copyRef(check.best.credentialRef),
			};
			trace.push({ level, status: "selected" });
		} else {
			trace.push({ level, status: "shadowed" });
		}
	}
	return { outcome: selected ?? { type: "not_found" }, trace };
}

/** A wire payload that does not match the contract. Fixed text, never input. */
export interface CredentialDecodeError {
	message: string;
	path: string;
}

const levelSchema = z.string().transform((value, context) => {
	const level = parseCredentialLevel(value);
	if (level === null) {
		context.addIssue({ code: "custom", message: "unknown credential level" });
		return z.NEVER;
	}
	return level;
});

const slotSchema = z.string().transform((value, context) => {
	const slot = parseCredentialSlot(value);
	if (!slot.ok) {
		context.addIssue({ code: "custom", message: "invalid credential slot" });
		return z.NEVER;
	}
	return slot.value;
});

const evidenceSchema = z.enum([
	"credential_bound",
	"admin_mapped",
	"verified_membership",
	"verified_identity",
	"node_asserted",
]);

const scopeRefSchema = z
	.strictObject({ id: z.string(), evidence: evidenceSchema })
	.nullable()
	.default(null);

const scopeSchema = z.strictObject({
	org: scopeRefSchema,
	node: scopeRefSchema,
	user: scopeRefSchema,
	team: scopeRefSchema,
	project: scopeRefSchema,
	nodeKind: z.enum(["tenant", "fleet"]),
	personal: z.boolean(),
});

const U16_MAX = 65_535;

const refSchema = z.strictObject({
	id: z.string(),
	version: z.int().nonnegative(),
	fingerprint: z.string(),
});

const candidateSchema = z.strictObject({
	level: levelSchema,
	ownerId: z.string(),
	slotId: z.string(),
	credentialRef: refSchema,
	priority: z.int().min(0).max(U16_MAX),
	status: z.enum(["active", "disabled", "expired", "revoked"]),
});

const gateSchema = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("allowed") }),
	z.strictObject({ type: z.literal("denied"), code: z.string() }),
]);

const policySchema = z.strictObject({
	allowed: z.array(z.string()).default([]),
	orgAdmitsUser: z.boolean().default(false),
});

const outcomeSchema = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("selected"),
		level: levelSchema,
		credentialRef: refSchema,
	}),
	z.strictObject({ type: z.literal("not_found") }),
	z.strictObject({ type: z.literal("denied"), code: z.string() }),
]);

const resolutionSchema = z.strictObject({
	outcome: outcomeSchema,
	trace: z.array(
		z.strictObject({
			level: levelSchema,
			status: z.enum([
				"not_in_scope",
				"evidence_insufficient",
				"source_not_allowed",
				"empty",
				"selected",
				"shadowed",
			]),
		})
	),
});

function decodeWith<T>(
	schema: z.ZodType<T>,
	input: unknown,
	message: string
): CredentialScopeResult<T, CredentialDecodeError> {
	const parsed = schema.safeParse(input);
	if (parsed.success) {
		return succeed(parsed.data);
	}
	const path = (parsed.error.issues[0]?.path ?? [])
		.map((segment) => String(segment))
		.join(".");
	return fail({ path, message });
}

/** Decode a slot id string (the slot's wire form). */
export function decodeCredentialSlot(
	input: unknown
): CredentialScopeResult<CredentialSlot, CredentialDecodeError> {
	return decodeWith(slotSchema, input, "invalid credential slot");
}

/**
 * Decode a scope. Unknown fields are rejected; an absent owner reads as
 * `null`, like Rust's `Option`.
 */
export function decodeCredentialScope(
	input: unknown
): CredentialScopeResult<CredentialScope, CredentialDecodeError> {
	return decodeWith(scopeSchema, input, "invalid credential scope");
}

/**
 * Decode a candidate. Unknown fields are rejected, so a payload that tries to
 * smuggle a `value` or `secret` never decodes. Level aliases are accepted
 * and canonicalized.
 */
export function decodeCredentialCandidate(
	input: unknown
): CredentialScopeResult<CredentialCandidate, CredentialDecodeError> {
	return decodeWith(candidateSchema, input, "invalid credential candidate");
}

/** Decode a tagged gate decision. */
export function decodeGateDecision(
	input: unknown
): CredentialScopeResult<GateDecision, CredentialDecodeError> {
	return decodeWith(gateSchema, input, "invalid gate decision");
}

/**
 * Decode a source policy. `allowed` defaults to `[]` and `orgAdmitsUser` to
 * `false`. Entries are kept verbatim; {@link parseSources} validates them.
 */
export function decodeSourcePolicy(
	input: unknown
): CredentialScopeResult<SourcePolicy, CredentialDecodeError> {
	return decodeWith(policySchema, input, "invalid source policy");
}

/** Decode a resolution, for example one returned by an explain endpoint. */
export function decodeCredentialResolution(
	input: unknown
): CredentialScopeResult<CredentialResolution, CredentialDecodeError> {
	return decodeWith(resolutionSchema, input, "invalid credential resolution");
}

import { describe, expect, test } from "bun:test";
import { z } from "zod";
// The Rust contract's golden fixture is the single source of truth for both
// implementations, so it is read in place rather than copied into this package.
import golden from "../../../crates/gateway/contracts/fixtures/credential-scope-v1.json" with {
	type: "json",
};
import {
	CREDENTIAL_LADDER,
	CREDENTIAL_MAX_ID_LEN,
	CREDENTIAL_SCOPE_CONTRACT_VERSION,
	type CredentialCandidate,
	type CredentialLevel,
	type CredentialResolution,
	type CredentialScope,
	type CredentialSlot,
	credentialLevelRank,
	credentialScopeOwner,
	credentialSlotId,
	DENIED_INVALID_SLOT,
	DENIED_INVALID_SOURCE_POLICY,
	decodeCredentialCandidate,
	decodeCredentialResolution,
	decodeCredentialScope,
	decodeCredentialSlot,
	decodeGateDecision,
	decodeSourcePolicy,
	defaultSources,
	effectiveRules,
	type GateDecision,
	isValidCredentialSlot,
	POLICY_LEVEL_NAMES,
	parseCredentialLevel,
	parseCredentialSlot,
	parseSources,
	resolveCredential,
	SCOPE_EVIDENCE_KINDS,
	type ScopeEvidence,
	type ScopeRef,
	type SourcePolicy,
	type TraceEntry,
	type TraceStatus,
} from "./credential-scope.ts";

const SWEEP_TIMEOUT_MS = 120_000;

const IDS: Readonly<Record<CredentialLevel, string>> = {
	user: "u1",
	node: "n1",
	project: "p1",
	team: "t1",
	org: "o1",
};

const ALLOWED: GateDecision = { type: "allowed" };

function unwrap<T, E>(
	result: { ok: true; value: T } | { ok: false; error: E }
): T {
	if (!result.ok) {
		throw new Error("expected a successful result");
	}
	return result.value;
}

function openai(): CredentialSlot {
	return { purpose: "inference", provider: "openai", key: null };
}

function policyOf(allowed: readonly string[], orgAdmitsUser = false) {
	return { allowed, orgAdmitsUser } satisfies SourcePolicy;
}

function candidate(
	level: CredentialLevel,
	refId: string,
	priority: number
): CredentialCandidate {
	return {
		level,
		ownerId: IDS[level],
		slotId: "provider:openai",
		credentialRef: { id: refId, version: 1, fingerprint: `fp_${refId}` },
		priority,
		status: "active",
	};
}

function everyLevelCandidates(): CredentialCandidate[] {
	return CREDENTIAL_LADDER.map((level) => candidate(level, `ref_${level}`, 1));
}

function sharedScope(): CredentialScope {
	return {
		org: { id: "o1", evidence: "credential_bound" },
		node: { id: "n1", evidence: "credential_bound" },
		user: { id: "u1", evidence: "verified_identity" },
		team: { id: "t1", evidence: "verified_membership" },
		project: { id: "p1", evidence: "admin_mapped" },
		nodeKind: "tenant",
		personal: false,
	};
}

function selectedLevel(
	resolution: CredentialResolution
): CredentialLevel | null {
	return resolution.outcome.type === "selected"
		? resolution.outcome.level
		: null;
}

function ladderIndex(level: CredentialLevel): number {
	return CREDENTIAL_LADDER.indexOf(level);
}

/** Every option for one scope field: absent, or present with each evidence. */
function fieldOptions(level: CredentialLevel): Array<ScopeRef | null> {
	return [
		null,
		...SCOPE_EVIDENCE_KINDS.map((evidence) => ({ id: IDS[level], evidence })),
	];
}

/**
 * Every combination of evidence for every scope field, node kind and
 * personal flag (6^5 * 2 * 2 = 31,104 scopes), as in the Rust tests.
 */
function allScopes(): CredentialScope[] {
	const scopes: CredentialScope[] = [];
	for (const org of fieldOptions("org")) {
		for (const node of fieldOptions("node")) {
			for (const user of fieldOptions("user")) {
				for (const team of fieldOptions("team")) {
					for (const project of fieldOptions("project")) {
						for (const nodeKind of ["tenant", "fleet"] as const) {
							for (const personal of [false, true]) {
								scopes.push({
									org,
									node,
									user,
									team,
									project,
									nodeKind,
									personal,
								});
							}
						}
					}
				}
			}
		}
	}
	return scopes;
}

/** A test policy plus an independent description of what its list names. */
interface TestPolicy {
	/**
	 * Per ladder position: whether the list has an entry at that level that
	 * matches `provider:openai`. `null` for an empty list.
	 */
	listed: readonly boolean[] | null;
	policy: SourcePolicy;
}

/**
 * Every subset of bare levels (the empty subset is the default policy),
 * slot-scoped, prefix and non-matching entries for every level, and a lone
 * `user:provider:openai` entry, each with and without the org opt-in.
 */
function allPolicies(): TestPolicy[] {
	const lists: Array<{ entries: string[]; listed: boolean[] | null }> = [];
	for (let mask = 0; mask < 32; mask += 1) {
		const listed = CREDENTIAL_LADDER.map((_, bit) => (mask & (1 << bit)) !== 0);
		const entries = CREDENTIAL_LADDER.filter((_, bit) => listed[bit]);
		lists.push({ entries, listed: mask === 0 ? null : listed });
	}
	for (const [pattern, matches] of [
		["provider:openai", true],
		["provider:*", true],
		["provider:anthropic", false],
	] as const) {
		lists.push({
			entries: CREDENTIAL_LADDER.map((level) => `${level}:${pattern}`),
			listed: CREDENTIAL_LADDER.map(() => matches),
		});
	}
	lists.push({
		entries: ["user:provider:openai"],
		listed: [true, false, false, false, false],
	});
	const policies: TestPolicy[] = [];
	for (const orgAdmitsUser of [false, true]) {
		for (const { entries, listed } of lists) {
			policies.push({ policy: policyOf(entries, orgAdmitsUser), listed });
		}
	}
	return policies;
}

function hasEvidence(field: ScopeRef | null, evidence: ScopeEvidence) {
	return field?.evidence === evidence;
}

/**
 * The evidence rules written out independently of `evidenceUnlocks`, so a
 * change to either one fails the property tests.
 */
function oracleEvidence(
	level: CredentialLevel,
	scope: CredentialScope
): boolean {
	const verifiedUser = hasEvidence(scope.user, "verified_identity");
	const shared = !scope.personal && verifiedUser;
	if (level === "user") {
		return (
			verifiedUser ||
			(scope.personal && hasEvidence(scope.user, "credential_bound"))
		);
	}
	if (level === "node") {
		return scope.node !== null && scope.nodeKind === "tenant";
	}
	if (level === "project") {
		return shared && hasEvidence(scope.project, "admin_mapped");
	}
	if (level === "team") {
		return shared && hasEvidence(scope.team, "verified_membership");
	}
	return shared && hasEvidence(scope.org, "credential_bound");
}

/** The source rules written out independently of `effectiveRules`. */
function oracleAdmits(
	level: CredentialLevel,
	scope: CredentialScope,
	testPolicy: TestPolicy
): boolean {
	if (level === "user" && !scope.personal && !testPolicy.policy.orgAdmitsUser) {
		return false;
	}
	return testPolicy.listed?.[ladderIndex(level)] ?? true;
}

/** The full expected trace when every level holds an active candidate. */
function oracleTrace(
	scope: CredentialScope,
	testPolicy: TestPolicy
): TraceEntry[] {
	let selected = false;
	return CREDENTIAL_LADDER.map((level): TraceEntry => {
		let status: TraceStatus;
		if (scope[level] === null) {
			status = "not_in_scope";
		} else if (!oracleEvidence(level, scope)) {
			status = "evidence_insufficient";
		} else if (!oracleAdmits(level, scope, testPolicy)) {
			status = "source_not_allowed";
		} else if (selected) {
			status = "shadowed";
		} else {
			selected = true;
			status = "selected";
		}
		return { level, status };
	});
}

function sameTrace(left: readonly TraceEntry[], right: readonly TraceEntry[]) {
	return (
		left.length === right.length &&
		left.every(
			(entry, index) =>
				entry.level === right[index]?.level &&
				entry.status === right[index]?.status
		)
	);
}

const PROPERTY_NAMES = [
	"traceMatchesOracle",
	"traceCoversLadder",
	"outcomeMatchesTrace",
	"userNeedsOrgOptInOnSharedNode",
	"emptyPolicyNeverSelectsUserOnSharedNode",
	"listsNeverAdmitBeyondDefault",
	"sharedLevelsNeedVerifiedIdentity",
	"nodeAssertedProjectNeverUnlocks",
	"personalNeverReachesSharedLevels",
] as const;

type PropertyName = (typeof PROPERTY_NAMES)[number];

const SHARED_LEVELS: readonly CredentialLevel[] = ["project", "team", "org"];
const VIOLATION_SAMPLE_LIMIT = 3;

type SweepViolations = Record<PropertyName, string[]>;

function emptyViolations(): SweepViolations {
	return {
		traceMatchesOracle: [],
		traceCoversLadder: [],
		outcomeMatchesTrace: [],
		userNeedsOrgOptInOnSharedNode: [],
		emptyPolicyNeverSelectsUserOnSharedNode: [],
		listsNeverAdmitBeyondDefault: [],
		sharedLevelsNeedVerifiedIdentity: [],
		nodeAssertedProjectNeverUnlocks: [],
		personalNeverReachesSharedLevels: [],
	};
}

function record(
	violations: SweepViolations,
	name: PropertyName,
	holds: boolean,
	describeCase: () => string
) {
	const samples = violations[name];
	if (!holds && samples.length < VIOLATION_SAMPLE_LIMIT) {
		samples.push(describeCase());
	}
}

function checkResolution(
	violations: SweepViolations,
	scope: CredentialScope,
	testPolicy: TestPolicy,
	resolution: CredentialResolution,
	defaultTrace: readonly TraceEntry[]
) {
	const describeCase = () =>
		JSON.stringify({ scope, policy: testPolicy.policy, resolution });
	const level = selectedLevel(resolution);
	const levels = resolution.trace.map((entry) => entry.level);
	record(
		violations,
		"traceCoversLadder",
		levels.join(",") === CREDENTIAL_LADDER.join(","),
		describeCase
	);
	const selectedEntries = resolution.trace.filter(
		(entry) => entry.status === "selected"
	);
	const outcomeConsistent =
		resolution.outcome.type === "selected"
			? selectedEntries.length === 1 && selectedEntries[0]?.level === level
			: resolution.outcome.type === "not_found" &&
				selectedEntries.length === 0 &&
				resolution.trace.every((entry) => entry.status !== "shadowed");
	record(violations, "outcomeMatchesTrace", outcomeConsistent, describeCase);
	record(
		violations,
		"traceMatchesOracle",
		sameTrace(resolution.trace, oracleTrace(scope, testPolicy)),
		describeCase
	);
	const userStatus = resolution.trace[0]?.status;
	record(
		violations,
		"userNeedsOrgOptInOnSharedNode",
		scope.personal ||
			testPolicy.policy.orgAdmitsUser ||
			(level !== "user" &&
				userStatus !== "selected" &&
				userStatus !== "shadowed"),
		describeCase
	);
	record(
		violations,
		"emptyPolicyNeverSelectsUserOnSharedNode",
		scope.personal ||
			testPolicy.policy.allowed.length > 0 ||
			testPolicy.policy.orgAdmitsUser ||
			level !== "user",
		describeCase
	);
	const defaultStatus =
		level === null ? null : defaultTrace[ladderIndex(level)]?.status;
	record(
		violations,
		"listsNeverAdmitBeyondDefault",
		level === null ||
			defaultStatus === "selected" ||
			defaultStatus === "shadowed",
		describeCase
	);
	const sharedSelected = level !== null && SHARED_LEVELS.includes(level);
	record(
		violations,
		"sharedLevelsNeedVerifiedIdentity",
		scope.user?.evidence === "verified_identity" || !sharedSelected,
		describeCase
	);
	record(
		violations,
		"nodeAssertedProjectNeverUnlocks",
		scope.project?.evidence !== "node_asserted" || level !== "project",
		describeCase
	);
	record(
		violations,
		"personalNeverReachesSharedLevels",
		!(scope.personal && sharedSelected),
		describeCase
	);
}

let cachedSweep: SweepViolations | null = null;

/**
 * One pass over all 31,104 scopes and 72 policies (about 2.2 million
 * resolutions) with every ladder level holding an active candidate. Each
 * property test below asserts its own violation list from this shared pass.
 */
function sweep(): SweepViolations {
	if (cachedSweep !== null) {
		return cachedSweep;
	}
	const violations = emptyViolations();
	const candidates = everyLevelCandidates();
	const policies = allPolicies();
	for (const scope of allScopes()) {
		const defaultTraces = [false, true].map(
			(orgAdmitsUser) =>
				resolveCredential(
					openai(),
					scope,
					candidates,
					ALLOWED,
					policyOf([], orgAdmitsUser)
				).trace
		);
		for (const testPolicy of policies) {
			const resolution = resolveCredential(
				openai(),
				scope,
				candidates,
				ALLOWED,
				testPolicy.policy
			);
			const defaultTrace =
				defaultTraces[testPolicy.policy.orgAdmitsUser ? 1 : 0] ?? [];
			checkResolution(violations, scope, testPolicy, resolution, defaultTrace);
		}
	}
	cachedSweep = violations;
	return violations;
}

const fixtureSchema = z.strictObject({
	version: z.number(),
	cases: z.array(
		z.strictObject({
			name: z.string(),
			slot: z.unknown(),
			scope: z.unknown(),
			candidates: z.array(z.unknown()),
			gate: z.unknown(),
			policy: z.unknown(),
			expected: z.unknown(),
		})
	),
});

const fixture = fixtureSchema.parse(golden);

describe("credential scope golden fixture", () => {
	test("is version 1 with unique case names", () => {
		expect(fixture.version).toBe(CREDENTIAL_SCOPE_CONTRACT_VERSION);
		expect(fixture.cases.length).toBe(42);
		const names = fixture.cases.map((entry) => entry.name);
		expect(new Set(names).size).toBe(names.length);
	});

	test("covers the planned cases", () => {
		for (const prefix of [
			"a_",
			"b_",
			"c_",
			"d_",
			"e_",
			"f_",
			"g_",
			"h_",
			"i_",
			"j_",
			"k_",
			"k2_",
			"l_",
			"l2_",
			"m_",
			"n_",
			"n2_",
			"q_",
			"q2_",
			"q3_",
			"q4_",
			"q5_",
			"r_",
			"r2_",
			"r3_",
			"r4_",
			"r5_",
			"r6_",
			"s_",
			"s2_",
		]) {
			expect(fixture.cases.some((entry) => entry.name.startsWith(prefix))).toBe(
				true
			);
		}
	});

	for (const golden of fixture.cases) {
		test(golden.name, () => {
			const slot = unwrap(decodeCredentialSlot(golden.slot));
			const scope = unwrap(decodeCredentialScope(golden.scope));
			const candidates = golden.candidates.map((entry) =>
				unwrap(decodeCredentialCandidate(entry))
			);
			const gate = unwrap(decodeGateDecision(golden.gate));
			const policy = unwrap(decodeSourcePolicy(golden.policy));
			const actual = resolveCredential(slot, scope, candidates, gate, policy);
			// Both the outcome and the full trace, as exact JSON wire shapes.
			expect(actual).toStrictEqual(
				unwrap(decodeCredentialResolution(golden.expected))
			);
			expect(JSON.parse(JSON.stringify(actual))).toStrictEqual(golden.expected);
		});
	}
});

describe("credential levels", () => {
	test("parse canonical names and the two aliases only", () => {
		for (const level of CREDENTIAL_LADDER) {
			expect(parseCredentialLevel(level)).toBe(level);
		}
		expect(parseCredentialLevel("organization")).toBe("org");
		expect(parseCredentialLevel("personal")).toBe("user");
		for (const rejected of [
			"Org",
			"node ",
			"tenant",
			"",
			"ORG",
			" user",
			"managed",
			"fleet",
		]) {
			expect(parseCredentialLevel(rejected)).toBeNull();
		}
	});

	test("rank follows the ladder and POLICY_LEVEL_NAMES omits node", () => {
		expect(CREDENTIAL_LADDER.map(credentialLevelRank)).toEqual([4, 3, 2, 1, 0]);
		const names = CREDENTIAL_LADDER.filter((level) => level !== "node").sort();
		expect([...POLICY_LEVEL_NAMES].sort()).toEqual(names);
		expect(POLICY_LEVEL_NAMES.includes("node")).toBe(false);
	});

	test("aliases decode on the wire and serialize canonically", () => {
		const decoded = unwrap(
			decodeCredentialCandidate({
				...candidate("org", "ref_org", 3),
				level: "organization",
			})
		);
		expect(decoded.level).toBe("org");
		expect(JSON.parse(JSON.stringify(decoded))).toEqual(
			candidate("org", "ref_org", 3)
		);
		const personal = unwrap(
			decodeCredentialCandidate({
				...candidate("user", "ref_user", 3),
				level: "personal",
			})
		);
		expect(personal.level).toBe("user");
		expect(
			decodeCredentialCandidate({
				...candidate("org", "ref_org", 3),
				level: "Org",
			}).ok
		).toBe(false);
	});
});

describe("credential slot grammar", () => {
	test("accepts the closed grammar and round-trips", () => {
		for (const [slotId, purpose, provider, key] of [
			["provider:openai", "inference", "openai", null],
			["provider:genai:vertex", "inference", "genai:vertex", null],
			["platform:composio", "connection_platform", "composio", null],
			["platform:treg", "connection_platform", "treg", null],
			[
				"connection:composio:github",
				"connection_account",
				"composio",
				"github",
			],
			[
				"connection:mcp:com.ryu.browser",
				"connection_account",
				"mcp",
				"com.ryu.browser",
			],
			["tool:exa", "tool_vendor", "exa", null],
			["tool:brave-search", "tool_vendor", "brave-search", null],
		] as const) {
			const slot = unwrap(parseCredentialSlot(slotId));
			expect(slot).toStrictEqual({ purpose, provider, key });
			expect(credentialSlotId(slot)).toBe(slotId);
			expect(isValidCredentialSlot(slot)).toBe(true);
			expect(unwrap(decodeCredentialSlot(slotId))).toStrictEqual(slot);
		}
		const longest = `provider:${"a".repeat(CREDENTIAL_MAX_ID_LEN)}`;
		expect(parseCredentialSlot(longest).ok).toBe(true);
	});

	test("rejects everything outside the grammar", () => {
		for (const rejected of [
			"",
			"provider:",
			"provider: openai",
			"provider:open ai",
			"provider:openai\n",
			"provider:opénai",
			"provider:open*",
			"provider:genai:",
			"provider::x",
			`provider:${"a".repeat(CREDENTIAL_MAX_ID_LEN + 1)}`,
			"platform:",
			"platform:other",
			"platform:composio:x",
			"connection:",
			"connection:composio",
			"connection:composio:",
			"connection:composio:a:b",
			"connection:slack:general",
			"connection:mcp:",
			"connection:mcp:a b",
			`connection:composio:${"a".repeat(CREDENTIAL_MAX_ID_LEN + 1)}`,
			"tool:",
			"tool:Exa",
			"tool:exa:search",
			"tool:exa.search",
			"tool:-exa",
			"tool:ex_a",
			"secret:openai",
			"Provider:openai",
			"openai",
		]) {
			expect(parseCredentialSlot(rejected).ok).toBe(false);
			expect(decodeCredentialSlot(rejected).ok).toBe(false);
		}
		expect(decodeCredentialSlot(7).ok).toBe(false);
	});

	test("errors carry fixed reasons, never the input", () => {
		const result = parseCredentialSlot("provider:sk-leaked secret");
		expect(result).toStrictEqual({
			ok: false,
			error: { reason: "provider id must be 1-128 visible ASCII" },
		});
	});

	test("hand-built slots outside the grammar are invalid", () => {
		expect(
			isValidCredentialSlot({
				purpose: "connection_platform",
				provider: "other",
				key: null,
			})
		).toBe(false);
		expect(
			isValidCredentialSlot({
				purpose: "inference",
				provider: "openai",
				key: "extra",
			})
		).toBe(false);
		expect(
			isValidCredentialSlot({
				purpose: "tool_vendor",
				provider: "exa",
				key: "search",
			})
		).toBe(false);
	});
});

describe("source policy grammar", () => {
	test("parses bare levels, aliases, exact slots and prefixes", () => {
		const parsed = unwrap(
			parseSources(
				policyOf([
					"team",
					"organization",
					"personal:provider:openai",
					"user:provider:genai:*",
					"node:connection:*",
					"team:tool:exa",
					"org:tool:*",
				])
			)
		);
		expect(parsed).toStrictEqual([
			{ level: "team", slots: { kind: "any" } },
			{ level: "org", slots: { kind: "any" } },
			{ level: "user", slots: { kind: "exact", slotId: "provider:openai" } },
			{ level: "user", slots: { kind: "prefix", prefix: "provider:genai:" } },
			{ level: "node", slots: { kind: "prefix", prefix: "connection:" } },
			{ level: "team", slots: { kind: "exact", slotId: "tool:exa" } },
			{ level: "org", slots: { kind: "prefix", prefix: "tool:" } },
		]);
	});

	test("one invalid entry fails the whole policy by index", () => {
		for (const rejected of [
			"",
			"*",
			"tenant",
			"Org",
			" team",
			"team ",
			"user:",
			"user:*",
			"user:p*",
			"user:provider:*:x",
			"user:provider:a*b",
			"user:provider:open ai",
			"user:platform:other",
			"team:tool:Exa",
			"team:tools:*",
			"managed",
			"user*",
		]) {
			const result = parseSources(policyOf(["org", rejected]));
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.index).toBe(1);
			}
		}
	});

	test("decoding defaults the list and the opt-in", () => {
		expect(unwrap(decodeSourcePolicy({ allowed: ["user"] }))).toStrictEqual(
			policyOf(["user"])
		);
		expect(unwrap(decodeSourcePolicy({}))).toStrictEqual(policyOf([]));
		expect(JSON.parse(JSON.stringify(policyOf(["org"], true)))).toStrictEqual({
			allowed: ["org"],
			orgAdmitsUser: true,
		});
		expect(decodeSourcePolicy({ allowed: [], extra: true }).ok).toBe(false);
	});
});

describe("default sources and narrowing", () => {
	test("user is in the default only when personal or opted in", () => {
		const scope = sharedScope();
		expect(defaultSources(scope, false)).toEqual([
			"node",
			"project",
			"team",
			"org",
		]);
		expect(defaultSources(scope, true)).toEqual([...CREDENTIAL_LADDER]);
		const personal = { ...scope, personal: true };
		expect(defaultSources(personal, false)).toEqual([...CREDENTIAL_LADDER]);
		expect(defaultSources(personal, true)).toEqual([...CREDENTIAL_LADDER]);
	});

	test("effective rules only narrow the default", () => {
		const scope = sharedScope();
		const levels = (policy: SourcePolicy) =>
			unwrap(effectiveRules(policy, scope)).map((rule) => rule.level);
		expect(levels(policyOf(["user"]))).toEqual([]);
		expect(levels(policyOf(["user", "team"]))).toEqual(["team"]);
		expect(levels(policyOf(["personal:provider:*"]))).toEqual([]);
		expect(levels(policyOf(["user", "team"], true))).toEqual(["user", "team"]);
		expect(effectiveRules(policyOf(["user", "tenant"]), scope).ok).toBe(false);
	});

	test("a lower layer's user entry never selects user without the opt-in", () => {
		const candidates = everyLevelCandidates();
		for (const entries of [
			["user"],
			["personal"],
			["user", "team"],
			["user", "node", "project", "team", "org"],
			["user:provider:openai"],
			["user:provider:*"],
		]) {
			const resolution = resolveCredential(
				openai(),
				sharedScope(),
				candidates,
				ALLOWED,
				policyOf(entries)
			);
			expect(selectedLevel(resolution)).not.toBe("user");
			expect(resolution.trace[0]).toStrictEqual({
				level: "user",
				status: "source_not_allowed",
			});
		}
	});
});

describe("evidence", () => {
	test("each shared level accepts only its own evidence", () => {
		const required: ReadonlyArray<readonly [CredentialLevel, ScopeEvidence]> = [
			["project", "admin_mapped"],
			["team", "verified_membership"],
			["org", "credential_bound"],
			["user", "verified_identity"],
		];
		const candidates = everyLevelCandidates();
		for (const [level, needed] of required) {
			for (const evidence of SCOPE_EVIDENCE_KINDS) {
				const scope: CredentialScope = {
					...sharedScope(),
					[level]: { id: IDS[level], evidence },
				};
				const resolution = resolveCredential(
					openai(),
					scope,
					candidates,
					ALLOWED,
					policyOf([level], true)
				);
				if (evidence === needed) {
					expect(selectedLevel(resolution)).toBe(level);
				} else {
					expect(resolution.outcome).toStrictEqual({ type: "not_found" });
					expect(resolution.trace[ladderIndex(level)]?.status).toBe(
						"evidence_insufficient"
					);
				}
			}
		}
	});

	test("a node-only candidate on a tenant node always resolves to node", () => {
		const nodeOnly = [candidate("node", "ref_node", 0)];
		let checked = 0;
		for (const scope of allScopes()) {
			if (scope.nodeKind !== "tenant" || scope.node === null) {
				continue;
			}
			const resolution = resolveCredential(
				openai(),
				scope,
				nodeOnly,
				ALLOWED,
				policyOf([])
			);
			if (selectedLevel(resolution) !== "node") {
				throw new Error(`node did not resolve for ${JSON.stringify(scope)}`);
			}
			checked += 1;
		}
		expect(checked).toBe(5 * 6 * 6 * 6 * 6 * 2);
	});

	test("invalid scope ids are not in scope", () => {
		const emptyOwner = { ...candidate("org", "empty", 1), ownerId: "" };
		const scope: CredentialScope = {
			...sharedScope(),
			org: { id: "", evidence: "credential_bound" },
		};
		const resolution = resolveCredential(
			openai(),
			scope,
			[emptyOwner],
			ALLOWED,
			policyOf(["org"])
		);
		expect(resolution.outcome).toStrictEqual({ type: "not_found" });
		expect(resolution.trace[4]).toStrictEqual({
			level: "org",
			status: "not_in_scope",
		});
		const spaced: CredentialScope = {
			...sharedScope(),
			org: { id: "o 1", evidence: "credential_bound" },
		};
		expect(credentialScopeOwner(spaced, "org")).toBeNull();
	});
});

describe("resolution", () => {
	test("a gate denial beats candidates, invalid slots and invalid policies", () => {
		const gate: GateDecision = {
			type: "denied",
			code: "provider_not_approved",
		};
		const denial = { outcome: gate, trace: [] };
		const candidates = everyLevelCandidates();
		for (const policy of [policyOf([]), policyOf(CREDENTIAL_LADDER)]) {
			expect(
				resolveCredential(openai(), sharedScope(), candidates, gate, policy)
			).toStrictEqual(denial);
		}
		const invalidSlot: CredentialSlot = {
			purpose: "inference",
			provider: "open ai",
			key: null,
		};
		expect(
			resolveCredential(
				invalidSlot,
				sharedScope(),
				candidates,
				gate,
				policyOf(["tenant"])
			)
		).toStrictEqual(denial);
	});

	test("invalid slots and policies are denied with an empty trace", () => {
		const candidates = everyLevelCandidates();
		expect(
			resolveCredential(
				{ purpose: "inference", provider: "", key: null },
				sharedScope(),
				candidates,
				ALLOWED,
				policyOf([])
			)
		).toStrictEqual({
			outcome: { type: "denied", code: DENIED_INVALID_SLOT },
			trace: [],
		});
		expect(
			resolveCredential(
				openai(),
				sharedScope(),
				candidates,
				ALLOWED,
				policyOf(["org", "Team"])
			)
		).toStrictEqual({
			outcome: { type: "denied", code: DENIED_INVALID_SOURCE_POLICY },
			trace: [],
		});
	});

	test("inactive candidates are skipped and the tie-break ignores order", () => {
		const resolveOrg = (candidates: CredentialCandidate[]) =>
			resolveCredential(
				openai(),
				sharedScope(),
				candidates,
				ALLOWED,
				policyOf(["org"])
			).outcome;
		const inactive = (["disabled", "expired", "revoked"] as const).map(
			(status) => ({ ...candidate("org", "a_inactive", 99), status })
		);
		expect(resolveOrg(inactive)).toStrictEqual({ type: "not_found" });
		const active = candidate("org", "z_active", 1);
		expect(resolveOrg([...inactive, active])).toStrictEqual({
			type: "selected",
			level: "org",
			credentialRef: active.credentialRef,
		});
		const versioned = (version: number) => {
			const entry = candidate("org", "a", 10);
			return { ...entry, credentialRef: { ...entry.credentialRef, version } };
		};
		for (const [candidates, winner, version] of [
			[[candidate("org", "a", 5), candidate("org", "z", 20)], "z", 1],
			[
				[
					candidate("org", "b", 10),
					candidate("org", "a", 10),
					candidate("org", "c", 5),
				],
				"a",
				1,
			],
			[[versioned(1), versioned(2)], "a", 2],
		] as const) {
			for (const ordering of [[...candidates], [...candidates].reverse()]) {
				const outcome = resolveOrg(ordering);
				expect(outcome.type === "selected" && outcome.credentialRef.id).toBe(
					winner
				);
				expect(
					outcome.type === "selected" && outcome.credentialRef.version
				).toBe(version);
			}
		}
	});

	test("ref ids compare in UTF-8 byte order like Rust", () => {
		// U+FF5E sorts before U+1F600 in code point (UTF-8 byte) order, but
		// after it in UTF-16 code unit order.
		const bmp = candidate("org", "～", 10);
		const astral = candidate("org", "\u{1f600}", 10);
		for (const ordering of [
			[bmp, astral],
			[astral, bmp],
		]) {
			const outcome = resolveCredential(
				openai(),
				sharedScope(),
				ordering,
				ALLOWED,
				policyOf(["org"])
			).outcome;
			expect(outcome.type === "selected" && outcome.credentialRef.id).toBe(
				"～"
			);
		}
	});

	test("foreign owners, other slots and other levels are ignored", () => {
		const resolution = resolveCredential(
			openai(),
			sharedScope(),
			[
				{ ...candidate("org", "foreign", 99), ownerId: "o2" },
				{ ...candidate("org", "anthropic", 99), slotId: "provider:anthropic" },
				{ ...candidate("team", "wrong_level", 99), ownerId: "o1" },
			],
			ALLOWED,
			policyOf(["org"])
		);
		expect(resolution.outcome).toStrictEqual({ type: "not_found" });
	});

	test("wire shapes are camelCase and a smuggled value is rejected", () => {
		const entry = candidate("org", "ref_org", 3);
		const resolution = resolveCredential(
			openai(),
			sharedScope(),
			[entry],
			ALLOWED,
			policyOf([])
		);
		const wire: unknown = JSON.parse(JSON.stringify(resolution));
		expect(JSON.parse(JSON.stringify(entry))).toStrictEqual({
			level: "org",
			ownerId: "o1",
			slotId: "provider:openai",
			credentialRef: { id: "ref_org", version: 1, fingerprint: "fp_ref_org" },
			priority: 3,
			status: "active",
		});
		expect(JSON.parse(JSON.stringify(resolution.outcome))).toStrictEqual({
			type: "selected",
			level: "org",
			credentialRef: { id: "ref_org", version: 1, fingerprint: "fp_ref_org" },
		});
		expect(resolution.trace[0]).toStrictEqual({
			level: "user",
			status: "source_not_allowed",
		});
		expect(unwrap(decodeCredentialResolution(wire))).toStrictEqual(resolution);
		const keys: string[] = [];
		const collect = (value: unknown) => {
			if (Array.isArray(value)) {
				for (const item of value) {
					collect(item);
				}
			} else if (typeof value === "object" && value !== null) {
				for (const [key, nested] of Object.entries(value)) {
					keys.push(key);
					collect(nested);
				}
			}
		};
		collect(wire);
		collect(entry);
		collect(sharedScope());
		for (const key of keys) {
			expect(key.toLowerCase()).not.toContain("value");
			expect(key.toLowerCase()).not.toContain("secret");
			expect(key).not.toContain("_");
		}
		expect(
			decodeCredentialCandidate({ ...entry, value: "sk-should-never-be-here" })
				.ok
		).toBe(false);
		expect(
			decodeCredentialCandidate({
				...entry,
				credentialRef: { ...entry.credentialRef, secret: "sk-never" },
			}).ok
		).toBe(false);
		const rejected = decodeCredentialCandidate({ ...entry, value: "sk-x" });
		expect(JSON.stringify(rejected)).not.toContain("sk-x");
		expect(decodeCredentialCandidate({ ...entry, priority: 65_536 }).ok).toBe(
			false
		);
		expect(decodeGateDecision({ type: "denied", code: "x" })).toStrictEqual({
			ok: true,
			value: { type: "denied", code: "x" },
		});
		const scopeWire = unwrap(
			decodeCredentialScope({ nodeKind: "tenant", personal: false })
		);
		expect(scopeWire.org).toBeNull();
	});
});

describe("exhaustive properties", () => {
	for (const name of PROPERTY_NAMES) {
		test(
			name,
			() => {
				expect(sweep()[name]).toEqual([]);
			},
			SWEEP_TIMEOUT_MS
		);
	}
});

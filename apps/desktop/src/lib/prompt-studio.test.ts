import { describe, expect, test } from "bun:test";
import type { EvalRunResult } from "./api/gateway.ts";
import {
	ASSERTION_KINDS,
	assertionText,
	defaultAssertion,
	gatewayAssertion,
	isPersistedAssertion,
	isPersistedRow,
	loadTestSuite,
	parseCodeEvaluators,
	persistTestSuite,
	promptVariantRunsSchema,
	withAssertionText,
} from "./prompt-studio.ts";

class DraftStorage {
	readonly drafts = new Map<string, string>();
	getItem(key: string) {
		return this.drafts.get(key) ?? null;
	}
	setItem(key: string, value: string) {
		this.drafts.set(key, value);
	}
}

describe("Prompt Studio assertion boundaries", () => {
	test("every selectable assertion begins with its required Gateway payload", () => {
		for (const kind of ASSERTION_KINDS) {
			const assertion = defaultAssertion(kind);
			expect(isPersistedAssertion(assertion)).toBe(true);
			expect(assertion.kind).toBe(kind);
		}
		expect(defaultAssertion("similar")).toEqual({ kind: "similar", value: "" });
	});
	test("nested assertion edits keep incomplete drafts and reject malformed entries", () => {
		const assertion = {
			kind: "assert_set",
			assertions: [],
			options: { weight: 2 },
		} satisfies ReturnType<typeof defaultAssertion>;
		expect(withAssertionText(assertion, "[")).toBe(assertion);
		expect(withAssertionText(assertion, "null")).toBe(assertion);
		expect(
			withAssertionText(
				assertion,
				'[{"kind":"contains","value":"safe"},{"kind":"similar","rubric":"wrong"},null]'
			)
		).toEqual({
			kind: "assert_set",
			options: { weight: 2 },
			assertions: [{ kind: "contains", value: "safe" }],
		});
	});
	test("text edits and flattened options preserve the variant and user settings", () => {
		const assertion = {
			kind: "llm_rubric",
			rubric: "old",
			options: { not: true, weight: 2 },
		} satisfies ReturnType<typeof defaultAssertion>;
		const updated = withAssertionText(assertion, "new");
		expect(assertionText(updated)).toBe("new");
		expect(gatewayAssertion(updated)).toEqual({
			kind: "llm_rubric",
			rubric: "new",
			not: true,
			weight: 2,
		});
	});
});

describe("Prompt Studio persisted drafts", () => {
	test("restores legacy rows with missing optional controls and drops malformed contracts", () => {
		const storage = new DraftStorage();
		const row = {
			id: "old",
			name: "case",
			input: "hello",
			expected: "hi",
			threshold: "",
			vars: { name: "Sam" },
			assertions: [{ kind: "contains", value: "hi" }],
			additive: { retain: true },
		};
		storage.setItem(
			"prompt-studio-tests:agent",
			JSON.stringify({
				rows: [
					row,
					{ ...row, id: 3 },
					{
						...row,
						id: "invalid-messages",
						messages: [{ role: "tool", content: 12 }],
					},
				],
				evaluatorIds: [null, "security"],
				extraModels: [true, "model"],
				judgeModel: "judge",
				tags: { team: "support", malformed: 42 },
				codeEvaluators: [
					{ id: "  judge  ", lang: "python", source: "return 1" },
					{ id: "bad", lang: "shell", source: "exit 0" },
				],
			})
		);
		const snapshot = loadTestSuite("agent", storage);
		expect(snapshot.rows).toHaveLength(1);
		expect(snapshot.rows[0]).toMatchObject({
			...row,
			metadata: {},
			options: {},
			providers: [],
		});
		expect(snapshot.evaluatorIds).toEqual(["security"]);
		expect(snapshot.extraModels).toEqual(["model"]);
		expect(snapshot.tags).toEqual({ team: "support" });
		expect(snapshot.codeEvaluators).toEqual([
			{ id: "judge", lang: "python", source: "return 1" },
		]);
	});
	test("preserves own JSON keys without changing prototypes during save and restore", () => {
		const storage = new DraftStorage();
		storage.setItem(
			"prompt-studio-tests:agent",
			'{"rows":[{"id":"own","name":"","input":"","expected":"","threshold":"","vars":{"__proto__":"literal"},"assertions":[]}]}'
		);
		const snapshot = loadTestSuite("agent", storage);
		expect(Object.hasOwn(snapshot.rows[0]?.vars ?? {}, "__proto__")).toBe(true);
		persistTestSuite("agent", snapshot, storage);
		expect(loadTestSuite("agent", storage).rows[0]?.vars).toEqual(
			snapshot.rows[0]?.vars
		);
	});
	test("storage read and write failures preserve usable empty drafts", () => {
		expect(
			loadTestSuite("agent", {
				getItem() {
					throw new Error("unavailable");
				},
			})
		).toEqual({ evaluatorIds: [], extraModels: [], judgeModel: "", rows: [] });
		expect(() =>
			persistTestSuite(
				"agent",
				{ evaluatorIds: [], extraModels: [], judgeModel: "", rows: [] },
				{
					setItem() {
						throw new Error("quota");
					},
				}
			)
		).not.toThrow();
	});
	test("guards malformed option records and code evaluator contracts", () => {
		expect(
			isPersistedAssertion({
				kind: "contains",
				value: "safe",
				options: { not: "yes" },
			})
		).toBe(false);
		expect(
			isPersistedRow({
				id: "1",
				name: "",
				input: "",
				expected: "",
				threshold: "",
				vars: [],
				assertions: [],
			})
		).toBe(false);
		expect(
			parseCodeEvaluators([{ id: "empty", lang: "js", source: "" }, null])
		).toEqual([]);
	});
});

test("saved eval results validate their full owner contract and preserve additive JSON", () => {
	const result = {
		aggregate: {
			mean_latency: 1,
			mean_overall: 0.8,
			mean_substring_match: null,
			mean_token_efficiency: 1,
			policy_pass_rate: 1,
			total_cases: 1,
		},
		cases: [
			{
				assertion_score: 1,
				assertions: [],
				assertions_pass: true,
				latency_score: 1,
				overall: 0.8,
				policy_pass: true,
				prompt: "hello",
				response_text: "hi",
				substring_match: null,
				token_efficiency: 1,
			},
		],
	} satisfies EvalRunResult;
	const variants = [
		{
			promptId: "primary",
			promptName: "Primary",
			result,
			additive: { retained: true },
		},
	];
	expect(promptVariantRunsSchema.parse(variants)).toBe(variants);
	expect(() =>
		promptVariantRunsSchema.parse([
			{
				...variants[0],
				result: {
					...result,
					cases: [{ ...result.cases[0], response_text: 42 }],
				},
			},
		])
	).toThrow();
});

test("chat message edits accept owner roles and retain additive valid JSON", async () => {
	const { parseEvalMessages } = await import("./prompt-studio.ts");
	const message = {
		role: "user" as const,
		content: "hello",
		future: { value: 1 },
	};
	expect(
		parseEvalMessages([
			message,
			{ role: "tool", content: "hidden" },
			{ role: "assistant", content: 42 },
			null,
		])
	).toEqual([message]);
	expect(parseEvalMessages([message])[0]).toBe(message);
	expect(parseEvalMessages({ messages: [message] })).toEqual([]);
});

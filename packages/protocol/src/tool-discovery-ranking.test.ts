import { describe, expect, test } from "bun:test";
import golden from "../../../crates/core/tool-registry/fixtures/bm25-golden.json" with {
	type: "json",
};
import cases from "./fixtures/tool-discovery-ranking-cases-v1.json" with {
	type: "json",
};
import {
	applyJudge,
	bm25Scores,
	cosineSimilarity,
	DEFAULT_MIN_SIMILARITY,
	embeddingText,
	type FusedRow,
	fuseRankings,
	JOB_DEPTH,
	JOB_WEIGHT,
	JUDGE_DEFAULT_TOP_K,
	JUDGE_MAX_TOP_K,
	JUDGE_SYSTEM_PROMPT,
	type JudgeVerdict,
	jobText,
	judgeMessages,
	LEXICAL_WEIGHT,
	MAX_EMBEDDING_TEXT_CHARS,
	MAX_JUDGE_DESCRIPTION_CHARS,
	parseJudgeVerdict,
	RRF_K,
	rankingDisclosureSchema,
	rowRankingSchema,
	SEMANTIC_DEPTH,
	SEMANTIC_WEIGHT,
	TOOL_DISCOVERY_RANKING_VERSION,
	tokenize,
} from "./tool-discovery-ranking.ts";

interface ExpectedRow {
	fused: number;
	id: string;
	jobRank: number | null;
	lexicalRank: number | null;
	semanticRank: number | null;
}

/** Rows as the case file records them (fused rounded to 1e-9). */
function rowsOf(rows: FusedRow[]): ExpectedRow[] {
	return rows.map((row) => ({
		fused: Math.round(row.fused * 1e9) / 1e9,
		id: row.id,
		jobRank: row.jobRank,
		lexicalRank: row.lexicalRank,
		semanticRank: row.semanticRank,
	}));
}

describe("tool discovery ranking shared cases", () => {
	test("the case file matches this contract", () => {
		expect(cases.version).toBe(TOOL_DISCOVERY_RANKING_VERSION);
		expect(cases.constants).toEqual({
			rrfK: RRF_K,
			lexicalWeight: LEXICAL_WEIGHT,
			semanticWeight: SEMANTIC_WEIGHT,
			jobWeight: JOB_WEIGHT,
			minSimilarity: DEFAULT_MIN_SIMILARITY,
			semanticDepth: SEMANTIC_DEPTH,
			jobDepth: JOB_DEPTH,
			judgeDefaultTopK: JUDGE_DEFAULT_TOP_K,
			judgeMaxTopK: JUDGE_MAX_TOP_K,
			maxEmbeddingTextChars: MAX_EMBEDDING_TEXT_CHARS,
			maxJudgeDescriptionChars: MAX_JUDGE_DESCRIPTION_CHARS,
		});
		expect(cases.judgeSystemPrompt).toBe(JUDGE_SYSTEM_PROMPT);
	});

	test("judge messages", () => {
		expect(
			judgeMessages(cases.judgeMessages.query, cases.judgeMessages.candidates)
		).toEqual(cases.judgeMessages.expected as never);
	});

	for (const shared of cases.cosine) {
		test(`cosine ${JSON.stringify(shared.left)} ${JSON.stringify(shared.right)}`, () => {
			expect(
				Math.abs(cosineSimilarity(shared.left, shared.right) - shared.expected)
			).toBeLessThan(1e-9);
		});
	}

	for (const shared of cases.embeddingText) {
		test(`embedding text: ${shared.name}`, () => {
			expect(embeddingText(shared.input)).toBe(shared.expected);
		});
	}

	for (const shared of cases.jobText) {
		test(`job text: ${shared.input.name}`, () => {
			expect(jobText(shared.input)).toBe(shared.expected);
		});
	}

	for (const shared of cases.fusion) {
		test(`fusion: ${shared.name}`, () => {
			expect(
				rowsOf(
					fuseRankings(
						shared.candidates,
						shared.jobs as Record<string, number>,
						"options" in shared ? shared.options : {}
					)
				)
			).toEqual(shared.expected);
		});
	}

	for (const shared of cases.judgeParse) {
		test(`judge parse: ${shared.name}`, () => {
			expect(parseJudgeVerdict(shared.text, shared.candidateIds)).toEqual(
				shared.expected as JudgeVerdict | null
			);
		});
	}

	for (const shared of cases.judgeApply) {
		test(`judge apply: ${shared.name}`, () => {
			expect(
				applyJudge(shared.ordered, shared.verdict as JudgeVerdict, shared.topK)
			).toEqual(shared.expected);
		});
	}

	const { corpusJobs, corpusVectors, jobVectors } = cases.hybrid;
	for (const shared of cases.hybrid.queries) {
		test(`hybrid golden: ${JSON.stringify(shared.query)}`, () => {
			const lexical = bm25Scores(shared.query, golden.corpus);
			const candidates = golden.corpus.map((doc, index) => ({
				id: doc.id,
				job: (corpusJobs as Record<string, string | null>)[doc.id] ?? null,
				lexical: lexical[index] ?? 0,
				semantic: cosineSimilarity(
					shared.queryVector,
					(corpusVectors as Record<string, number[]>)[doc.id] ?? []
				),
			}));
			const jobs = Object.fromEntries(
				Object.entries(jobVectors as Record<string, number[]>).map(
					([id, vector]) => [id, cosineSimilarity(shared.queryVector, vector)]
				)
			);
			expect(rowsOf(fuseRankings(candidates, jobs))).toEqual(shared.expected);
		});
	}
});

describe("BM25 port", () => {
	test("tokenizes as Core does", () => {
		expect(tokenize("composio.GITHUB_GET_AN_ISSUE")).toEqual([
			"composio",
			"github",
			"get",
			"an",
			"issue",
		]);
	});

	for (const query of golden.queries) {
		test(`golden query ${JSON.stringify(query.query)} ranks as Core ranks it`, () => {
			const scores = bm25Scores(query.query, golden.corpus);
			const positive = golden.corpus
				.map((doc, index) => ({ id: doc.id, score: scores[index] ?? 0 }))
				.filter((row) => row.score > 0)
				.sort((left, right) => right.score - left.score);
			expect(positive.map((row) => row.id)).toEqual(
				query.expected.map((row) => row.id)
			);
			for (const [index, row] of query.expected.entries()) {
				expect(
					Math.abs((positive[index]?.score ?? 0) - row.score)
				).toBeLessThan(1e-3);
			}
		});
	}
});

describe("disclosure schemas", () => {
	test("a hybrid answer with a judge verdict parses", () => {
		expect(
			rankingDisclosureSchema.parse({
				embeddingModel: "text-embedding-3-small",
				gatewayRequestIds: ["req-1", "req-2"],
				judge: {
					considered: 8,
					gatewayRequestId: "req-2",
					model: "gpt-4.1-nano",
					ref: "judge_abc",
					status: "applied",
					verdict: "match",
				},
				mode: "hybrid",
				requested: "hybrid",
			}).mode
		).toBe("hybrid");
	});

	test("a fallback names its reason and unknown reasons are refused", () => {
		expect(
			rankingDisclosureSchema.safeParse({
				fallback: "gateway_unavailable",
				mode: "lexical",
				requested: "hybrid",
			}).success
		).toBe(true);
		expect(
			rankingDisclosureSchema.safeParse({
				fallback: "because",
				mode: "lexical",
				requested: "hybrid",
			}).success
		).toBe(false);
	});

	test("row ranks are positive or null", () => {
		expect(
			rowRankingSchema.safeParse({
				fused: 0.03,
				jobRank: null,
				lexicalRank: 0,
				semanticRank: 1,
				similarity: 0.8,
			}).success
		).toBe(false);
	});
});

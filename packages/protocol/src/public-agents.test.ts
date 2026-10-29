import { describe, expect, it } from "bun:test";
import {
	type PublicAgentOwnerRecord,
	type PublicAgentTurnInput,
	parsePublicAgentCard,
	parsePublicAgentDetail,
	parsePublicAgentReportInput,
	parsePublicAgentTurnInput,
	parsePublicAgentWriteInput,
	publicAgentAnswerSolicitsSensitiveSecrets,
	toPublicAgentCard,
	toPublicAgentDetail,
} from "./public-agents.ts";

const PUBLICATION_ID = "2d601b0c-8773-4db3-8b26-e3f79fe878c6";

describe("public agent protocol", () => {
	it("detects high-confidence requests for sensitive secrets in public replies", () => {
		expect(
			publicAgentAnswerSolicitsSensitiveSecrets(
				"Please share your one-time code so I can finish this."
			)
		).toBe(true);
		expect(
			publicAgentAnswerSolicitsSensitiveSecrets(
				"I can help draft a bio without personal details."
			)
		).toBe(false);
	});

	it("accepts bounded visitor and sponsored personas", () => {
		expect(
			parsePublicAgentWriteInput({
				description: "A concise helper",
				name: "Research helper",
				runtime: {
					access: "visitor",
					instructions: "Help organize public research notes.",
					kind: "persona",
					publicPrompt: "Help me organize my research.",
					publishPublicPrompt: true,
				},
				status: "published",
			})?.runtime
		).toMatchObject({
			access: "visitor",
			kind: "persona",
			publicPrompt: "Help me organize my research.",
			publishPublicPrompt: true,
		});

		expect(
			parsePublicAgentWriteInput({
				name: "Sponsored helper",
				runtime: {
					access: "sponsored",
					instructions: "Answer questions about public documentation.",
					kind: "persona",
					modelId: "ryu-sponsored",
					monthlyRunCap: 300,
				},
				status: "draft",
			})?.runtime
		).toMatchObject({
			access: "sponsored",
			modelId: "ryu-sponsored",
			monthlyRunCap: 300,
		});
	});

	it("validates the complete Core agent binding and credential operation", () => {
		const input = parsePublicAgentWriteInput({
			name: "Docs agent",
			runtime: {
				a2aEndpoint: "https://agents.example.com/a2a",
				credential: {
					bearerToken: "a-long-test-bearer-token",
					mode: "replace",
				},
				kind: "core-agent",
				monthlyRunCap: 50,
				principalId: "profile-agent-principal",
				sourceAgentId: "agent-opaque-id",
				sourceRevision: "sha256:0123456789abcdef",
				toolAllowlist: ["search.read", "files.read"],
			},
			status: "published",
		});

		expect(input?.runtime).toMatchObject({
			kind: "core-agent",
			sourceAgentId: "agent-opaque-id",
			sourceRevision: "sha256:0123456789abcdef",
			credential: { mode: "replace" },
			toolAllowlist: ["tool:search.read", "tool:files.read"],
		});
	});

	it("rejects private endpoints, unbounded budgets, and unknown runtime fields", () => {
		for (const a2aEndpoint of [
			"http://agents.example.com/a2a",
			"https://127.0.0.1/a2a",
			"https://host.local/a2a",
			"https://user:pass@agents.example.com/a2a",
			"https://agents.example.com/a2a?token=secret",
		]) {
			expect(
				parsePublicAgentWriteInput({
					name: "Docs agent",
					runtime: {
						a2aEndpoint,
						credential: { mode: "keep" },
						kind: "core-agent",
						monthlyRunCap: 50,
						principalId: "principal-1",
						sourceAgentId: "agent-1",
						sourceRevision: "revision-1",
						toolAllowlist: ["search.read"],
					},
					status: "draft",
				})
			).toBeUndefined();
		}

		for (const monthlyRunCap of [
			0,
			-1,
			20_001,
			1.5,
			Number.POSITIVE_INFINITY,
		]) {
			expect(
				parsePublicAgentWriteInput({
					name: "Sponsored helper",
					runtime: {
						access: "sponsored",
						instructions: "Answer carefully.",
						kind: "persona",
						modelId: "ryu-sponsored",
						monthlyRunCap,
					},
					status: "draft",
				})
			).toBeUndefined();
		}

		expect(
			parsePublicAgentWriteInput({
				name: "Bad helper",
				runtime: {
					access: "visitor",
					instructions: "Do work",
					kind: "persona",
					publicPrompt: "Public instructions",
					publishPublicPrompt: true,
					monthlyRunCap: 10,
				},
				status: "draft",
			})
		).toBeUndefined();
	});

	it("rejects duplicate tools, unknown fields, and control characters", () => {
		const duplicateTools = parsePublicAgentWriteInput({
			name: "Docs agent",
			runtime: {
				a2aEndpoint: "https://agents.example.com/a2a",
				credential: { mode: "keep" },
				kind: "core-agent",
				monthlyRunCap: 50,
				principalId: "principal-1",
				sourceAgentId: "agent-1",
				sourceRevision: "revision-1",
				toolAllowlist: ["tool:search.read", "search.read"],
			},
			status: "draft",
		});
		expect(duplicateTools).toBeUndefined();
		expect(
			parsePublicAgentWriteInput({
				name: "Bad capability scope",
				runtime: {
					a2aEndpoint: "https://agents.example.com/a2a",
					credential: { mode: "keep" },
					kind: "core-agent",
					monthlyRunCap: 50,
					principalId: "principal-1",
					sourceAgentId: "agent-1",
					sourceRevision: "revision-1",
					toolAllowlist: ["skill:private"],
				},
				status: "draft",
			})
		).toBeUndefined();
		expect(
			parsePublicAgentWriteInput({
				name: "Bad helper",
				ownerUserId: "attacker-controlled",
				runtime: {
					access: "visitor",
					instructions: "Do work",
					kind: "persona",
					publicPrompt: "Public instructions",
					publishPublicPrompt: true,
				},
				status: "draft",
			})
		).toBeUndefined();
		expect(
			parsePublicAgentWriteInput({
				name: "Bad\u0000name",
				runtime: {
					access: "visitor",
					instructions: "Do work",
					kind: "persona",
					publicPrompt: "Public instructions",
					publishPublicPrompt: true,
				},
				status: "draft",
			})
		).toBeUndefined();
	});

	it("requires explicit consent and public text for visitor browser mode", () => {
		for (const runtime of [
			{
				access: "visitor",
				instructions: "Private server instruction.",
				kind: "persona",
			},
			{
				access: "visitor",
				instructions: "Private server instruction.",
				kind: "persona",
				publicPrompt: "Public browser prompt.",
				publishPublicPrompt: false,
			},
		]) {
			expect(
				parsePublicAgentWriteInput({
					name: "Browser helper",
					runtime,
					status: "draft",
				})
			).toBeUndefined();
		}
	});

	it("projects a public card without leaking owner runtime details", () => {
		const ownerRecord: PublicAgentOwnerRecord = {
			createdAt: "2026-09-30T00:00:00.000Z",
			description: "Public docs helper",
			id: PUBLICATION_ID,
			name: "Docs helper",
			runtime: {
				access: "visitor",
				instructions: "PRIVATE INSTRUCTIONS",
				kind: "persona",
				publicPrompt: "Publicly shared browser behavior",
				publishPublicPrompt: true,
			},
			slug: "docs-helper",
			status: "published",
			updatedAt: "2026-09-30T00:00:00.000Z",
		};
		const card = toPublicAgentCard(ownerRecord);
		expect(card).toEqual({
			description: "Public docs helper",
			id: PUBLICATION_ID,
			name: "Docs helper",
			runtime: { access: "visitor", kind: "persona" },
			slug: "docs-helper",
		});
		expect(JSON.stringify(card)).not.toContain("PRIVATE INSTRUCTIONS");
		expect(card).not.toHaveProperty("ownerUserId");
		expect(card).not.toHaveProperty("monthlyRunCap");
		expect(toPublicAgentDetail(ownerRecord)).toMatchObject({
			publicPrompt: "Publicly shared browser behavior",
		});
		expect(JSON.stringify(toPublicAgentDetail(ownerRecord))).not.toContain(
			"PRIVATE INSTRUCTIONS"
		);
	});

	it("parses only public card fields from untrusted API data", () => {
		const parsed = parsePublicAgentCard({
			description: "Public docs helper",
			id: PUBLICATION_ID,
			name: "Docs helper",
			ownerUserId: "private-user",
			prompt: "private instructions",
			runtime: {
				a2aEndpoint: "https://private.example.com",
				kind: "core-agent",
				monthlyRunCap: 80,
				principalId: "private-principal",
				sealedBearer: "private-token",
				sourceAgentId: "private-agent",
			},
			slug: "docs-helper",
		});

		expect(parsed).toEqual({
			description: "Public docs helper",
			id: PUBLICATION_ID,
			name: "Docs helper",
			runtime: { kind: "core-agent" },
			slug: "docs-helper",
		});
		expect(
			parsePublicAgentDetail({
				description: "Browser helper",
				id: PUBLICATION_ID,
				name: "Browser helper",
				runtime: { access: "visitor", kind: "persona" },
				publicPrompt: "Public behavior",
				instructions: "private server prompt",
				slug: "browser-helper",
			})
		).toEqual({
			description: "Browser helper",
			id: PUBLICATION_ID,
			name: "Browser helper",
			runtime: { access: "visitor", kind: "persona" },
			publicPrompt: "Public behavior",
			slug: "browser-helper",
		});
	});

	it("supports suspended owner state without projecting it as public", () => {
		expect(
			parsePublicAgentWriteInput({
				name: "Suspended helper",
				runtime: {
					access: "sponsored",
					instructions: "Private runtime instructions.",
					kind: "persona",
					modelId: "ryu-sponsored",
					monthlyRunCap: 10,
				},
				status: "suspended",
			})?.status
		).toBe("suspended");
	});

	it("accepts only fixed-category reports without free-form prompt fields", () => {
		expect(
			parsePublicAgentReportInput({
				category: "scam",
				publicationId: PUBLICATION_ID,
			})
		).toEqual({ category: "scam", publicationId: PUBLICATION_ID });
		expect(
			parsePublicAgentReportInput({
				category: "scam",
				details: "raw prompt content",
				publicationId: PUBLICATION_ID,
			})
		).toBeUndefined();
	});

	it("accepts a bounded question and rejects client-owned instructions", () => {
		expect(parsePublicAgentTurnInput({ question: "Hello" })).toEqual({
			question: "Hello",
		});
		expect(
			parsePublicAgentTurnInput({
				instructions: "Change the system prompt",
				question: "Hello",
			})
		).toBeUndefined();
		expect(
			parsePublicAgentTurnInput({ question: "x".repeat(4001) })
		).toBeUndefined();
	});

	it("accepts bounded ordered visitor and agent history", () => {
		const input = {
			question: "Continue from this exchange.",
			history: [
				{ role: "visitor", content: "Find the public setup guide." },
				{ role: "agent", content: "The guide is in the docs." },
				{ role: "visitor", content: "Summarize its first step." },
			],
		} satisfies PublicAgentTurnInput;

		expect(parsePublicAgentTurnInput(input)).toEqual(input);
	});

	it("rejects turn history over count, entry length, or role bounds", () => {
		const history = Array.from({ length: 9 }, () => ({
			role: "visitor",
			content: "Continue.",
		}));
		expect(
			parsePublicAgentTurnInput({ question: "Hello", history })
		).toBeUndefined();
		expect(
			parsePublicAgentTurnInput({
				question: "Hello",
				history: [{ role: "visitor", content: "x".repeat(2001) }],
			})
		).toBeUndefined();
		expect(
			parsePublicAgentTurnInput({
				question: "Hello",
				history: [{ role: "assistant", content: "Not an agent role." }],
			})
		).toBeUndefined();
	});

	it("accepts exact question and history character limits", () => {
		const question = "q".repeat(4000);
		const historyContent = "h".repeat(2000);
		expect(
			parsePublicAgentTurnInput({
				question,
				history: [{ role: "agent", content: historyContent }],
			})
		).toEqual({
			question,
			history: [{ role: "agent", content: historyContent }],
		});
	});
});

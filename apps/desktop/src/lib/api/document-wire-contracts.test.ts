import { describe, expect, it, spyOn } from "bun:test";
import {
	documentCapabilityWireSchema,
	documentJobWireSchema,
} from "./document-wire-contracts.ts";
import {
	fetchParseCapability,
	fetchParseJob,
	submitParse,
} from "./documents.ts";

const target = { url: "http://document-fixture.invalid", token: "node-token" };

describe("Core document extraction boundaries", () => {
	it("retains full raw projections and additive metadata before normalization", () => {
		const metadata = JSON.parse('{"__proto__":{"future":true}}');
		const capability = {
			available: false,
			builtin_extensions: ["txt"],
			extensions: ["txt", "pdf"],
			max_input_bytes: 32,
			missing_dependencies: ["tesseract"],
			provider: "@ryu/parser",
			provider_name: "Parser",
			metadata,
		};
		const job = {
			job_id: "job-one",
			status: "future-paused",
			markdown: null,
			error: null,
			truncated: false,
			missing_dependencies: [],
			filename: "input.pdf",
			metadata,
		};
		expect(documentCapabilityWireSchema.parse(capability)).toBe(capability);
		expect(documentJobWireSchema.parse(job)).toBe(job);
		expect(
			documentCapabilityWireSchema.safeParse({
				...capability,
				missing_dependencies: [3],
			}).success
		).toBe(false);
		expect(
			documentJobWireSchema.safeParse({ ...job, truncated: "false" }).success
		).toBe(false);
	});
	it("keeps legacy sparse capability defaults and complete provider details", async () => {
		const fetch = spyOn(globalThis, "fetch");
		try {
			fetch.mockResolvedValueOnce(Response.json({}));
			expect(await fetchParseCapability(target)).toEqual({
				available: true,
				builtinExtensions: [],
				extensions: [],
				maxInputBytes: 0,
				missingDependencies: [],
				provider: null,
				providerName: null,
			});
			fetch.mockResolvedValueOnce(
				Response.json({
					available: false,
					builtin_extensions: ["txt"],
					extensions: ["txt", "pdf"],
					max_input_bytes: 32,
					missing_dependencies: ["tesseract"],
					provider: "@ryu/parser",
					provider_name: "Parser",
				})
			);
			expect(await fetchParseCapability(target)).toEqual({
				available: false,
				builtinExtensions: ["txt"],
				extensions: ["txt", "pdf"],
				maxInputBytes: 32,
				missingDependencies: ["tesseract"],
				provider: "@ryu/parser",
				providerName: "Parser",
			});
		} finally {
			fetch.mockRestore();
		}
	});
	it("preserves future job states and null omission at submit and poll", async () => {
		const fetch = spyOn(globalThis, "fetch");
		try {
			fetch.mockResolvedValueOnce(
				Response.json({
					job_id: "job-one",
					status: "future-paused",
					markdown: null,
					error: null,
					truncated: false,
					missing_dependencies: [],
				})
			);
			expect(await fetchParseJob(target, "job-one")).toEqual({
				jobId: "job-one",
				status: "future-paused",
				markdown: undefined,
				error: undefined,
				truncated: false,
				missingDependencies: [],
			});
			fetch.mockResolvedValueOnce(
				Response.json({
					status: "succeeded",
					markdown: "# extracted",
					via: "builtin",
					truncated: true,
				})
			);
			expect(
				await submitParse(
					target,
					new File(["# source"], "input.md", { type: "text/markdown" })
				)
			).toEqual({
				jobId: undefined,
				status: "succeeded",
				markdown: "# extracted",
				error: undefined,
				truncated: true,
				missingDependencies: [],
			});
			fetch.mockResolvedValueOnce(
				Response.json({ error: "parser unavailable" }, { status: 503 })
			);
			await expect(fetchParseJob(target, "job-one")).rejects.toThrow(
				"parser unavailable"
			);
		} finally {
			fetch.mockRestore();
		}
	});
});

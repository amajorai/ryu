import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { ModelDetail } from "@/src/lib/api/models.ts";
import { modelBody } from "./DeepLinkConfirmDialog-bodies.ts";

const tl: LiteralMessage = (source) => `[${source}]`;

describe("modelBody", () => {
	test("the install confirm button is a catalogued label", () => {
		const detail = {
			card: { installed: false, name: "Qwen" },
			device: null,
			files: [
				{
					filename: "qwen-q4_k_m.gguf",
					fit: "fits",
					fitLabel: "",
					installed: false,
					quant: "Q4_K_M",
					sha256: null,
					sizeBytes: 1,
					sizeHuman: "1 GB",
					url: "https://example.test/qwen.gguf",
				},
			],
		} as unknown as ModelDetail;
		const body = modelBody(
			{ id: "qwen" },
			{ data: detail, error: null, isLoading: false },
			() => undefined,
			tl
		);
		expect(body.confirm).toBe("[Install & use]");
	});
});

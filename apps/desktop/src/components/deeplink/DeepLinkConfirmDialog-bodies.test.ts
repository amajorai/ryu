import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { ModelDetail } from "@/src/lib/api/models.ts";
import { modelBody, nodeBody } from "./DeepLinkConfirmDialog-bodies.ts";

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

describe("nodeBody", () => {
	const describeWith: LiteralMessage = (source, values) =>
		`${source} ${JSON.stringify(values ?? {})}`;
	const run = () => undefined;

	test("names the parsed host with its port, never the raw address", () => {
		const body = nodeBody(
			{
				name: "prod",
				token: "t",
				url: "https://node.example.com:7980/base",
			},
			false,
			run,
			describeWith
		);
		expect(body?.description).toContain('"host":"node.example.com:7980"');
		expect(body?.description).not.toContain("/base");
		expect(body?.confirm).toBe("Connect");
	});

	test("shows punycode as punycode", () => {
		const body = nodeBody(
			{ name: "prod", token: null, url: "https://xn--pple-43d.com" },
			true,
			run,
			describeWith
		);
		expect(body?.description).toContain('"host":"xn--pple-43d.com"');
		expect(body?.confirm).toBe("Switch");
	});

	test("gives no dialog for an address that hides its host", () => {
		for (const url of [
			"https://trusted@evil.example",
			"https://trusted.example.com:443@evil.example",
			"https://\u0430pple.com",
			"ftp://node.example.com",
			"node.example.com",
		]) {
			expect(
				nodeBody({ name: "prod", token: "t", url }, false, run, describeWith)
			).toBeNull();
		}
	});
});

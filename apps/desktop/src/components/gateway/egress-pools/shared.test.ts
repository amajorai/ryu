import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import { type Endpoint, validatePool } from "./shared.ts";

const tl: LiteralMessage = (source, values) =>
	`[${source}]${values ? JSON.stringify(values) : ""}`;

function endpoint(overrides: Partial<Endpoint> = {}): Endpoint {
	return {
		enabled: true,
		id: "proxy-a",
		password_env: null,
		priority: 0,
		url: "http://proxy.example:8080",
		username_env: null,
		...overrides,
	};
}

const NONE = new Set<string>();

describe("validatePool", () => {
	test("every pool-level problem is a catalogued sentence", () => {
		expect(
			validatePool(
				"main",
				{ direct_fallback_only: true, endpoints: [], include_direct: false },
				NONE,
				tl
			)
		).toBe("[Include a direct connection before enabling direct fallback.]");
		expect(
			validatePool("main", { endpoints: [], include_direct: false }, NONE, tl)
		).toBe("[Enable a proxy endpoint or include a direct connection.]");
		const many = Array.from({ length: 33 }, (_, index) =>
			endpoint({ id: `p${index}` })
		);
		expect(
			validatePool("main", { endpoints: many, include_direct: false }, NONE, tl)
		).toBe("[A pool supports at most 32 connections.]");
	});

	test("endpoint problems are catalogued sentences", () => {
		expect(
			validatePool(
				"main",
				{ endpoints: [endpoint({ priority: -1 })], include_direct: false },
				NONE,
				tl
			)
		).toBe("[Priority must be an integer from 0 to 65535.]");
		expect(
			validatePool(
				"main",
				{ endpoints: [endpoint(), endpoint()], include_direct: false },
				NONE,
				tl
			)
		).toBe(
			"[Proxy endpoint IDs must be unique and use letters, numbers, hyphens, or underscores.]"
		);
	});
});

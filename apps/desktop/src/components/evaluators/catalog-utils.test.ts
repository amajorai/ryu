import { describe, expect, test } from "bun:test";
import type { Evaluator } from "@/src/lib/api/gateway.ts";
import {
	splitOfflineSelection,
	toCatalogItem,
	toOfflineCatalogItem,
} from "./catalog-utils.ts";

function codeDefinition(source: string): Evaluator {
	return {
		id: "local_code",
		name: "Local code",
		description: "Core sandbox evaluator",
		category: "custom",
		target: "output",
		capabilities: { inline: false, offline: false },
		impl: { kind: "code", lang: "js", source },
		inline: null,
		offline: null,
		builtin: false,
		enforced: false,
		higherIsBetter: true,
	};
}

describe("Core and Gateway evaluator availability", () => {
	test("preserves Core offline execution without advertising Gateway guardrails", () => {
		const definition = codeDefinition(
			"function evaluate() { return {score: 1, pass: true}; }"
		);
		expect(toCatalogItem(definition).capInline).toBe(false);
		expect(toCatalogItem(definition).capOffline).toBe(false);
		expect(toOfflineCatalogItem(definition).capOffline).toBe(true);
		expect(splitOfflineSelection([definition.id], [definition])).toEqual({
			evaluators: [],
			codeEvaluators: [
				{
					id: definition.id,
					lang: "js",
					source: definition.impl.kind === "code" ? definition.impl.source : "",
				},
			],
		});
	});

	test("does not offer empty code templates or media definitions as executable", () => {
		expect(toOfflineCatalogItem(codeDefinition("   ")).capOffline).toBe(false);
		const definition = codeDefinition("return 1");
		definition.target = "image";
		expect(toOfflineCatalogItem(definition).capOffline).toBe(false);
		definition.target = "audio";
		expect(toOfflineCatalogItem(definition).capOffline).toBe(false);
	});
});

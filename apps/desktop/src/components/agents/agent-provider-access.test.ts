import { describe, expect, test } from "bun:test";
import { BYOK_MODEL_PROVIDERS as SHARED_BYOK_MODEL_PROVIDERS } from "@ryuhq/core-client/agent-account-access";
import { BYOK_MODEL_PROVIDERS } from "./agent-provider-access.ts";

describe("agent provider access", () => {
	test("desktop's BYOK rows match the shared core-client list", () => {
		const desktop = BYOK_MODEL_PROVIDERS.map(
			({ slug, label }): { label: string; slug: string } => ({ label, slug })
		);
		const shared = SHARED_BYOK_MODEL_PROVIDERS.map(({ slug, label }) => ({
			label,
			slug,
		}));
		expect(desktop).toEqual(shared);
	});
});

// The launch-check note spliced Core's refusal into a translated sentence as
// raw English; a catalogued reason now reads in the CLI locale too.
import { describe, expect, mock, test } from "bun:test";
import { ApiError } from "@ryuhq/core-client/client";
import { createCliTranslator } from "../i18n/translate.ts";
import type { CliContext } from "./types.ts";

const NOTE =
	"Note: could not ask Core whether the engine will start ({detail}). Saving anyway; Core still checks when the agent starts.";
const german = createCliTranslator("de", {
	[NOTE]: "Hinweis: Core konnte nicht gefragt werden ({detail}).",
	"Core is busy": "Core ist ausgelastet",
});
mock.module("../i18n/translate.ts", () => ({
	CLI_FORMAT_LOCALE: "de",
	CLI_LOCALE: "de",
	CLI_TRANSLATOR: german,
	createCliTranslator,
	tf: german.tf,
	tr: german.tr,
	trMessage: german.trMessage,
	translateProps: german.translateProps,
}));
const { launchRefusal } = await import("./agents-core.ts");

describe("agent launch check under German", () => {
	test("Core's catalogued refusal reads in German inside the note", async () => {
		let err = "";
		const ctx = {
			api: {
				call: (_target: unknown, path: string) =>
					Promise.reject(new ApiError(path, 503, "Core is busy")),
			},
			io: {
				err: (text: string) => {
					err += text;
				},
				out: () => undefined,
			},
			target: { url: "http://node.test", token: "t" },
		} as unknown as CliContext;
		const refusal = await launchRefusal(ctx, {
			accountAccess: null,
			agentId: "a1",
			engine: "codex",
			identityMode: "own",
		} as unknown as Parameters<typeof launchRefusal>[1]);
		expect(refusal).toBeNull();
		expect(err).toBe(
			"Hinweis: Core konnte nicht gefragt werden (Core ist ausgelastet).\n"
		);
	});
});

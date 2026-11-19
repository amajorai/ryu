import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { GatewayProvidersConfig } from "@/src/lib/api/gateway.ts";
import { cloudSpeechSummaryRows } from "./GatewaySpeechSettings-cloud-account-rows.ts";

const tl: LiteralMessage = (source, values) =>
	`[${source}]${values ? JSON.stringify(values) : ""}`;

describe("cloudSpeechSummaryRows", () => {
	test("each provider's context line is a catalogued sentence", () => {
		const providers = {
			google_tts: { account_count: 2, mode: "supplied" },
			polly: { account_count: 1, mode: "explicit", region: "eu-west-1" },
		} as unknown as GatewayProvidersConfig;
		const rows = cloudSpeechSummaryRows(
			{ providers, region: "us-east-1", view: null },
			tl
		);
		expect(rows.map((row) => [row.id, row.count, row.context])).toEqual([
			["google-tts", 2, "[Supplied OAuth tokens and quota project]"],
			[
				"polly",
				1,
				'[Explicit AWS credentials · {region}]{"region":"eu-west-1"}',
			],
		]);
	});

	test("an unconfigured provider has no row", () => {
		expect(
			cloudSpeechSummaryRows({ providers: null, region: "x", view: null }, tl)
		).toEqual([]);
	});
});

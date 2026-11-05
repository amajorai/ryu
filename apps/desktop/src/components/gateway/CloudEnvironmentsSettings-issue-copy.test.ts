import { describe, expect, test } from "bun:test";
import { formatMessage, type LiteralMessage } from "@ryu/i18n";
import {
	CLOUD_ENVIRONMENT_ISSUE_CODES,
	type CloudEnvironmentIssue,
	type CloudEnvironmentIssueCode,
	cloudEnvironmentIssue,
} from "@ryuhq/protocol/cloud-environments-issue";
import { cloudEnvironmentIssueMessage } from "./CloudEnvironmentsSettings-issue-copy.ts";

const english: LiteralMessage = (source, values) =>
	formatMessage(source, values);

const SAMPLES: Record<CloudEnvironmentIssueCode, CloudEnvironmentIssue> = {
	unsupported_backend: { code: "unsupported_backend" },
	unsupported_agent: { code: "unsupported_agent" },
	lifetime_out_of_range: {
		code: "lifetime_out_of_range",
		values: { min: 5, max: 240 },
	},
	managed_agent_requires_box: { code: "managed_agent_requires_box" },
	managed_agent_requires_internet: { code: "managed_agent_requires_internet" },
	box_rejects_tailscale: { code: "box_rejects_tailscale" },
	box_rejects_network_secret: {
		code: "box_rejects_network_secret",
		values: { key: "OPENAI_API_KEY" },
	},
	box_reserved_names: {
		code: "box_reserved_names",
		values: { names: ["USER", "DOCKER_HOST"] },
	},
	box_too_many_variables: {
		code: "box_too_many_variables",
		values: { max: 64 },
	},
};

describe("cloudEnvironmentIssueMessage", () => {
	test("every protocol code maps to one distinct whole sentence", () => {
		const sources = new Set<string>();
		for (const code of CLOUD_ENVIRONMENT_ISSUE_CODES) {
			const seen: string[] = [];
			const recording: LiteralMessage = (source, values) => {
				seen.push(source);
				return formatMessage(source, values);
			};
			const text = cloudEnvironmentIssueMessage(recording, SAMPLES[code]);
			// One catalog lookup per issue: the sentence is never assembled from pieces.
			expect(seen).toHaveLength(1);
			expect(text.endsWith(".")).toBe(true);
			sources.add(seen[0] ?? "");
		}
		expect(sources.size).toBe(CLOUD_ENVIRONMENT_ISSUE_CODES.length);
	});

	test("English output matches the protocol's legacy wording", () => {
		expect(
			cloudEnvironmentIssueMessage(english, SAMPLES.lifetime_out_of_range)
		).toBe("Session length must be a whole number of minutes from 5 to 240.");
		expect(
			cloudEnvironmentIssueMessage(english, SAMPLES.box_reserved_names, "en")
		).toBe(
			"Fresh cloud boxes reserve these variable names: USER and DOCKER_HOST. Rename them."
		);
		expect(
			cloudEnvironmentIssueMessage(english, SAMPLES.box_rejects_network_secret)
		).toBe(
			"Fresh cloud boxes do not support network secrets. Unselect OPENAI_API_KEY."
		);
	});

	test("translated sentences receive locale-joined names", () => {
		const japanese: LiteralMessage = (source, values) =>
			source.startsWith("Fresh cloud boxes reserve")
				? formatMessage(
						"Fresh cloud box では次の変数名が予約されています: {names}。名前を変更してください。",
						values
					)
				: formatMessage(source, values);
		const text = cloudEnvironmentIssueMessage(
			japanese,
			SAMPLES.box_reserved_names,
			"ja"
		);
		expect(text).toContain("USER、DOCKER_HOST");
		expect(text).not.toContain("Rename");
	});

	test("renders the issue the protocol actually reports", () => {
		const issue = cloudEnvironmentIssue({
			internet: { enabled: false, domainPolicy: "all", allowedDomains: [] },
			tailscaleVaultKey: null,
			vaultKeys: [],
			runtime: { backend: "box", executor: "codex", lifetimeMinutes: 30 },
		});
		expect(issue).not.toBeNull();
		if (issue) {
			expect(cloudEnvironmentIssueMessage(english, issue)).toBe(
				"Managed agents require internet access."
			);
		}
	});
});

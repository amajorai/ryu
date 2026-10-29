// packages/core-client/src/troubleshoot.test.ts
//
// The shared troubleshooter model: redaction must strip credentials, emails,
// home paths and public IPs (and be idempotent); similar-issue search must
// degrade instead of throwing; the prefilled issue URL must target the bug
// template's real field ids and stay under the URL budget.

import { describe, expect, test } from "bun:test";
import {
	buildIssueTitle,
	buildIssueUrl,
	descriptionKeywords,
	ISSUE_REPOSITORY,
	problemChecks,
	redactDiagnosticText,
	renderTroubleshootMarkdown,
	reportUnit,
	searchSimilarIssues,
	similarIssueQueries,
	type TroubleshootReport,
	troubleshootCounts,
} from "./troubleshoot.ts";

function report(
	overrides: Partial<TroubleshootReport> = {}
): TroubleshootReport {
	return {
		checks: [
			{ id: "cli.version", status: "pass", title: "CLI", detail: "ryu 0.4.0" },
			{
				id: "core.reachable",
				status: "fail",
				title: "Core reachable",
				detail: "Nothing is listening on 127.0.0.1:7980.",
				fix: "Start Core with `ryu-core`.",
				searchTerms: "core not running",
				unit: "apps/core",
			},
			{
				id: "disk.free",
				status: "warn",
				title: "Free disk space",
				detail: "3.1 GB free",
				unit: "apps/cli",
			},
		],
		description: "",
		generatedAt: "2026-10-19T10:00:00.000Z",
		logExcerpt: ["ERROR boot failed"],
		machine: [
			["OS", "linux 6.8 x64"],
			["Memory", "16 GB"],
		],
		similarIssues: [],
		surface: "cli",
		version: "0.4.0",
		...overrides,
	};
}

describe("redactDiagnosticText", () => {
	test("strips tokens, keys, credentials and emails", () => {
		const input = [
			"Authorization: Bearer abcdefghijklmnop",
			"token=ghp_abcdefghijklmnopqrstuvwxyz0123",
			'{"api_key": "sk-proj-abcdefghijklmnopqrstu"}',
			"postgres://admin:hunter2@db.example.com/ryu",
			"https://x.test/cb?code=abc123&state=1",
			"contact me at jane.doe@example.com",
			"jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl",
		].join("\n");
		const out = redactDiagnosticText(input);
		for (const secret of [
			"abcdefghijklmnop",
			"ghp_",
			"sk-proj",
			"hunter2",
			"abc123",
			"jane.doe",
			"eyJhbGci",
		]) {
			expect(out).not.toContain(secret);
		}
		expect(out).toContain("[REDACTED");
	});

	test("rewrites home directories on every OS", () => {
		expect(redactDiagnosticText("/Users/jane/.ryu/logs")).toBe("~/.ryu/logs");
		expect(redactDiagnosticText("/home/jane/.ryu")).toBe("~/.ryu");
		expect(redactDiagnosticText("C:\\Users\\jane\\.ryu")).toBe("~\\.ryu");
		expect(
			redactDiagnosticText("/srv/people/jane/.ryu", {
				homeDir: "/srv/people/jane",
			})
		).toBe("~/.ryu");
	});

	test("keeps loopback and private addresses, hides public ones", () => {
		const out = redactDiagnosticText(
			"bind 127.0.0.1:7980 lan 192.168.1.4 peer 8.8.8.8 bad 999.1.1.1"
		);
		expect(out).toContain("127.0.0.1:7980");
		expect(out).toContain("192.168.1.4");
		expect(out).not.toContain("8.8.8.8");
		expect(out).toContain("999.1.1.1");
	});

	test("redacts prefixed environment secrets and Token authorization", () => {
		const out = redactDiagnosticText(
			"RYU_CORE_TOKEN=abcd1234efgh5678 OPENAI_API_KEY=abc123xyz789\nexport GITHUB_TOKEN=foo123456789\nAuthorization: Token abcdef0123456789"
		);
		for (const secret of [
			"abcd1234efgh5678",
			"abc123xyz789",
			"foo123456789",
			"abcdef0123456789",
		]) {
			expect(out).not.toContain(secret);
		}
		expect(out).toContain("RYU_CORE_TOKEN=[REDACTED]");
		expect(redactDiagnosticText(out)).toBe(out);
		expect(redactDiagnosticText("token validation failed")).toBe(
			"token validation failed"
		);
	});

	test("is idempotent and leaves ordinary words alone", () => {
		const once = redactDiagnosticText("password=hunter2 max_tokens=200");
		expect(redactDiagnosticText(once)).toBe(once);
		expect(once).toContain("max_tokens=200");
	});
});

describe("summaries", () => {
	test("counts and orders problems failures-first", () => {
		const r = report();
		expect(troubleshootCounts(r.checks)).toEqual({
			fail: 1,
			info: 0,
			pass: 1,
			skip: 0,
			warn: 1,
		});
		expect(problemChecks(r.checks).map((c) => c.id)).toEqual([
			"core.reachable",
			"disk.free",
		]);
		expect(reportUnit(r, "apps/cli")).toBe("apps/core");
		expect(reportUnit(report({ checks: [] }), "apps/cli")).toBe("apps/cli");
	});
});

describe("similar issues", () => {
	test("queries the user's words first, then the headline check", () => {
		expect(
			descriptionKeywords("Core keeps crashing when I open the app")
		).toEqual(["core", "crashing", "open", "app"]);
		expect(
			similarIssueQueries(report({ description: "Gateway crashes on startup" }))
		).toEqual(["gateway crashes startup", "core not running"]);
		expect(similarIssueQueries(report())).toEqual(["core not running"]);
	});

	test("never puts a secret from the description into the search", () => {
		const queries = similarIssueQueries(
			report({ description: "token=ghp_abcdefghijklmnopqrstuvwxyz0123 fails" })
		);
		expect(queries.join(" ")).not.toContain("ghp_");
	});

	test("dedupes, drops pull requests and scopes to the tracker", async () => {
		const urls: string[] = [];
		const fakeFetch = (async (url: string) => {
			urls.push(url);
			return Response.json({
				items: [
					{
						html_url: "https://github.com/amajorai/ryu/issues/12",
						number: 12,
						state: "closed",
						title: "Core does not start",
						updated_at: "2026-10-01T00:00:00Z",
					},
					{
						html_url: "https://github.com/amajorai/ryu/pull/13",
						number: 13,
						pull_request: {},
						state: "open",
						title: "fix",
						updated_at: "2026-10-01T00:00:00Z",
					},
				],
			});
		}) as typeof fetch;
		const result = await searchSimilarIssues(["a", "b"], { fetch: fakeFetch });
		expect(result.error).toBeNull();
		expect(result.issues).toEqual([
			{
				number: 12,
				state: "closed",
				title: "Core does not start",
				updatedAt: "2026-10-01T00:00:00Z",
				url: "https://github.com/amajorai/ryu/issues/12",
			},
		]);
		expect(decodeURIComponent(urls[0] ?? "")).toContain(
			`repo:${ISSUE_REPOSITORY} is:issue a`
		);
	});

	test("degrades to an error instead of throwing", async () => {
		const offline = (async () => {
			throw new Error("getaddrinfo ENOTFOUND");
		}) as unknown as typeof fetch;
		const down = await searchSimilarIssues(["x"], { fetch: offline });
		expect(down.issues).toEqual([]);
		expect(down.error).toContain("ENOTFOUND");

		const limited = (async () =>
			new Response("{}", { status: 403 })) as unknown as typeof fetch;
		expect(
			(await searchSimilarIssues(["x"], { fetch: limited })).error
		).toContain("rate limit");
	});
});

describe("issue url", () => {
	test("prefills the bug template's field ids", () => {
		const url = new URL(
			buildIssueUrl(report({ description: "Core will not start" }), {
				fallbackUnit: "apps/cli",
			})
		);
		expect(url.origin + url.pathname).toBe(
			`https://github.com/${ISSUE_REPOSITORY}/issues/new`
		);
		const params = url.searchParams;
		expect(params.get("template")).toBe("bug_report.yml");
		expect(params.get("title")).toBe("Core will not start");
		expect(params.get("unit")).toBe("apps/core");
		expect(params.get("what-happened")).toContain("Core reachable");
		expect(params.get("what-happened")).toContain("Fix: Start Core");
		expect(params.get("env")).toContain("OS: linux 6.8 x64");
		expect(params.get("logs")).toBe("ERROR boot failed");
		expect(params.get("repro")).toContain("1.");
	});

	test("titles from the headline problem when there is no description", () => {
		expect(buildIssueTitle(report())).toBe(
			"Core reachable: Nothing is listening on 127.0.0.1:7980."
		);
	});

	test("redacts every field, even ones a caller forgot", () => {
		const url = buildIssueUrl(
			report({
				description: "fails with password=hunter2",
				logExcerpt: ["auth Bearer abcdefghijklmnopqrstuvwxyz"],
				machine: [["Data dir", "/home/jane/.ryu"]],
			}),
			{ fallbackUnit: "apps/cli" }
		);
		const decoded = decodeURIComponent(url);
		expect(decoded).not.toContain("hunter2");
		expect(decoded).not.toContain("abcdefghijklmnopqrstuvwxyz");
		expect(decoded).not.toContain("jane");
	});

	test("stays under the URL budget by trimming logs, then the description", () => {
		const longLogs = Array.from(
			{ length: 20 },
			(_, i) => `ERROR ${i} ${"x".repeat(400)}`
		);
		const withLogs = buildIssueUrl(report({ logExcerpt: longLogs }), {
			fallbackUnit: "apps/cli",
		});
		expect(withLogs.length).toBeLessThanOrEqual(7500);
		const kept = new URL(withLogs).searchParams.get("logs") ?? "";
		expect(kept).toContain("ERROR 19");

		const huge = buildIssueUrl(report({ description: "y".repeat(20_000) }), {
			fallbackUnit: "apps/cli",
		});
		expect(huge.length).toBeLessThanOrEqual(7500);
		expect(new URL(huge).searchParams.get("what-happened")).toContain(
			"Truncated"
		);
	});
});

test("markdown report keeps every check and the issue link", () => {
	const md = renderTroubleshootMarkdown(
		report({
			similarIssues: [
				{
					number: 7,
					state: "open",
					title: "Core port in use",
					updatedAt: "2026-10-01T00:00:00Z",
					url: "https://github.com/amajorai/ryu/issues/7",
				},
			],
		}),
		{ issueUrl: "https://github.com/amajorai/ryu/issues/new?x=1" }
	);
	expect(md).toContain("✓ **CLI**");
	expect(md).toContain("✗ **Core reachable**");
	expect(md).toContain("[#7](https://github.com/amajorai/ryu/issues/7) (open)");
	expect(md).toContain("ERROR boot failed");
	expect(md).toContain("issues/new?x=1");
});

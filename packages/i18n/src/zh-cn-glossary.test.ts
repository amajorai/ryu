import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Simplified Chinese glossary: an AI agent is 智能体, never 代理. 代理 stays
// only for a proxy, the credential broker, or a user agent, so a sentence that
// names both an agent and the broker still needs 智能体. Ryu credits are
// 额度; 积分 is reserved for Ryu Points (and the "Turn points into provider
// credits" exchange), and 点数 is not used for either.

const AGENT_SOURCE = /(?:\b|sub)agents?\b/i;
const USER_AGENT = /user.agents?/gi;
const CREDIT_SOURCE = /\bcredits?\b/i;
const POINTS_SENSE = /\bpoints?\b|\bjackpot\b/i;
// 百分点数 (percentage points) and 点数据 (node data) are not credit terms.
const OFF_TERM_CREDIT = /(?<!百分)点数(?!据)|积分/;

const agentTermViolation = (source: string, value: string): boolean =>
	AGENT_SOURCE.test(source.replace(USER_AGENT, "")) &&
	value.includes("代理") &&
	!value.includes("智能体");

const creditTermViolation = (source: string, value: string): boolean =>
	CREDIT_SOURCE.test(source) &&
	!POINTS_SENSE.test(source) &&
	OFF_TERM_CREDIT.test(value);

const glossaryViolations = (catalog: Record<string, unknown>): string[] => {
	const violations: string[] = [];
	for (const [source, value] of Object.entries(catalog)) {
		if (typeof value !== "string") {
			continue;
		}
		if (agentTermViolation(source, value)) {
			violations.push(`agent: ${source} -> ${value}`);
		}
		if (creditTermViolation(source, value)) {
			violations.push(`credit: ${source} -> ${value}`);
		}
	}
	return violations;
};

const LOCALES_DIR = new URL("../locales/", import.meta.url);

const readCatalog = async (path: string) =>
	(await Bun.file(new URL(path, LOCALES_DIR)).json()) as Record<
		string,
		unknown
	>;

describe("zh-CN glossary rules", () => {
	test("an agent string translated with 代理 alone is flagged", () => {
		expect(
			glossaryViolations({
				"Create new agent": "新建代理",
				"Open subagent: {question}": "打开子代理：{question}",
			})
		).toEqual([
			"agent: Create new agent -> 新建代理",
			"agent: Open subagent: {question} -> 打开子代理：{question}",
		]);
	});

	test("proxy, broker and user-agent strings keep 代理", () => {
		expect(
			glossaryViolations({
				"Add proxy": "添加代理",
				"Broker proposal": "代理服务提议",
				"Create new agent": "新建智能体",
				"Requests agents sent through the broker.":
					"智能体通过凭据代理发送的请求。",
				"User agent": "用户代理",
			})
		).toEqual([]);
	});

	test("an agent named beside the broker still needs 智能体", () => {
		expect(
			glossaryViolations({
				"Requests agents sent through the broker.":
					"代理通过凭据代理发送的请求。",
			})
		).toEqual([
			"agent: Requests agents sent through the broker. -> 代理通过凭据代理发送的请求。",
		]);
	});

	test("Ryu credits translated with 点数 or 积分 are flagged", () => {
		expect(
			glossaryViolations({
				"Earn Ryu credits when a friend you invite starts paying.":
					"你邀请的好友开始付费后，你将获得 Ryu 积分。",
				"This task does not use Ryu credits.": "此任务不消耗 Ryu 点数。",
			})
		).toEqual([
			"credit: Earn Ryu credits when a friend you invite starts paying. -> 你邀请的好友开始付费后，你将获得 Ryu 积分。",
			"credit: This task does not use Ryu credits. -> 此任务不消耗 Ryu 点数。",
		]);
	});

	test("points keep 积分 and credits read as 额度", () => {
		expect(
			glossaryViolations({
				"Credit balances alert when they increase.":
					"额度余额下降此数值的百分点数或增加时会发出提醒。",
				"Team credits": "团队额度",
				"Turn points into provider credits and more.":
					"将积分兑换为提供商额度等。",
				"{points} Ryu points": "{points} Ryu 积分",
			})
		).toEqual([]);
	});
});

describe("zh-CN catalogs follow the glossary", () => {
	test("the root zh-CN catalog uses 智能体 for agents and 额度 for credits", async () => {
		const catalog = await readCatalog("zh-CN.json");
		expect(glossaryViolations(catalog)).toEqual([]);
		expect(catalog["Create new agent"]).toBe("新建智能体");
		expect(catalog["Team credits"]).toBe("团队额度");
		expect(catalog["Turn points into provider credits and more."]).toBe(
			"将积分兑换为提供商额度等。"
		);
	});

	test("every generated zh-CN subset follows the glossary", async () => {
		const violations: string[] = [];
		const glob = new Bun.Glob("*/**/zh-CN.json");
		for await (const path of glob.scan(fileURLToPath(LOCALES_DIR))) {
			for (const violation of glossaryViolations(await readCatalog(path))) {
				violations.push(`${path}: ${violation}`);
			}
		}
		expect(violations).toEqual([]);
	});
});

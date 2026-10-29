import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	setSystemTime,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfaceAccount,
	InterfaceAccountTransaction,
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { BankInterface } from "./bank-interface.tsx";
import {
	agentActivity,
	dailySpend,
	formatMoney,
	groupByDay,
	moneyParts,
	monthlyStatements,
	monthToDate,
	niceCeiling,
	rollupShares,
	spendByAgent,
	spendByConversation,
	spendByModel,
	tokensThisMonth,
	transactionCountLabel,
	transactionSubtitle,
} from "./bank-model.ts";

const HOUR = 3_600_000;
/** Local noon on 14 October 2026, so day and month math is zone-proof. */
const BASE = new Date(2026, 9, 14, 12, 0).getTime();

function thread(
	input: Partial<InterfaceThread> & Pick<InterfaceThread, "id">
): InterfaceThread {
	return {
		agentIds: [],
		lastMessage: null,
		lastMessageRole: "assistant",
		messageCount: 2,
		pinned: false,
		projectId: null,
		running: false,
		teamId: null,
		title: input.id,
		updatedAt: new Date(BASE - HOUR).toISOString(),
		...input,
	};
}

function spend(
	input: Partial<InterfaceAccountTransaction> &
		Pick<InterfaceAccountTransaction, "amount" | "at" | "id">
): InterfaceAccountTransaction {
	return {
		balanceAfter: null,
		inputTokens: 1000,
		kind: "debit",
		label: "Agent run",
		model: "claude-sonnet",
		outputTokens: 500,
		provider: "anthropic",
		threadId: null,
		...input,
	};
}

const local = (month: number, day: number, hour = 10) =>
	new Date(2026, month, day, hour, 0).toISOString();

const TRANSACTIONS: InterfaceAccountTransaction[] = [
	spend({
		amount: -3400,
		at: local(9, 14, 9),
		balanceAfter: 18_420_000,
		id: "txn-today",
		threadId: "thread-hero",
	}),
	spend({
		amount: -1200,
		at: local(9, 14, 8),
		id: "txn-today-2",
		model: "gpt-mini",
		provider: "openai",
		threadId: "thread-shared",
	}),
	spend({
		amount: -50_000,
		at: local(9, 13),
		id: "txn-yesterday",
		inputTokens: 4000,
		outputTokens: 2000,
		threadId: null,
	}),
	{
		amount: 10_000_000,
		at: local(9, 3),
		balanceAfter: 18_473_600,
		id: "txn-topup",
		inputTokens: null,
		kind: "credit",
		label: "Top-up",
		model: null,
		outputTokens: null,
		provider: null,
		threadId: null,
	},
	spend({
		amount: -20_000,
		at: local(8, 30),
		balanceAfter: 8_473_600,
		id: "txn-september",
		model: "gpt-mini",
		provider: "openai",
		threadId: "thread-hero",
	}),
	spend({
		amount: -7000,
		at: local(8, 10),
		id: "txn-september-early",
		threadId: "thread-hero",
	}),
];

const ACCOUNT: InterfaceAccount = {
	balance: 18_420_000,
	breakdown: { gift: 1_000_000, plan: 7_420_000, topup: 10_000_000 },
	currency: "usd",
	transactions: TRANSACTIONS,
};

const SNAPSHOT: InterfaceSnapshot = {
	account: ACCOUNT,
	agents: [
		{
			avatarUrl: null,
			description: "Engineer",
			id: "agent-forge",
			name: "Forge",
			status: "working",
		},
		{
			avatarUrl: null,
			description: "Writer",
			id: "agent-echo",
			name: "Echo",
			status: "idle",
		},
	],
	groups: [],
	threads: [
		thread({
			agentIds: ["agent-forge"],
			id: "thread-hero",
			messageCount: 9,
			running: true,
			title: "Rebuild the landing hero",
		}),
		thread({
			agentIds: ["agent-forge", "agent-echo"],
			id: "thread-shared",
			messageCount: 4,
			title: "Launch post",
			updatedAt: new Date(BASE - 3 * HOUR).toISOString(),
		}),
	],
	version: 1,
};

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
// The fixtures name October 2026 and "today": render them at BASE so the
// statements, month totals and Today/Yesterday groups never follow the
// live clock across a month, a midnight or a DST change.
beforeEach(() => {
	setSystemTime(new Date(BASE));
});
afterEach(() => {
	setSystemTime();
});
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

async function mount(element: ReactElement) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(element));
	return {
		container,
		async dispose() {
			await act(async () => root.unmount());
			container.remove();
		},
		async rerender(next: ReactElement) {
			await act(async () => root.render(next));
		},
	};
}

async function click(element: Element | null | undefined) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected a clickable element");
	}
	await act(async () => element.click());
}

function buttonByText(container: HTMLElement, text: string) {
	return [...container.querySelectorAll("button")].find(
		(candidate) =>
			candidate.textContent?.trim() === text ||
			candidate.getAttribute("aria-label") === text
	);
}

function recordingPort() {
	const calls: string[] = [];
	const port: InterfacePort = {
		closeThread: () => calls.push("close"),
		openThread: (id) => calls.push(`open:${id}`),
		startThread: (input) => calls.push(`start:${JSON.stringify(input)}`),
	};
	return { calls, port };
}

function render(
	snapshot: InterfaceSnapshot,
	overrides: Partial<{
		activeThreadId: string | null;
		loading: boolean;
		port: InterfacePort;
		threadView: ReactElement | null;
	}> = {}
) {
	return (
		<BankInterface
			activeThreadId={overrides.activeThreadId ?? null}
			loading={overrides.loading ?? false}
			params={{}}
			port={overrides.port ?? recordingPort().port}
			snapshot={snapshot}
			threadView={overrides.threadView ?? null}
		/>
	);
}

describe("bank model", () => {
	test("formats micro-units without hiding sub-cent spend", () => {
		expect(formatMoney(18_420_000, "usd")).toBe("$18.42");
		expect(formatMoney(-3400, "usd")).toBe("$0.0034");
		expect(formatMoney(50_000, "usd")).toBe("$0.05");
		expect(formatMoney(52_200, "usd")).toBe("$0.0522");
		expect(formatMoney(10_000_000, "usd", { plus: true })).toBe("+$10.00");
		expect(formatMoney(0, "usd")).toBe("$0.00");
		expect(moneyParts(18_420_000, "usd")).toEqual({
			fraction: ".42",
			lead: "$18",
		});
	});

	test("subtitles name model, provider, and tokens", () => {
		expect(
			transactionSubtitle(TRANSACTIONS[0] as InterfaceAccountTransaction)
		).toBe("claude-sonnet · anthropic · 1.5K tokens");
		expect(
			transactionSubtitle(TRANSACTIONS[3] as InterfaceAccountTransaction)
		).toBe("Credit");
	});

	test("groups the feed by day, newest first, with each day's spend", () => {
		const groups = groupByDay(TRANSACTIONS, BASE);
		expect(groups.map((group) => group.label).slice(0, 2)).toEqual([
			"Today",
			"Yesterday",
		]);
		expect(groups[0]?.transactions.map((row) => row.id)).toEqual([
			"txn-today",
			"txn-today-2",
		]);
		expect(groups[0]?.spent).toBe(4600);
		expect(groups.find((group) => group.spent === 0)?.credited).toBe(
			10_000_000
		);
		expect(groups.length).toBe(5);
	});

	test("sums this month's tokens and month-to-date spend from debits only", () => {
		expect(tokensThisMonth(TRANSACTIONS, BASE)).toBe(1500 + 1500 + 6000);
		expect(monthToDate(TRANSACTIONS, BASE)).toEqual({
			current: 3400 + 1200 + 50_000,
			dayOfMonth: 14,
			hasFullPrevious: false,
			historyStart: Date.parse(local(8, 10)),
			previous: 27_000,
			previousToDate: 7000,
		});
	});

	test("charts thirty days ending today", () => {
		const days = dailySpend(TRANSACTIONS, BASE);
		expect(days.length).toBe(30);
		expect(days.at(-1)?.spent).toBe(4600);
		expect(days.at(-1)?.count).toBe(2);
		expect(days.at(-2)?.spent).toBe(50_000);
		expect(days.reduce((sum, day) => sum + day.spent, 0)).toBe(74_600);
	});

	test("ranks spend by model, agent, and conversation without splitting", () => {
		const models = spendByModel(TRANSACTIONS, "this-month", BASE);
		expect(models.map((row) => [row.label, row.spent])).toEqual([
			["claude-sonnet", 53_400],
			["gpt-mini", 1200],
		]);
		const agents = spendByAgent(SNAPSHOT, TRANSACTIONS, "this-month", BASE);
		// Spend outside any conversation is pinned after the agents, not ranked.
		expect(agents.map((row) => [row.label, row.spent, row.pinned])).toEqual([
			["Forge", 3400, false],
			["Forge and Echo", 1200, false],
			["Outside conversations", 50_000, true],
		]);
		expect(agents.at(-1)?.share).toBeCloseTo(50_000 / 54_600);
		const lastMonth = spendByConversation(
			SNAPSHOT,
			TRANSACTIONS,
			"last-month",
			BASE
		);
		expect(lastMonth).toEqual([
			expect.objectContaining({
				label: "Rebuild the landing hero",
				spent: 27_000,
				threadId: "thread-hero",
			}),
		]);
	});

	test("statements close on the month's newest balance", () => {
		const statements = monthlyStatements(TRANSACTIONS);
		expect(statements.map((row) => row.key)).toEqual(["2026-10", "2026-09"]);
		expect(statements[0]).toMatchObject({
			closing: 18_420_000,
			count: 4,
			credited: 10_000_000,
			opening: 8_473_600,
			spent: 54_600,
		});
		expect(statements[1]?.opening).toBe(null);
		expect(statements[1]?.reconciles).toBe(null);
		const closing = statements[0]?.closing ?? 0;
		const opening = statements[0]?.opening ?? 0;
		expect(statements[0]?.reconciles).toBe(
			Math.abs(opening + 10_000_000 - 54_600 - closing) <= 10
		);
	});

	test("statements flag a month whose balances do not add up", () => {
		const row = (
			id: string,
			at: string,
			amount: number,
			balanceAfter: number
		): InterfaceAccountTransaction => ({
			amount,
			at,
			balanceAfter,
			id,
			inputTokens: null,
			kind: amount < 0 ? "debit" : "credit",
			label: id,
			model: null,
			outputTokens: null,
			provider: null,
			threadId: null,
		});
		const consistent = monthlyStatements([
			row("a", local(9, 5), -1000, 99_000),
			row("b", local(10, 2), -500, 98_500),
		]);
		expect(consistent[0]?.reconciles).toBe(true);
		const drifted = monthlyStatements([
			row("a", local(9, 5), -1000, 99_000),
			row("b", local(10, 2), -500, 90_000),
		]);
		expect(drifted[0]?.reconciles).toBe(false);
	});

	test("rankings roll the tail into one Other row without losing spend", () => {
		const share = (id: string, spent: number, pinned = false) => ({
			count: 1,
			detail: null,
			id,
			label: id,
			pinned,
			share: spent / 100,
			spent,
			threadId: null,
		});
		const shares = [
			share("a", 40),
			share("b", 20),
			share("c", 15),
			share("d", 10),
			share("e", 5),
			share("f", 4),
			share("none", 6, true),
		];
		const rolled = rollupShares(shares, 3);
		expect(rolled.map((row) => row.label)).toEqual([
			"a",
			"b",
			"c",
			"Other",
			"none",
		]);
		expect(rolled[3]?.spent).toBe(19);
		expect(rolled[3]?.count).toBe(3);
		// One row past the limit stays itself rather than becoming "Other".
		expect(rollupShares(shares.slice(0, 4), 3)).toHaveLength(4);
		expect(transactionCountLabel(1)).toBe("1 transaction");
		expect(transactionCountLabel(3)).toBe("3 transactions");
	});

	test("statements mark a month the feed only partly covers", () => {
		const statements = monthlyStatements(TRANSACTIONS);
		expect(statements[0]?.partialFrom).toBe(null);
		expect(statements[1]?.partialFrom).toBe(Date.parse(local(8, 10)));

		const fromMonthStart = monthlyStatements([
			spend({ amount: -1000, at: local(9, 3), id: "txn-october" }),
			spend({
				amount: -2000,
				at: new Date(2026, 8, 1, 0, 0).toISOString(),
				id: "txn-september-first",
			}),
		]);
		expect(fromMonthStart.map((row) => row.partialFrom)).toEqual([null, null]);
	});

	test("agent activity orders agents by their latest thread", () => {
		const rows = agentActivity(SNAPSHOT);
		expect(
			rows.map((row) => [row.agent.name, row.threads, row.messages])
		).toEqual([
			["Forge", 2, 13],
			["Echo", 1, 4],
		]);
		expect(rows[0]?.working).toBe(true);
	});
});

describe("niceCeiling", () => {
	test("rounds a chart peak up to a readable top tick", () => {
		expect(niceCeiling(9200)).toBe(10_000);
		expect(niceCeiling(10_000)).toBe(10_000);
		expect(niceCeiling(2100)).toBe(2500);
		expect(niceCeiling(1_400_000)).toBe(2_000_000);
		expect(niceCeiling(0)).toBe(0);
		expect(formatMoney(niceCeiling(9200), "usd")).toBe("$0.01");
	});
});

describe("BankInterface", () => {
	test("renders the loading skeleton and the signed-out state", () => {
		const loading = renderToStaticMarkup(render(SNAPSHOT, { loading: true }));
		expect(loading).toContain('data-testid="interface-bank"');
		expect(loading).toContain('aria-busy="true"');
		expect(loading).not.toContain("$18");

		const signedOut = renderToStaticMarkup(
			render({ ...SNAPSHOT, account: undefined })
		);
		expect(signedOut).toContain("Balance unavailable");
		// The renderer cannot tell signed out from unreachable: no false diagnosis.
		expect(signedOut).toContain("If you are already signed in");
		expect(signedOut).toContain("Agent activity");
		expect(signedOut).toContain("Forge");
		expect(signedOut).not.toContain('role="tablist"');

		const empty = renderToStaticMarkup(
			render({ ...SNAPSHOT, account: undefined, agents: [], threads: [] })
		);
		expect(empty).toContain("No agents yet");
	});

	test("home shows the balance, breakdown, figures, and day-grouped feed", () => {
		const markup = renderToStaticMarkup(render(SNAPSHOT));
		expect(markup).toContain("$18");
		expect(markup).toContain(".42");
		expect(markup).toContain("Top-up");
		expect(markup).toContain("$10.00");
		expect(markup).toContain("Top up in Settings");
		expect(markup).toContain('aria-disabled="true"');
		expect(markup).toContain("Tokens this month");
		expect(markup).toContain("Today");
		expect(markup).toContain("Yesterday");
		expect(markup).toContain("Rebuild the landing hero");
		expect(markup).toContain("+$10.00");
		expect(markup).toContain('data-testid="bank-spend-chart"');
		expect(markup).toContain("Daily spend, last 30 days");
		// Narrow rows fold the agent into the subtitle instead of dropping it.
		expect(markup).toMatch(
			/@2xl:hidden">Forge<span aria-hidden="true"> · <\/span>/
		);
	});

	test("the chart readout replaces the heading line instead of floating over it", async () => {
		const view = await mount(render(SNAPSHOT));
		const slider = view.container.querySelector('[role="slider"]');
		expect(
			view.container.querySelector('[data-testid="bank-chart-readout"]')
		).toBeNull();
		await act(async () => {
			slider?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
			slider?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "End" })
			);
		});
		const readout = view.container.querySelector(
			'[data-testid="bank-chart-readout"]'
		);
		expect(readout?.textContent).toStartWith("Today");
		expect(readout?.closest("figure")).toBe(slider?.closest("figure") ?? null);
		await view.dispose();
	});

	test("an empty account has a plain feed state", () => {
		const markup = renderToStaticMarkup(
			render({
				...SNAPSHOT,
				account: { ...ACCOUNT, balance: null, transactions: [] },
			})
		);
		expect(markup).toContain("No transactions yet");
		expect(markup).toContain(">Unavailable</p>");
	});

	test("a row opens the detail sheet, and View conversation opens the thread", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(render(SNAPSHOT, { port }));
		await click(
			view.container.querySelector('[data-transaction-id="txn-today"]')
		);
		const sheet = view.container.querySelector(
			'[data-testid="bank-transaction-panel"]'
		);
		expect(sheet?.textContent).toContain("Input tokens");
		expect(sheet?.textContent).toContain("1,000");
		expect(sheet?.textContent).toContain("$18.42");
		expect(document.activeElement?.textContent).toBe("Agent run");
		await click(buttonByText(view.container, "View conversation"));
		expect(calls).toEqual(["open:thread-hero"]);

		await view.rerender(
			render(SNAPSHOT, {
				activeThreadId: "thread-hero",
				port,
				threadView: <div data-testid="host-thread">Host chat</div>,
			})
		);
		expect(
			view.container.querySelector('[data-testid="host-thread"]')
		).not.toBe(null);
		await click(buttonByText(view.container, "Back to transaction"));
		expect(calls).toEqual(["open:thread-hero", "close"]);
		await view.dispose();
	});

	test("credits and outside spend have no conversation link", async () => {
		const view = await mount(render(SNAPSHOT));
		await click(
			view.container.querySelector('[data-transaction-id="txn-topup"]')
		);
		expect(buttonByText(view.container, "View conversation")).toBeUndefined();
		await click(buttonByText(view.container, "Close transaction"));
		expect(
			view.container.querySelector('[data-testid="bank-transaction-panel"]')
		).toBe(null);
		expect(document.activeElement?.getAttribute("data-transaction-id")).toBe(
			"txn-topup"
		);
		await view.dispose();
	});

	test("search filters the feed and quick actions switch tabs", async () => {
		const view = await mount(render(SNAPSHOT));
		const input = view.container.querySelector<HTMLInputElement>(
			'input[aria-label="Search transactions"]'
		);
		if (!input) {
			throw new Error("Expected the search field");
		}
		const setValue = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set;
		await act(async () => {
			input.focus();
			setValue?.call(input, "gpt-mini");
			input.dispatchEvent(new Event("input", { bubbles: true }));
			// React may fall back to keyup when it loaded before the DOM shim.
			input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
		});
		const rows = [
			...view.container.querySelectorAll("[data-transaction-id]"),
		].map((row) => row.getAttribute("data-transaction-id"));
		expect(rows).toEqual(["txn-today-2", "txn-september"]);

		await click(buttonByText(view.container, "Insights"));
		expect(
			view.container.querySelector('[data-testid="bank-insights"]')
		).not.toBe(null);
		await click(buttonByText(view.container, "Statements"));
		expect(
			view.container.querySelector('[data-testid="bank-statements"]')
				?.textContent
		).toContain("October 2026");
		expect(
			view.container.querySelector('[data-testid="bank-statements"]')
				?.textContent
		).toContain("Partial: history starts");
		// Each year cell heads the rows of its own group, not a column group.
		const yearHeaders = [
			...view.container.querySelectorAll(
				'[data-testid="bank-statements"] th[colspan="6"]'
			),
		];
		expect(yearHeaders.map((cell) => cell.getAttribute("scope"))).toEqual([
			"rowgroup",
		]);
		await view.dispose();
	});

	test("a statement month opens the feed narrowed to that month", async () => {
		const view = await mount(render(SNAPSHOT));
		await click(buttonByText(view.container, "Statements"));
		// Live times shift with the clock, so take the oldest month listed.
		const months = view.container.querySelectorAll("[data-statement-month]");
		await click(months.item(months.length - 1));
		const rows = [
			...view.container.querySelectorAll("[data-transaction-id]"),
		].map((row) => row.getAttribute("data-transaction-id"));
		expect(rows.length).toBeGreaterThan(0);
		expect(rows).not.toContain("txn-today");
		expect(rows).toContain("txn-september-early");
		await click(
			view.container.querySelector('button[aria-label^="Show all months"]')
		);
		expect(
			view.container.querySelector('[data-transaction-id="txn-today"]')
		).not.toBe(null);
		await view.dispose();
	});

	test("insights conversation rows open their thread", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(render(SNAPSHOT, { port }));
		await click(buttonByText(view.container, "Insights"));
		await click(view.container.querySelector('[data-thread-id="thread-hero"]'));
		expect(calls).toEqual(["open:thread-hero"]);
		await view.dispose();
	});

	test("insights name last month by how much of it the history covers", async () => {
		const insightsText = async (snapshot: InterfaceSnapshot) => {
			const view = await mount(render(snapshot));
			await click(buttonByText(view.container, "Insights"));
			const text =
				view.container.querySelector('[data-testid="bank-insights"]')
					?.textContent ?? "";
			await view.dispose();
			return text;
		};
		// History from Sep 10: September is partly covered.
		const partial = await insightsText(SNAPSHOT);
		expect(partial).toContain("September, from");
		expect(partial).toContain("partway through September");
		// History from Oct 3: September has none at all.
		const thisMonthOnly = TRANSACTIONS.filter(
			(transaction) => Date.parse(transaction.at) >= Date.parse(local(9, 1, 0))
		);
		const fresh = await insightsText({
			...SNAPSHOT,
			account: { ...ACCOUNT, transactions: thisMonthOnly },
		});
		expect(fresh).toContain("No history in September");
		expect(fresh).toContain("Your history starts");
		expect(fresh).not.toContain("September, from");
		expect(fresh).not.toContain("partway through");
	});

	test("the host thread view shows in the panel and Escape closes it", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			render(SNAPSHOT, {
				activeThreadId: "thread-shared",
				port,
				threadView: <div data-testid="host-thread">Host chat</div>,
			})
		);
		const panel = view.container.querySelector(
			'[data-testid="bank-thread-panel"]'
		);
		expect(panel?.textContent).toContain("Launch post");
		expect(panel?.textContent).toContain("Forge and Echo");
		const root = view.container.querySelector('[data-testid="interface-bank"]');
		await act(async () => {
			root?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
			);
		});
		expect(calls).toEqual(["close"]);
		await view.dispose();
	});

	test("leaves Escape on <body> to the host's cover", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			render(SNAPSHOT, {
				activeThreadId: "thread-shared",
				port,
				threadView: <div data-testid="host-thread">Host chat</div>,
			})
		);
		const press = async () => {
			await act(async () => {
				document.body.dispatchEvent(
					new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
				);
			});
		};
		(document.activeElement as HTMLElement | null)?.blur();
		// While the host covers the bank it is inert: <body> keys pass it by.
		view.container.setAttribute("inert", "");
		await press();
		expect(calls).toEqual([]);
		view.container.removeAttribute("inert");
		await press();
		expect(calls).toEqual(["close"]);
		await view.dispose();
	});
});

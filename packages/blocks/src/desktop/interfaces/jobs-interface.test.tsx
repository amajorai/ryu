import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JobsInterface } from "./jobs-interface.tsx";
import {
	activeFilterCount,
	applySavedSearch,
	companyTone,
	countByStatus,
	EMPTY_JOB_FILTERS,
	filterFreelancers,
	filterJobs,
	freelancerMeta,
	freelancerProfile,
	freelancerProfiles,
	JOB_SAVED_SEARCHES,
	jobAge,
	jobCompanies,
	jobFacetCounts,
	jobRow,
	jobRows,
	jobStartInput,
	jobStatus,
	jobStatusDetail,
	jobTimeline,
	matchesSavedSearch,
	nameList,
	pillLabel,
	sortJobs,
	stepIndex,
} from "./jobs-model.ts";

const MINUTE = 60_000;
const BASE = Date.parse("2026-10-12T12:00:00Z");
const ago = (minutes: number) =>
	new Date(BASE - minutes * MINUTE).toISOString();

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
		updatedAt: ago(60),
		...input,
	};
}

const SNAPSHOT: InterfaceSnapshot = {
	agents: [
		{
			avatarUrl: null,
			description: "Writes the release notes",
			id: "agent-ada",
			name: "Ada",
			status: "idle",
		},
		{
			avatarUrl: null,
			description: "Triages bugs",
			id: "agent-grace",
			name: "Grace",
			status: "working",
		},
		{
			avatarUrl: null,
			description: "Brand and type",
			id: "agent-lin",
			name: "Lin",
			status: "idle",
		},
	],
	groups: [
		{
			id: "team-design",
			kind: "team",
			memberAgentIds: ["agent-ada"],
			name: "Design Review",
		},
		{
			id: "project-site",
			kind: "project",
			memberAgentIds: ["agent-grace"],
			name: "Atlas Site",
		},
	],
	threads: [
		thread({
			agentIds: ["agent-ada"],
			id: "thread-notes",
			lastMessage: "Draft is ready for review.",
			teamId: "team-design",
			title: "Release notes",
			updatedAt: ago(30),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-intro",
			lastMessage: "Can you shorten the intro?",
			lastMessageRole: "user",
			title: "Intro edits",
			updatedAt: ago(90),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-triage",
			lastMessage: "Looking at the crash reports now.",
			running: true,
			title: "Crash triage",
			updatedAt: ago(5),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-deploy",
			lastMessage: "The deploy step failed.",
			projectId: "project-site",
			runState: "failed",
			title: "Ship the site",
			updatedAt: ago(10),
		}),
		thread({
			agentIds: [],
			id: "thread-empty",
			lastMessageRole: null,
			messageCount: 0,
			title: "  ",
			updatedAt: ago(60 * 24 * 10),
		}),
	],
	version: 1,
};

function threadAt(index: number): InterfaceThread {
	const found = SNAPSHOT.threads[index];
	if (!found) {
		throw new Error(`fixture thread ${index}`);
	}
	return found;
}

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
if (typeof Element.prototype.getAnimations !== "function") {
	Element.prototype.getAnimations = () => [];
}
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

async function press(element: Element | null | undefined, key: string) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected an element to press keys on");
	}
	await act(async () => {
		element.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
	});
}

async function typeInto(field: HTMLTextAreaElement, value: string) {
	const setValue = Object.getOwnPropertyDescriptor(
		HTMLTextAreaElement.prototype,
		"value"
	)?.set;
	await act(async () => {
		field.focus();
		setValue?.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
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

function rowTitles(container: HTMLElement): string[] {
	return [...container.querySelectorAll("[data-testid='jobs-row']")].map(
		(row) => row.querySelector("p")?.textContent ?? ""
	);
}

function buttonByText(container: HTMLElement, text: string) {
	return [...container.querySelectorAll("button")].find(
		(button) => button.textContent?.trim() === text
	);
}

function jobs(
	overrides: Partial<Parameters<typeof JobsInterface>[0]> & {
		port: InterfacePort;
	}
) {
	return (
		<JobsInterface
			activeThreadId={null}
			loading={false}
			params={{}}
			snapshot={SNAPSHOT}
			threadView={null}
			{...overrides}
		/>
	);
}

describe("jobs model", () => {
	test("speaks hiring vocabulary for every thread status", () => {
		expect(SNAPSHOT.threads.map((item) => jobStatus(item))).toEqual([
			"review",
			"open",
			"in-progress",
			"on-hold",
			"closed",
		]);
		expect(countByStatus(jobRows(SNAPSHOT))).toEqual({
			closed: 1,
			"in-progress": 1,
			"on-hold": 1,
			open: 1,
			review: 1,
		});
	});

	test("files jobs under their project or team, else Personal", () => {
		const rows = jobRows(SNAPSHOT);
		expect(rows.map((row) => row.company.name)).toEqual([
			"Design Review",
			"Personal",
			"Personal",
			"Atlas Site",
			"Personal",
		]);
		expect(jobCompanies(SNAPSHOT).map((company) => company.name)).toEqual([
			"Personal",
			"Atlas Site",
			"Design Review",
		]);
		expect(rows[4]?.title).toBe("Untitled job");
		expect(rows[4]?.freelancer).toBeUndefined();
		expect(companyTone("team-design")).toBe(companyTone("team-design"));
	});

	test("attributes the deliverable to whoever wrote last", () => {
		expect(jobRow(SNAPSHOT, threadAt(0)).deliverable).toEqual({
			from: "agent",
			text: "Draft is ready for review.",
		});
		expect(jobRow(SNAPSHOT, threadAt(1)).deliverable?.from).toBe("you");
		expect(jobRow(SNAPSHOT, threadAt(4)).deliverable).toBeNull();
	});

	test("filters by status, freelancer, company, recency, and text", () => {
		const rows = jobRows(SNAPSHOT);
		const ids = (patch: Partial<typeof EMPTY_JOB_FILTERS>) =>
			filterJobs(rows, { ...EMPTY_JOB_FILTERS, ...patch }, BASE).map(
				(row) => row.thread.id
			);
		expect(ids({ statuses: ["review", "on-hold"] })).toEqual([
			"thread-notes",
			"thread-deploy",
		]);
		expect(ids({ freelancerIds: ["agent-grace"] })).toEqual([
			"thread-triage",
			"thread-deploy",
		]);
		expect(ids({ companyIds: ["personal"] })).toEqual([
			"thread-intro",
			"thread-triage",
			"thread-empty",
		]);
		expect(ids({ updated: "day" })).toHaveLength(4);
		expect(ids({ query: "crash" })).toEqual(["thread-triage"]);
		expect(ids({ query: "ada" })).toEqual(["thread-notes", "thread-intro"]);
		expect(
			activeFilterCount({
				...EMPTY_JOB_FILTERS,
				statuses: ["open"],
				updated: "week",
			})
		).toBe(2);
	});

	test("counts each filter option with the other filters applied", () => {
		const rows = jobRows(SNAPSHOT);
		const all = jobFacetCounts(rows, EMPTY_JOB_FILTERS, BASE);
		expect(all.updated.any).toBe(rows.length);
		expect(all.freelancers.get("agent-ada")).toBe(2);
		const adaOnly = jobFacetCounts(
			rows,
			{ ...EMPTY_JOB_FILTERS, freelancerIds: ["agent-ada"] },
			BASE
		);
		// The freelancer facet ignores its own selection...
		expect(adaOnly.freelancers.get("agent-grace")).toBe(
			all.freelancers.get("agent-grace")
		);
		// ...while the other facets narrow to Ada's jobs.
		expect(adaOnly.updated.any).toBe(2);
		expect(adaOnly.companies.get("team-design")).toBe(1);
	});

	test("sorts by recency or puts review first", () => {
		const rows = jobRows(SNAPSHOT);
		expect(sortJobs(rows, "recent").map((row) => row.thread.id)).toEqual([
			"thread-triage",
			"thread-deploy",
			"thread-notes",
			"thread-intro",
			"thread-empty",
		]);
		expect(sortJobs(rows, "status")[0]?.thread.id).toBe("thread-notes");
	});

	test("matches and applies saved searches without losing the query", () => {
		const review = JOB_SAVED_SEARCHES.find((saved) => saved.id === "review");
		const all = JOB_SAVED_SEARCHES.find((saved) => saved.id === "all");
		if (!(review && all)) {
			throw new Error("saved searches");
		}
		const applied = applySavedSearch(
			{ ...EMPTY_JOB_FILTERS, query: "notes" },
			review
		);
		expect(applied.statuses).toEqual(["review"]);
		expect(applied.query).toBe("notes");
		expect(matchesSavedSearch(applied, review)).toBe(true);
		expect(matchesSavedSearch(applied, all)).toBe(false);
		expect(pillLabel("Status", [])).toBe("Status");
		expect(pillLabel("Status", ["Review"])).toBe("Review");
		expect(pillLabel("Status", ["Review", "Open"])).toBe("Status · 2");
	});

	test("computes freelancer records honestly from statuses", () => {
		const [ada, grace, lin] = SNAPSHOT.agents;
		if (!(ada && grace && lin)) {
			throw new Error("fixture agents");
		}
		expect(freelancerProfile(SNAPSHOT, ada)).toMatchObject({
			active: 0,
			completed: 0,
			inReview: 1,
			onHold: 0,
			settled: 1,
			// One settled job is too small a sample to score.
			successRate: null,
			total: 2,
		});
		expect(freelancerProfile(SNAPSHOT, grace)).toMatchObject({
			active: 1,
			completed: 0,
			onHold: 1,
			settled: 1,
			successRate: null,
		});
		expect(freelancerProfile(SNAPSHOT, lin).successRate).toBeNull();
		const seasoned: InterfaceSnapshot = {
			...SNAPSHOT,
			threads: [
				thread({ agentIds: ["agent-ada"], id: "s-1", lastMessage: "Done." }),
				thread({ agentIds: ["agent-ada"], id: "s-2", lastMessage: "Done." }),
				thread({
					agentIds: ["agent-ada"],
					id: "s-3",
					runState: "failed",
				}),
			],
		};
		// Delivered work waiting on review is not completed until you close it,
		// but it does count toward job success.
		expect(freelancerProfile(seasoned, ada)).toMatchObject({
			completed: 0,
			inReview: 2,
			onHold: 1,
			settled: 3,
			successRate: 67,
		});
		// Closed (quiet) jobs are the only completed jobs, so the profile agrees
		// with the Status filter's Closed count.
		const closedOnly: InterfaceSnapshot = {
			...SNAPSHOT,
			threads: [
				thread({ agentIds: ["agent-ada"], id: "c-1", lastMessageRole: null }),
				thread({ agentIds: ["agent-ada"], id: "c-2", lastMessageRole: null }),
				thread({ agentIds: ["agent-ada"], id: "c-3", lastMessageRole: null }),
				thread({ agentIds: ["agent-ada"], id: "c-4", runState: "interrupted" }),
			],
		};
		expect(
			closedOnly.threads.map((item) => jobStatus(item)).slice(0, 3)
		).toEqual(["closed", "closed", "closed"]);
		expect(freelancerProfile(closedOnly, ada)).toMatchObject({
			completed: 3,
			onHold: 1,
			settled: 4,
			successRate: 75,
			total: 4,
		});
		// A thread nobody wrote in reads "No activity yet", not finished
		// work: it counts toward the total but not as completed.
		const neverStarted: InterfaceSnapshot = {
			...SNAPSHOT,
			threads: [
				thread({
					agentIds: ["agent-ada"],
					id: "q-1",
					lastMessageRole: null,
					messageCount: 0,
				}),
				thread({
					agentIds: ["agent-ada"],
					id: "q-2",
					lastMessageRole: null,
					messageCount: 0,
				}),
				thread({ agentIds: ["agent-ada"], id: "q-3", runState: "interrupted" }),
			],
		};
		expect(freelancerProfile(neverStarted, ada)).toMatchObject({
			completed: 0,
			onHold: 1,
			settled: 1,
			successRate: null,
			total: 3,
		});
		// Every row has the same meta shape; the score is appended only when
		// there is one.
		expect(freelancerMeta(freelancerProfile(closedOnly, ada))).toBe(
			"4 jobs · 3 completed · 75% job success"
		);
		expect(freelancerMeta(freelancerProfile(SNAPSHOT, ada))).toBe(
			"2 jobs · 0 completed"
		);
		expect(
			freelancerMeta(freelancerProfile({ ...SNAPSHOT, threads: [] }, ada))
		).toBe("No jobs yet");
		expect(
			freelancerProfiles(SNAPSHOT).map((profile) => profile.agent.name)
		).toEqual(["Grace", "Ada", "Lin"]);
		expect(
			filterFreelancers(freelancerProfiles(SNAPSHOT), "bugs").map(
				(profile) => profile.agent.name
			)
		).toEqual(["Grace"]);
	});

	test("explains status and builds a timeline from recorded facts", () => {
		const failed = jobRow(SNAPSHOT, threadAt(3));
		expect(jobStatusDetail(failed)).toBe(
			"The last run failed. Reply to retry."
		);
		expect(jobStatusDetail(jobRow(SNAPSHOT, threadAt(4)))).toContain(
			"Nothing has been said"
		);
		expect(jobTimeline(failed).map((entry) => entry.label)).toEqual([
			"Posted by you",
			"Put on hold",
		]);
		// No creation time is recorded, so the posting step carries no time; it
		// names who was hired instead.
		expect(jobTimeline(failed)[0]?.at).toBeNull();
		expect(jobTimeline(failed)[0]?.detail).toBe("Hired Grace");
		expect(nameList(["Atlas", "Brook", "Cipher"])).toBe(
			"Atlas, Brook and Cipher"
		);
		expect(jobTimeline(failed)[1]?.at).toBe(failed.thread.updatedAt);
	});

	test("formats ages, start input, and cursor steps", () => {
		expect(jobAge(ago(0), BASE)).toBe("Just now");
		expect(jobAge(ago(1), BASE)).toBe("1 minute ago");
		expect(jobAge(ago(60 * 3), BASE)).toBe("3 hours ago");
		expect(jobAge(ago(60 * 24 * 2), BASE)).toBe("2 days ago");
		expect(
			jobStartInput({
				agentId: "agent-ada",
				companyId: "team-design",
				prompt: "Write it",
				snapshot: SNAPSHOT,
			})
		).toEqual({
			agentId: "agent-ada",
			prompt: "Write it",
			teamId: "team-design",
		});
		expect(
			jobStartInput({
				agentId: undefined,
				companyId: "personal",
				prompt: "Hi",
				snapshot: SNAPSHOT,
			})
		).toEqual({ prompt: "Hi" });
		expect(stepIndex("next", 4, 5)).toBe(4);
		expect(stepIndex("previous", 0, 5)).toBe(0);
		expect(stepIndex("last", 0, 5)).toBe(4);
	});
});

describe("JobsInterface", () => {
	test("renders a loading skeleton and an empty board", () => {
		const { port } = recordingPort();
		const empty = { ...SNAPSHOT, agents: [], groups: [], threads: [] };
		const loading = renderToStaticMarkup(
			jobs({ loading: true, port, snapshot: empty })
		);
		expect(loading).toContain('data-testid="interface-jobs"');
		expect(loading).toContain('aria-busy="true"');
		expect(loading).toContain('data-testid="jobs-skeleton"');
		const settled = renderToStaticMarkup(jobs({ port, snapshot: empty }));
		expect(settled).toContain("No jobs posted yet");
		expect(settled).toContain("Your jobs show up here");
	});

	test("lists jobs with company, freelancer, and hiring status", async () => {
		const { port } = recordingPort();
		const view = await mount(jobs({ port }));
		expect(rowTitles(view.container)).toEqual([
			"Crash triage",
			"Ship the site",
			"Release notes",
			"Intro edits",
			"Untitled job",
		]);
		const statuses = [
			...view.container.querySelectorAll(
				"[data-testid='jobs-row'] [data-status]"
			),
		].map((pill) => pill.textContent);
		expect(statuses).toEqual([
			"In progress",
			"On hold",
			"Review",
			"Open",
			"Closed",
		]);
		expect(view.container.textContent).toContain("Atlas Site");
		expect(view.container.textContent).toContain("No freelancer");
		// With nothing open, the detail previews the first job.
		const detail = view.container.querySelector("[data-testid='jobs-detail']");
		expect(detail?.textContent).toContain("Grace is working on this now.");
		expect(
			view.container.querySelector("[data-testid='jobs-thread-view']")
		).toBeNull();
		await view.dispose();
	});

	test("opens a job on click and Enter, and moves with the arrow keys", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(jobs({ port }));
		const rows = () => [
			...view.container.querySelectorAll("[data-testid='jobs-row']"),
		];
		await click(rows()[2]);
		expect(calls).toEqual(["open:thread-notes"]);
		await press(rows()[2], "ArrowDown");
		expect(rows()[3]?.getAttribute("tabindex")).toBe("0");
		expect(document.activeElement).toBe(rows()[3] ?? null);
		await press(rows()[3], "Enter");
		expect(calls.at(-1)).toBe("open:thread-intro");
		await press(rows()[3], "Home");
		expect(rows()[0]?.getAttribute("tabindex")).toBe("0");
		await view.dispose();
	});

	test("shows the host's thread view for the open job, then full view", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			jobs({
				activeThreadId: "thread-notes",
				port,
				threadView: <div data-testid="host-chat">Host chat</div>,
			})
		);
		const pane = view.container.querySelector(
			"[data-testid='jobs-thread-view']"
		);
		expect(pane?.querySelector("[data-testid='host-chat']")).not.toBeNull();
		// The open job keeps its freelancer, timeline and deliverable beside
		// the thread.
		const meta = view.container.querySelector(
			"[data-testid='jobs-detail-meta']"
		);
		expect(meta?.querySelector("[data-testid='jobs-timeline']")).not.toBeNull();
		// The thread already shows the latest message, so the side column swaps
		// the deliverable for the job's facts.
		expect(meta?.querySelector("[data-testid='jobs-deliverable']")).toBeNull();
		expect(meta?.querySelector("[data-testid='jobs-facts']")).not.toBeNull();
		expect(
			view.container.querySelector("[data-testid='jobs-status-detail']")
				?.textContent
		).toContain("Ada delivered.");
		await click(buttonByText(view.container, "Open full view"));
		const full = view.container.querySelector("[data-testid='jobs-full-view']");
		expect(full?.querySelector("[data-testid='host-chat']")).not.toBeNull();
		expect(
			view.container.querySelector("[data-testid='jobs-list']")
		).toBeNull();
		expect(
			view.container.querySelectorAll("[data-testid='host-chat']")
		).toHaveLength(1);
		await click(buttonByText(view.container, "Jobs"));
		expect(
			view.container.querySelector("[data-testid='jobs-list']")
		).not.toBeNull();
		await click(view.container.querySelector("[aria-label='Close job']"));
		expect(calls).toEqual(["close"]);
		await view.dispose();
	});

	test("narrows the list from a saved search and the search box", async () => {
		const { port } = recordingPort();
		const view = await mount(jobs({ port }));
		await click(buttonByText(view.container, "Ready for review1"));
		expect(rowTitles(view.container)).toEqual(["Release notes"]);
		expect(view.container.querySelector("h2")?.textContent).toBe(
			"Ready for review"
		);
		await click(buttonByText(view.container, "All jobs5"));
		const search = view.container.querySelector(
			"input[aria-label='Search jobs']"
		);
		if (!(search instanceof HTMLInputElement)) {
			throw new Error("search box");
		}
		const setValue = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set;
		await act(async () => {
			search.focus();
			setValue?.call(search, "nothing like this");
			search.dispatchEvent(new Event("input", { bubbles: true }));
			search.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
		});
		expect(rowTitles(view.container)).toEqual([]);
		expect(view.container.textContent).toContain("No jobs match");
		await view.dispose();
	});

	test("hires a freelancer with a typed brief through startThread", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(jobs({ port }));
		await click(view.container.querySelector("#jobs-tab-freelancers"));
		const profiles = [
			...view.container.querySelectorAll("[data-testid='jobs-freelancer-row']"),
		];
		expect(profiles.map((row) => row.querySelector("p")?.textContent)).toEqual([
			"Grace",
			"Ada",
			"Lin",
		]);
		// One hire path per freelancer: the row selects, the profile hires.
		expect(
			view.container
				.querySelector("[data-testid='jobs-freelancers']")
				?.querySelector("[aria-label='Hire Ada']")
		).toBeNull();
		await click(profiles[1]);
		const profile = view.container.querySelector(
			"[data-testid='jobs-profile']"
		);
		expect(profile?.textContent).toContain("New");
		// The composer stays folded behind Hire, Upwork-invite style.
		expect(profile?.querySelector("textarea")).toBeNull();
		await click(profile?.querySelector("[aria-label='Hire Ada']") ?? null);
		await act(async () => {
			await new Promise((resolve) => window.requestAnimationFrame(resolve));
		});
		const field = profile?.querySelector("textarea");
		if (!(field instanceof HTMLTextAreaElement)) {
			throw new Error("hire composer");
		}
		expect(profile?.textContent).toContain("Hire Ada");
		// Unfolded, the composer takes focus and the header button steps aside.
		expect(document.activeElement).toBe(field);
		expect(profile?.querySelector("[data-testid='jobs-hire']")).toBeNull();
		// Nothing is sent until the user types and submits.
		expect(calls).toEqual([]);
		await typeInto(field, "Tighten the changelog");
		// happy-dom has no native input events for React, so React reads the new
		// value on the next keydown; settle it before Enter submits.
		await press(field, "End");
		await press(field, "Enter");
		expect(calls).toEqual([
			`start:${JSON.stringify({ agentId: "agent-ada", prompt: "Tighten the changelog" })}`,
		]);
		expect(
			view.container.querySelector("[data-testid='jobs-list']")
		).not.toBeNull();
		await view.dispose();
	});

	test("'/' focuses the search box even when focus is on the page body", async () => {
		const { port } = recordingPort();
		const view = await mount(jobs({ port }));
		(document.activeElement as HTMLElement | null)?.blur?.();
		await act(async () => {
			document.body.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "/" })
			);
		});
		expect(document.activeElement?.getAttribute("aria-label")).toBe(
			"Search jobs"
		);
		await view.dispose();
	});

	test("leaving My jobs closes the open job so its thread is never hidden", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			jobs({
				activeThreadId: "thread-triage",
				port,
				threadView: <div data-testid="host-chat" />,
			})
		);
		await click(view.container.querySelector("#jobs-tab-freelancers"));
		expect(calls).toEqual(["close"]);
		await view.dispose();
	});
});

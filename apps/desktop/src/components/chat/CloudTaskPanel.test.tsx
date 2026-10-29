import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let boxBackendFlag = true;
mock.module("@/src/hooks/useFeatureFlag.ts", () => ({
	useFeatureFlag: () => boxBackendFlag,
}));
const { createRoot } = await import("react-dom/client");
const { CloudTaskPanel } = await import("./CloudTaskPanel.tsx");

const target: ApiTarget = {
	url: "https://cloud-task-panel.fixture",
	token: "node-token",
	userJwt: "user-jwt",
};
const conversationId = "conv-12345678-abcd";
const originalFetch = globalThis.fetch;
const roots: Root[] = [];
let client: QueryClient;

interface Call {
	body: unknown;
	method: string;
	path: string;
}
let calls: Call[];
let statusReply: () => Response;
let finishReply: () => Response;
let sessionBoxReply: () => Response;

function task(overrides: Record<string, unknown> = {}) {
	return {
		conversationId,
		environmentId: "env-1",
		backend: "box",
		executor: "codex",
		state: "ready",
		expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
		baseSha: "abc123",
		baseBranch: "main",
		activeRun: null,
		lastRun: null,
		finish: null,
		...overrides,
	};
}

const pushedFinish = {
	branch: "ryu/conv-123",
	headSha: "def456",
	pushed: true,
	pushError: null,
	compareUrl: "https://github.com/acme/app/compare/main...ryu/conv-123",
	teardown: "destroyed",
	files: 2,
	insertions: 5,
	deletions: 1,
};

beforeEach(() => {
	boxBackendFlag = true;
	calls = [];
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	statusReply = () => Response.json(task());
	finishReply = () => Response.json({ finish: pushedFinish });
	sessionBoxReply = () =>
		Response.json(
			{ error: { code: "session_box_not_found", message: "Not found" } },
			{ status: 404 }
		);
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			const call: Call = {
				path: url.pathname,
				method: init?.method ?? "GET",
				body: init?.body ? JSON.parse(String(init.body)) : null,
			};
			calls.push(call);
			if (url.pathname.endsWith("/finish")) {
				return Promise.resolve(finishReply());
			}
			if (url.pathname.startsWith("/api/session-boxes/")) {
				return Promise.resolve(sessionBoxReply());
			}
			if (url.pathname.startsWith("/api/cloud-tasks/")) {
				return Promise.resolve(statusReply());
			}
			return Promise.resolve(Response.json({}));
		},
		{ preconnect: originalFetch.preconnect }
	);
});

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	client.clear();
	document.body.replaceChildren();
	globalThis.fetch = originalFetch;
});

async function settle() {
	await act(async () => {
		await Bun.sleep(30);
	});
}

async function mount(onRunSettled?: () => void) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<CloudTaskPanel
					conversationId={conversationId}
					onRunSettled={onRunSettled}
					target={target}
				/>
			</QueryClientProvider>
		)
	);
	await settle();
	return container;
}

function button(label: string): HTMLButtonElement {
	const found = [...document.querySelectorAll("button")].find(
		(candidate) => candidate.textContent?.trim() === label
	);
	if (!found) {
		throw new Error(`Missing button ${label}`);
	}
	return found;
}

test("a running task shows the agent label and the output tail", async () => {
	statusReply = () =>
		Response.json(
			task({
				state: "running",
				activeRun: {
					id: "run-1",
					status: "running",
					startedAt: new Date().toISOString(),
					outputTail: "Editing src/app.ts",
				},
			})
		);
	const container = await mount();
	expect(container.textContent).toContain("Running Codex");
	expect(container.textContent).toContain("Fresh box");
	const output = container.querySelector("pre[aria-live='polite']");
	expect(output?.textContent).toBe("Editing src/app.ts");
	expect(button("Push branch").disabled).toBe(true);
});

test("a ready box enables Push branch and posts the finish body", async () => {
	await mount();
	const push = button("Push branch");
	expect(push.disabled).toBe(false);
	await act(async () => push.click());
	await settle();
	const form = document.querySelector("form");
	if (!form) {
		throw new Error("Missing push form");
	}
	await act(async () => form.requestSubmit());
	await settle();
	const finish = calls.find((call) => call.path.endsWith("/finish"));
	expect(finish).toEqual({
		path: `/api/cloud-tasks/${conversationId}/finish`,
		method: "POST",
		body: {
			push: true,
			teardown: "destroy",
			branch: "ryu/conv-123",
			commitMessage: "Changes from Ryu cloud task",
		},
	});
	const link = document.querySelector<HTMLAnchorElement>(
		`a[href="${pushedFinish.compareUrl}"]`
	);
	expect(link?.rel).toBe("noopener noreferrer");
});

test("a pushed finish renders an external compare link", async () => {
	statusReply = () => Response.json(task({ finish: pushedFinish }));
	const container = await mount();
	const link = container.querySelector<HTMLAnchorElement>("a");
	expect(link?.href).toBe(pushedFinish.compareUrl);
	expect(link?.target).toBe("_blank");
	expect(link?.rel).toContain("noopener");
});

test("a missing task renders nothing", async () => {
	statusReply = () =>
		Response.json(
			{ error: { code: "cloud_task_not_found", message: "Not found" } },
			{ status: 404 }
		);
	const container = await mount();
	expect(container.innerHTML).toBe("");
});

test("an older Core without the route hides the panel", async () => {
	statusReply = () => new Response("nope", { status: 500 });
	const container = await mount();
	expect(container.innerHTML).toBe("");
});

test("a new lastRun id calls onRunSettled once", async () => {
	const lastRun = (id: string) => ({
		id,
		status: "completed",
		exitCode: 0,
		summary: "Done",
		reason: null,
		completedAt: new Date().toISOString(),
	});
	statusReply = () => Response.json(task({ lastRun: lastRun("run-1") }));
	const settled = mock(() => undefined);
	await mount(settled);
	expect(settled).toHaveBeenCalledTimes(0);
	statusReply = () => Response.json(task({ lastRun: lastRun("run-2") }));
	await act(async () => {
		await client.invalidateQueries();
	});
	await settle();
	expect(settled).toHaveBeenCalledTimes(1);
	await act(async () => {
		await client.invalidateQueries();
	});
	await settle();
	expect(settled).toHaveBeenCalledTimes(1);
});

function buttonLabels(): string[] {
	return [...document.querySelectorAll("button")].map(
		(candidate) => candidate.textContent?.trim() ?? ""
	);
}

test("with the box preview off, review and push are hidden but Stop session remains", async () => {
	boxBackendFlag = false;
	const container = await mount();
	const labels = buttonLabels();
	expect(labels).not.toContain("Review changes");
	expect(labels).not.toContain("Push branch");
	expect(container.textContent).not.toContain("Fresh box");
	expect(button("Stop session").disabled).toBe(false);
	expect(container.querySelector("[role='status']")).not.toBeNull();
});

test("with the box preview off, a running task can still be stopped", async () => {
	boxBackendFlag = false;
	statusReply = () =>
		Response.json(
			task({
				state: "running",
				activeRun: {
					id: "run-1",
					status: "running",
					startedAt: new Date().toISOString(),
					outputTail: "Editing src/app.ts",
				},
			})
		);
	const container = await mount();
	expect(container.textContent).toContain("Running Codex");
	expect(buttonLabels()).not.toContain("Push branch");
	expect(button("Stop").disabled).toBe(false);
});

function checkboxFor(labelText: string): HTMLElement {
	const label = [...document.querySelectorAll("label")].find((candidate) =>
		candidate.textContent?.trim().startsWith(labelText)
	);
	const control = label ? document.getElementById(label.htmlFor) : null;
	const root = control?.closest("[role='checkbox']") ?? control;
	if (!(root instanceof HTMLElement)) {
		throw new Error(`Missing checkbox ${labelText}`);
	}
	return root;
}

function typeInto(
	input: HTMLInputElement | HTMLTextAreaElement,
	value: string
) {
	const prototype =
		input instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
	setter?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function openPushDialog(): Promise<HTMLFormElement> {
	await act(async () => button("Push branch").click());
	await settle();
	const form = document.querySelector("form");
	if (!form) {
		throw new Error("Missing push form");
	}
	return form;
}

const pullRequest = {
	url: "https://github.com/acme/app/pull/7",
	number: 7,
};

function pullRequestBodyField(): HTMLTextAreaElement {
	const label = [...document.querySelectorAll("label")].find(
		(candidate) =>
			candidate.textContent === "Pull request description (optional)"
	);
	const field = label ? document.getElementById(label.htmlFor) : null;
	if (!(field instanceof HTMLTextAreaElement)) {
		throw new Error("Missing pull request description");
	}
	return field;
}

function submitButton(): HTMLButtonElement {
	const found = document.querySelector<HTMLButtonElement>(
		"form button[type='submit']"
	);
	if (!found) {
		throw new Error("Missing submit button");
	}
	return found;
}

test("the pull request description is only offered with Open pull request and is sent as typed", async () => {
	await mount();
	const form = await openPushDialog();
	expect(form.querySelector("textarea")).toBeNull();
	await act(async () => checkboxFor("Open pull request into main").click());
	await settle();
	const body = pullRequestBodyField();
	expect(body.value).toBe("");
	expect(form.textContent).toContain("0 / 65,536 characters");
	const description = "## Summary\n\n- Fixes the parser\n";
	await act(async () => typeInto(body, description));
	expect(form.textContent).toContain(
		`${description.length} / 65,536 characters`
	);
	await act(async () => form.requestSubmit());
	await settle();
	const finish = calls.find((call) => call.path.endsWith("/finish"));
	expect(finish?.body).toEqual({
		push: true,
		teardown: "destroy",
		branch: "ryu/conv-123",
		commitMessage: "Changes from Ryu cloud task",
		openPullRequest: true,
		draft: false,
		pullRequestBody: description,
	});
});

test("a blank pull request description is omitted so Core uses its default", async () => {
	await mount();
	const form = await openPushDialog();
	await act(async () => checkboxFor("Open pull request into main").click());
	await settle();
	await act(async () => typeInto(pullRequestBodyField(), "  \n  "));
	await act(async () => form.requestSubmit());
	await settle();
	const finish = calls.find((call) => call.path.endsWith("/finish"));
	expect(finish?.body).not.toHaveProperty("pullRequestBody");
	expect(finish?.body).toHaveProperty("openPullRequest", true);
});

test("an over-long pull request description blocks the push until shortened", async () => {
	await mount();
	const form = await openPushDialog();
	await act(async () => checkboxFor("Open pull request into main").click());
	await settle();
	const body = pullRequestBodyField();
	// Counted in code points like Core: 65,536 astral characters fit.
	await act(async () => typeInto(body, "😀".repeat(65_536)));
	expect(body.getAttribute("aria-invalid")).toBeNull();
	expect(submitButton().disabled).toBe(false);

	await act(async () => typeInto(body, "b".repeat(65_537)));
	expect(body.getAttribute("aria-invalid")).toBe("true");
	expect(form.querySelector("[role='alert']")?.textContent).toContain(
		"Too long: 65,537 of 65,536 characters"
	);
	expect(submitButton().disabled).toBe(true);
	await act(async () => form.requestSubmit());
	await settle();
	expect(calls.some((call) => call.path.endsWith("/finish"))).toBe(false);

	// Unchecking the pull request drops the field, so the push is allowed again.
	await act(async () => checkboxFor("Open pull request into main").click());
	await settle();
	expect(form.querySelector("textarea")).toBeNull();
	expect(submitButton().disabled).toBe(false);
	await act(async () => form.requestSubmit());
	await settle();
	const finish = calls.find((call) => call.path.endsWith("/finish"));
	expect(finish?.body).not.toHaveProperty("pullRequestBody");
	expect(finish?.body).not.toHaveProperty("openPullRequest");
});

test("opening a pull request sends the PR fields and links the result", async () => {
	finishReply = () =>
		Response.json({
			finish: { ...pushedFinish, pullRequest, pullRequestError: null },
		});
	await mount();
	const form = await openPushDialog();
	expect(document.querySelector("form")?.textContent).not.toContain(
		"Pull request title"
	);
	await act(async () => checkboxFor("Open pull request into main").click());
	await settle();
	await act(async () => checkboxFor("Open as draft").click());
	await settle();
	const titleLabel = [...document.querySelectorAll("label")].find(
		(candidate) => candidate.textContent === "Pull request title"
	);
	const title = titleLabel ? document.getElementById(titleLabel.htmlFor) : null;
	if (!(title instanceof HTMLInputElement)) {
		throw new Error("Missing pull request title");
	}
	await act(async () => typeInto(title, "  Fix the parser  "));
	await act(async () => form.requestSubmit());
	await settle();
	const finish = calls.find((call) => call.path.endsWith("/finish"));
	expect(finish?.body).toEqual({
		push: true,
		teardown: "destroy",
		branch: "ryu/conv-123",
		commitMessage: "Changes from Ryu cloud task",
		openPullRequest: true,
		draft: true,
		pullRequestTitle: "Fix the parser",
	});
	const link = document.querySelector<HTMLAnchorElement>(
		`a[href="${pullRequest.url}"]`
	);
	expect(link?.textContent).toContain("#7");
	expect(link?.target).toBe("_blank");
	expect(link?.rel).toBe("noopener noreferrer");
	expect(
		document.querySelector(`a[href="${pushedFinish.compareUrl}"]`)
	).toBeNull();
});

test("a task without a starting branch cannot open a pull request", async () => {
	statusReply = () => Response.json(task({ baseBranch: null }));
	await mount();
	const form = await openPushDialog();
	const checkbox = checkboxFor("Open pull request (needs a starting branch)");
	expect(
		checkbox.getAttribute("aria-disabled") === "true" ||
			checkbox.hasAttribute("data-disabled") ||
			(checkbox as HTMLButtonElement).disabled === true
	).toBe(true);
	await act(async () => form.requestSubmit());
	await settle();
	const finish = calls.find((call) => call.path.endsWith("/finish"));
	expect(finish?.body).not.toHaveProperty("openPullRequest");
});

test("a finish with a pull request links it instead of the compare view", async () => {
	statusReply = () =>
		Response.json(
			task({
				finish: { ...pushedFinish, pullRequest, pullRequestError: null },
			})
		);
	const container = await mount();
	const links = [...container.querySelectorAll<HTMLAnchorElement>("a")];
	expect(links.map((link) => link.href)).toEqual([pullRequest.url]);
	expect(links[0]?.textContent).toContain("Pull request #7");
	expect(links[0]?.rel).toBe("noopener noreferrer");
});

test("a failed pull request keeps the compare link and explains why", async () => {
	statusReply = () =>
		Response.json(
			task({
				finish: {
					...pushedFinish,
					teardown: "kept",
					pullRequest: null,
					pullRequestError: "already_exists",
				},
			})
		);
	const container = await mount();
	expect(container.textContent).toContain(
		"Pull request not opened: a pull request for this branch already exists."
	);
	const link = container.querySelector<HTMLAnchorElement>("a");
	expect(link?.href).toBe(pushedFinish.compareUrl);
});

function taskBox(overrides: Record<string, unknown> = {}) {
	return {
		id: "box-1",
		size: "small",
		state: "ready",
		source: "cloud_task",
		child: null,
		placement: null,
		desktop: { ready: true, viewers: 0 },
		runningSince: new Date().toISOString(),
		runningSeconds: 1080,
		accruedMicroUsd: 12_300,
		ratePerHourMicroUsd: 41_000,
		balanceMicroUsd: 5_000_000,
		minutesRemaining: 400,
		warning: "none",
		stopReason: null,
		expiresAt: null,
		...overrides,
	};
}

test("a Box task shows its cost chip and View screen opens the Box screen tab", async () => {
	statusReply = () =>
		Response.json(task({ box: taskBox(), caps: { running: 1, max: 3 } }));
	const { useSessionBoxScreenRequest } = await import(
		"@/src/hooks/useSessionBox.ts"
	);
	let seen: { child: number | null; conversationId: string } | null = null;
	function Probe() {
		seen = useSessionBoxScreenRequest(conversationId);
		return null;
	}
	const container = await mount();
	const probe = document.createElement("div");
	document.body.append(probe);
	const probeRoot = createRoot(probe);
	roots.push(probeRoot);
	await act(async () => probeRoot.render(<Probe />));
	expect(
		container.querySelector('[data-testid="box-cost-chip"]')?.textContent
	).toBe("$0.0123 · 18 min");
	const view = button("View screen");
	expect(view.disabled).toBe(false);
	await act(async () => view.click());
	expect(seen).toMatchObject({ conversationId, child: null });
});

test("the live session Box status wins over the settled task's snapshot", async () => {
	statusReply = () => Response.json(task({ box: taskBox() }));
	sessionBoxReply = () =>
		Response.json({
			conversationId,
			box: taskBox({ runningSeconds: 3900, accruedMicroUsd: 44_000 }),
			children: [],
			caps: null,
		});
	const container = await mount();
	expect(
		container.querySelector('[data-testid="box-cost-chip"]')?.textContent
	).toBe("$0.0440 · 1 h 05 min");
});

test("low and critical credit warnings render on the strip", async () => {
	statusReply = () =>
		Response.json(
			task({ box: taskBox({ warning: "low", minutesRemaining: 9 }) })
		);
	let container = await mount();
	expect(container.textContent).toContain("about 9 min of Box time left");
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	client.clear();
	statusReply = () =>
		Response.json(
			task({ box: taskBox({ warning: "critical", minutesRemaining: 2 }) })
		);
	container = await mount();
	expect(
		container
			.querySelector('[data-testid="box-credit-banner"]')
			?.getAttribute("role")
	).toBe("alert");
});

test("a task stopped at exhaustion names the reason and offers Top up", async () => {
	statusReply = () =>
		Response.json(
			task({
				state: "stopped",
				box: taskBox({ state: "parked", stopReason: "balance" }),
			})
		);
	const container = await mount();
	expect(container.textContent).toContain("Stopped · out of credits");
	expect(container.textContent).toContain("your credits ran out");
	expect(button("Top up").disabled).toBe(false);
});

test("an older Core's task without a box shows no chip or View screen", async () => {
	const container = await mount();
	expect(container.querySelector('[data-testid="box-cost-chip"]')).toBe(null);
	expect(
		[...container.querySelectorAll("button")].some(
			(candidate) => candidate.textContent?.trim() === "View screen"
		)
	).toBe(false);
});

test("with the box backend flag off, View screen and the chip are hidden", async () => {
	boxBackendFlag = false;
	statusReply = () => Response.json(task({ box: taskBox() }));
	const container = await mount();
	expect(container.querySelector('[data-testid="box-cost-chip"]')).toBe(null);
	expect(
		[...container.querySelectorAll("button")].some(
			(candidate) => candidate.textContent?.trim() === "View screen"
		)
	).toBe(false);
	expect(
		calls.some((call) => call.path.startsWith("/api/session-boxes/"))
	).toBe(false);
});

test("with the flag in its default-on state, View screen is offered", async () => {
	const { featureFlagFallback, CLOUD_TASKS_BOX_BACKEND_FLAG } = await import(
		"@ryu/auth/lib/feature-flags"
	);
	boxBackendFlag = featureFlagFallback(CLOUD_TASKS_BOX_BACKEND_FLAG);
	expect(boxBackendFlag).toBe(true);
	statusReply = () => Response.json(task({ box: taskBox() }));
	await mount();
	expect(button("View screen").disabled).toBe(false);
});

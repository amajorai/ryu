// Actual Layout and ChatPage over native browser HTTP. Core is a finite
// transport fixture: it serves one finished turn whose agent called
// `tasks.suggest`, captures every request the page makes, and never runs a model.
// These cases prove what ChatPage's suggested-task actions send and change.
// Shared setup for the suggested-task specs
// (`chat-page-native-http-task-suggestion*.spec.ts`), split by test group.
import { expect, type Page, type TestInfo } from "@playwright/test";
import {
	assertNativeWindowLifetime,
	persistNativeLifetimeDiagnostics,
} from "./chat-page-native-http-lifetime.ts";
import {
	chatPageControl,
	chatPageState,
} from "./chat-page-native-http-support.ts";

export const ORIGINAL_TITLE = "Toolbar share regression fixture";
export const errors = new WeakMap<Page, string[]>();

export async function load(page: Page, scenario: string, search = "") {
	await chatPageControl(page.request, { action: "reset", scenario });
	await page.setViewportSize({ width: 1480, height: 960 });
	const pageErrors: string[] = [];
	errors.set(page, pageErrors);
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.goto(`/chat-page-native-http.html?scenario=${scenario}${search}`);
}

export const THREAD_TEXT =
	"We need to share the launch plan with the organization.";

export async function open(page: Page, scenario: string, search = "") {
	await load(page, scenario, search);
	await expect(page.getByText(THREAD_TEXT, { exact: true })).toBeVisible();
	await expect(card(page)).toBeVisible();
}

export const card = (page: Page) =>
	page.getByRole("region", { name: "Suggested task", exact: true });
// Shipping title-bar tabs: each wrapper carries `data-active`.
export const tabs = (page: Page) =>
	page.locator("[data-tab-appearance][data-active]");
// The tab whose label, as the strip shows it, is `name`.
export const tabLabel = (page: Page, name: string) =>
	tabs(page).getByRole("button", { name, exact: true });

export interface StreamBody {
	agent_id?: string;
	conversation_id?: string;
	cwd?: string;
	messages?: Array<{
		parts?: Array<{ text?: string; type: string }>;
		role: string;
	}>;
	// `false` on every turn of a temporary chat, left out otherwise.
	persist?: boolean;
	worktree_branch?: string;
	worktree_isolation?: boolean;
}

export async function streamCalls(page: Page) {
	const { calls } = await chatPageState(page.request);
	return calls.filter((call) => call.path === "/api/chat/stream");
}

// The text the composer submitted: the first text part of the newest user
// message in the AI SDK request body.
export function submittedText(body: StreamBody) {
	const users = (body.messages ?? []).filter(
		(message) => message.role === "user"
	);
	return (
		users.at(-1)?.parts?.find((part) => part.type === "text")?.text ?? null
	);
}

export async function draftWrites(page: Page) {
	const { calls } = await chatPageState(page.request);
	return calls.filter(
		(call) => call.method === "POST" && call.path === "/api/drafts/drafts"
	);
}

/** Every spec's afterEach: no page errors, then an owned unmount. */
export async function cleanUpTaskSuggestionPage(
	page: Page,
	testInfo: TestInfo
) {
	try {
		expect(errors.get(page) ?? []).toEqual([]);
		const mounted = await page.evaluate(() => {
			const fixture = Reflect.get(window, "__chatPageNativeFixture");
			if (!fixture) {
				return false;
			}
			fixture.unmount();
			return true;
		});
		if (mounted) {
			await assertNativeWindowLifetime(page);
		}
	} finally {
		await persistNativeLifetimeDiagnostics(testInfo, {});
	}
}

// The name Core and the sidebar give a thread until a model writes one: the
// first line of its first message, capped at 60 characters with an ellipsis.
export function derivedTitle(text: string) {
	const characters = [...(text.trim().split("\n")[0]?.trim() ?? "")];
	return characters.length <= 60
		? characters.join("")
		: `${characters.slice(0, 60).join("")}…`;
}

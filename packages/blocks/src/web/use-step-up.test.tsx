import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { StepUpClient } from "@ryu/step-up";

// Keep the runtime's own fetch primitives: the shared client reads real
// `Response` bodies, which happy-dom's replacements do not settle under Bun.
const natives = {
	AbortController: globalThis.AbortController,
	AbortSignal: globalThis.AbortSignal,
	Headers: globalThis.Headers,
	Request: globalThis.Request,
	Response: globalThis.Response,
	URL: globalThis.URL,
};
const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
	Object.assign(globalThis, natives);
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
// Imported only once the DOM exists: the dialog primitives decide at module
// load whether they are running in a browser.
const { createStepUpClient } = await import("@ryu/step-up");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useStepUp } = await import("./use-step-up.tsx");

// The dialog's presence transitions ask for the element's running animations,
// which happy-dom does not implement: there are none.
if (!("getAnimations" in Element.prototype)) {
	Object.defineProperty(Element.prototype, "getAnimations", {
		configurable: true,
		value: () => [],
	});
}
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

// The step-up API as the prompt sees it: the shared client over a fixture of
// `/api/step-up/*` that answers with the exact bodies the API router sends.
const STATUS = {
	action: "change who can access a workspace",
	enrolmentRequired: false,
	methods: ["otp"],
	satisfied: false,
	scope: "org.members",
	twoFactorEnabled: false,
	windowMs: 600_000,
};
const COOLDOWN_MESSAGE =
	"Please wait 45 seconds before requesting another email.";

function stepUpApi(challengeAnswers: Array<() => Response>) {
	const challenges: string[] = [];
	const fetchFixture: typeof fetch = Object.assign(
		async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (url.pathname === "/api/step-up/status") {
				return Response.json(STATUS);
			}
			if (url.pathname === "/api/step-up/challenge") {
				challenges.push(String(init?.body));
				const answer = challengeAnswers.shift();
				if (!answer) {
					throw new Error("unexpected extra challenge");
				}
				return answer();
			}
			return Response.json({ error: "Not Found" }, { status: 404 });
		},
		{ preconnect() {} }
	);
	const client = createStepUpClient({
		baseUrl: "https://api.example.test",
		fetch: fetchFixture,
	});
	return { challenges, client };
}

function Host({ client }: { client: StepUpClient }) {
	const { dialog, prompt } = useStepUp({ client, onEnrol2fa: () => undefined });
	return (
		<>
			<button onClick={() => void prompt("org.members")} type="button">
				Remove member
			</button>
			{dialog}
		</>
	);
}

const mounted: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of mounted.splice(0)) {
		await dispose();
	}
});

async function mount(client: StepUpClient) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(<Host client={client} />));
	mounted.push(async () => {
		await act(async () => root.unmount());
		container.remove();
	});
}

function button(name: string): HTMLButtonElement {
	const match = [...document.querySelectorAll("button")].find(
		(candidate) => candidate.textContent?.trim() === name
	);
	if (!match) {
		throw new Error(`no "${name}" button`);
	}
	return match;
}

async function click(name: string) {
	await act(async () => {
		button(name).click();
		await Bun.sleep(0);
	});
}

async function waitForText(text: string) {
	const deadline = Date.now() + 2000;
	while (!document.body.textContent?.includes(text)) {
		if (Date.now() > deadline) {
			throw new Error(
				`"${text}" never appeared; the page reads: ${document.body.textContent}`
			);
		}
		await act(async () => {
			await Bun.sleep(10);
		});
	}
}

test("sending the code again inside the email cooldown shows the wait; any other failure keeps the generic retry line", async () => {
	const api = stepUpApi([
		() => Response.json({ sent: true }),
		() =>
			Response.json(
				{ error: COOLDOWN_MESSAGE, retryAfter: 45 },
				{ headers: { "Retry-After": "45" }, status: 429 }
			),
		() => Response.json({ error: "Internal Server Error" }, { status: 500 }),
	]);
	await mount(api.client);

	await click("Remove member");
	await waitForText("Send it again");
	expect(document.body.textContent).not.toContain(COOLDOWN_MESSAGE);

	await click("Send it again");
	await waitForText(COOLDOWN_MESSAGE);
	expect(document.body.textContent).not.toContain(
		"We couldn't send the code. Try again."
	);

	await click("Send it again");
	await waitForText("We couldn't send the code. Try again.");
	expect(document.body.textContent).not.toContain("Internal Server Error");
	expect(document.body.textContent).not.toContain(COOLDOWN_MESSAGE);
	expect(api.challenges).toEqual([
		'{"method":"otp","scope":"org.members"}',
		'{"method":"otp","scope":"org.members"}',
		'{"method":"otp","scope":"org.members"}',
	]);
});

test("a prompt that opens inside the cooldown shows the wait straight away", async () => {
	const api = stepUpApi([
		() =>
			Response.json(
				{ error: COOLDOWN_MESSAGE, retryAfter: 45 },
				{ headers: { "Retry-After": "45" }, status: 429 }
			),
	]);
	await mount(api.client);

	await click("Remove member");
	await waitForText(COOLDOWN_MESSAGE);
	expect(api.challenges).toHaveLength(1);
});

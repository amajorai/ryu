import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The Desktop password dialog holds a new password to the rules sign-up and the
// set-password route enforce (an uppercase letter, a number, a symbol), so a
// password the route would refuse never reaches the identity prompt or the
// request. The settings client, the step-up prompt and the toast are
// stand-ins; the dialog, its form and its validation are the shipping ones.
GlobalRegistrator.register({ url: "https://ryu.test/settings" });
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const setPasswordCalls: string[] = [];
const errorTitles: string[] = [];
let stepUpPrompts = 0;
mock.module("@ryu/settings", () => ({
	settingsApi: {
		user: {
			setPassword: (password: string) => {
				setPasswordCalls.push(password);
				return Promise.resolve();
			},
		},
	},
}));
mock.module("../../StepUpDialog.tsx", () => ({
	useStepUp: () => ({
		dialog: null,
		guard: (_scope: string, action: () => Promise<unknown>) => {
			stepUpPrompts += 1;
			return action();
		},
	}),
}));
mock.module("sileo", () => ({
	sileo: {
		error: ({ title }: { title: string }) => {
			errorTitles.push(title);
		},
		success: () => undefined,
	},
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { PasswordChangeDialog } = await import("./PasswordChangeDialog.tsx");

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
	setPasswordCalls.length = 0;
	errorTitles.length = 0;
	stepUpPrompts = 0;
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root.render(
			createElement(
				QueryClientProvider,
				{ client: new QueryClient() },
				createElement(PasswordChangeDialog, { hasPassword: true })
			)
		)
	);
	const trigger = host.querySelector("button");
	if (!trigger) {
		throw new Error("The dialog trigger did not render");
	}
	await act(async () => trigger.click());
});

afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
});

function field(id: string): HTMLInputElement {
	const input = document.body.querySelector<HTMLInputElement>(`#${id}`);
	if (!input) {
		throw new Error(`Missing field: ${id}`);
	}
	return input;
}

async function fill(id: string, value: string) {
	const input = field(id);
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function submit() {
	const form = document.body.querySelector("form");
	if (!form) {
		throw new Error("Missing the password form");
	}
	await act(async () => {
		form.dispatchEvent(
			new Event("submit", { bubbles: true, cancelable: true })
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
}

const WEAK_PASSWORDS = [
	["short1!", "Password needs at least 8 characters"],
	["all-lowercase-password-1", "Password needs one uppercase letter"],
	["No-digits-in-this-one", "Password needs one number"],
	["NoSymbolsInThisOne1", "Password needs one symbol"],
	[`Aa1!${"x".repeat(125)}`, "Password must be 128 characters or fewer"],
] as const;

for (const [weak, reason] of WEAK_PASSWORDS) {
	test(`a ${weak.length}-character password the sign-up rules refuse is turned away with "${reason}", before any step-up or request`, async () => {
		await fill("pw-new", weak);
		await fill("pw-confirm", weak);
		await submit();
		expect({
			errors: errorTitles,
			requests: setPasswordCalls,
			stepUps: stepUpPrompts,
		}).toEqual({ errors: [reason], requests: [], stepUps: 0 });
	});
}

test("a password that meets the rules goes through the step-up and is sent once", async () => {
	const strong = "A-replacement-password-123";
	await fill("pw-new", strong);
	await fill("pw-confirm", strong);
	await submit();
	expect({
		errors: errorTitles,
		requests: setPasswordCalls,
		stepUps: stepUpPrompts,
	}).toEqual({ errors: [], requests: [strong], stepUps: 1 });
});

test("two different passwords are refused as a mismatch even when both meet the rules", async () => {
	await fill("pw-new", "A-replacement-password-123");
	await fill("pw-confirm", "A-replacement-password-124");
	await submit();
	expect({
		errors: errorTitles,
		requests: setPasswordCalls,
		stepUps: stepUpPrompts,
	}).toEqual({ errors: ["Passwords do not match"], requests: [], stepUps: 0 });
});

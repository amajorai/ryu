import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ComponentProps, ReactNode } from "react";

// The shell's "open this link?" prompt: what the person is shown, and that only
// a yes resolves true. The dialog parts are replaced by plain elements, so
// these check the prompt's own logic and text, not the dialog library.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

function Part({ children }: { children?: ReactNode }) {
	return <div>{children}</div>;
}
function Press({ children, ...props }: ComponentProps<"button">) {
	return (
		<button type="button" {...props}>
			{children}
		</button>
	);
}
mock.module("@ryu/ui/components/alert-dialog.tsx", () => ({
	AlertDialog: ({ children, open }: { children?: ReactNode; open: boolean }) =>
		open ? <div data-testid="dialog-open">{children}</div> : null,
	AlertDialogAction: Press,
	AlertDialogCancel: Press,
	AlertDialogContent: ({
		children,
		className,
	}: {
		children?: ReactNode;
		className?: string;
	}) => (
		<div className={className} data-testid="open-external-confirm">
			{children}
		</div>
	),
	AlertDialogDescription: Part,
	AlertDialogFooter: Part,
	AlertDialogHeader: Part,
	AlertDialogMedia: Part,
	AlertDialogOverlay: Part,
	AlertDialogPortal: Part,
	AlertDialogTitle: Part,
	AlertDialogTrigger: Press,
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { describeExternalDestination } = await import(
	"@ryu/app-host/open-external-gate"
);
const { OpenExternalDestinationText, useOpenExternalAsk } = await import(
	"./open-external-confirm.tsx"
);
type Ask = ReturnType<typeof useOpenExternalAsk>["ask"];

const LOOKALIKE_HOST =
	"accounts.google.com.signin.session-check.security-update.example-login.net";
const LOOKALIKE_HREF = `https://${LOOKALIKE_HOST}/login?d=${"a".repeat(300)}`;

let ask: Ask | null = null;
function Shell({
	appName,
	showDialog,
}: {
	appName: string;
	showDialog: boolean;
}) {
	const prompt = useOpenExternalAsk(appName);
	ask = prompt.ask;
	return <div>{showDialog ? prompt.dialog : null}</div>;
}

const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
// Each test mounts a fresh prompt (a new key), so the per-frame limit of one
// test never counts the prompts of another.
let generation = 0;
const render = (appName: string, showDialog = true) =>
	act(() => {
		root.render(
			<Shell appName={appName} key={generation} showDialog={showDialog} />
		);
	});
const mount = (appName: string) => {
	generation += 1;
	return render(appName);
};
const find = (testId: string) =>
	container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
/** Start one prompt and let it render. The answer stays pending in the
 *  returned object (an async function would wait for a bare promise). It is
 *  the address the prompt showed after a yes, false after a no, and the
 *  message of a refusal. */
async function raise(
	href: string
): Promise<{ answer: Promise<boolean | string> }> {
	const started: { answer: Promise<boolean | string> } = {
		answer: Promise.resolve("not started"),
	};
	await act(() => {
		started.answer = ask
			? ask({ href }).then(
					(shown) => (shown ? shown.href : false),
					(error: Error) => error.message
				)
			: Promise.resolve("no ask");
	});
	return started;
}

afterEach(async () => {
	// Close whatever a test left open, so the shell-wide lock is free again.
	await act(() => {
		find("open-external-cancel")?.click();
	});
});
afterAll(async () => {
	await act(() => {
		root.unmount();
	});
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

test("the address line holds the scheme and the whole host of a lookalike address", () => {
	const destination = describeExternalDestination(LOOKALIKE_HREF);
	if (!destination) {
		throw new Error("the address was refused");
	}
	const markup = renderToStaticMarkup(
		<OpenExternalDestinationText destination={destination} />
	);
	expect(markup).toContain("https://");
	expect(markup).toContain(`>${LOOKALIKE_HOST}</strong>`);
	// It wraps instead of cutting, and nothing clips it.
	expect(markup).toContain("break-all");
	expect(markup).not.toContain("truncate");
	expect(markup).not.toContain("line-clamp");
});

test("the prompt names the app and the whole host, and a yes resolves to the address shown", async () => {
	await mount("Notes");
	expect(find("dialog-open")).toBeNull();
	const { answer } = await raise(LOOKALIKE_HREF);
	const text = find("open-external-confirm")?.textContent ?? "";
	expect(text).toContain("“Notes” wants to open this address in your browser.");
	expect(text).toContain(`https://${LOOKALIKE_HOST}/login?d=`);
	expect(find("open-external-host")?.textContent).toBe(LOOKALIKE_HOST);
	await act(() => {
		find("open-external-accept")?.click();
	});
	expect(await answer).toBe(LOOKALIKE_HREF);
	expect(find("dialog-open")).toBeNull();
});

test("Cancel resolves false and comes before the accept button", async () => {
	await mount("Notes");
	const { answer } = await raise("https://example.com/x");
	const buttons = [...container.querySelectorAll("button")].map((button) =>
		button.getAttribute("data-testid")
	);
	expect(buttons).toEqual(["open-external-cancel", "open-external-accept"]);
	await act(() => {
		find("open-external-cancel")?.click();
	});
	expect(await answer).toBe(false);
});

test("a second call while the prompt is open raises no second prompt", async () => {
	await mount("Notes");
	const first = await raise("https://example.com/1");
	const second = await raise("https://example.com/2");
	expect(await second.answer).toBe(
		"ui.openExternal is waiting for an answer to an earlier link"
	);
	expect(find("open-external-host")?.textContent).toBe("example.com");
	expect(find("open-external-confirm")?.textContent).toContain("/1");
	await act(() => {
		find("open-external-cancel")?.click();
	});
	expect(await first.answer).toBe(false);
});

test("a prompt whose dialog leaves the tree is answered no, and none opens without it", async () => {
	await mount("Notes");
	const open = await raise("https://example.com/x");
	await render("Notes", false);
	expect(await open.answer).toBe(false);
	const unseen = await raise("https://example.com/y");
	expect(await unseen.answer).toBe(false);
	expect(find("dialog-open")).toBeNull();
});

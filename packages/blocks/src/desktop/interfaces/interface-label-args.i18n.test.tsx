import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import type {
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

/*
 * A word or name that goes into a translated sentence is translated first:
 * German readers get "Avatar von Du", never "Avatar von You", and
 * "In Arbeit, 2 aktiv", never "Working, 2 aktiv".
 */

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { WorkspaceRail } = await import("./channels-sidebar.tsx");
const { FeedNavRail } = await import("./feed-nav.tsx");
const { TablePot } = await import("./card-table-pot.tsx");
const { YOU } = await import("./feed-parts.tsx");

const DE: Record<string, string> = {
	"{count, plural, one {# thread} other {# threads}}":
		"{count, plural, one {# Thread} other {# Threads}}",
	"{label}, {workingCount} running": "{label}, {workingCount} aktiv",
	"{name} avatar": "Avatar von {name}",
	"Pot: {threads} {word}. Show them": "Pott: {threads} {word}. Anzeigen",
	running: "aktiv",
	Working: "In Arbeit",
	You: "Du",
};

let mounted: { container: HTMLElement; root: Root } | undefined;
afterEach(async () => {
	registerLiteralCatalogLoader(null);
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => {
			root.unmount();
		});
		container.remove();
		mounted = undefined;
	}
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function renderIn(
	locale: string,
	element: ReactElement
): Promise<HTMLElement> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("de") ? DE : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				{element}
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return container;
}

const labels = (container: HTMLElement, selector: string) =>
	[...container.querySelectorAll(selector)].map((node) =>
		node.getAttribute("aria-label")
	);

test("your avatar in the workspace rail is named in German", async () => {
	const container = await renderIn(
		"de",
		<WorkspaceRail onHome={() => undefined} threadOpen={false} />
	);
	expect(labels(container, '[role="img"][aria-label$="Du"]')).toContain(
		"Avatar von Du"
	);
	expect(container.innerHTML).not.toContain("Avatar von You");
});

test("the feed's working tab names its translated label", async () => {
	const container = await renderIn(
		"de",
		<FeedNavRail
			onPost={() => undefined}
			onSelect={() => undefined}
			view="home"
			workingCount={2}
		/>
	);
	expect(labels(container, "nav button")).toContain("In Arbeit, 2 aktiv");
});

test("the feed's own author name follows the active language", async () => {
	await renderIn("de", <span />);
	expect(YOU.name).toBe("Du");
});

function thread(id: string): InterfaceThread {
	return {
		agentIds: [],
		id,
		lastMessage: null,
		lastMessageRole: "assistant",
		messageCount: 2,
		pinned: false,
		projectId: null,
		running: true,
		teamId: null,
		title: id,
		updatedAt: new Date().toISOString(),
	};
}

test("the pot's default word is translated", async () => {
	const running = [thread("one")];
	const container = await renderIn(
		"de",
		<TablePot
			activeThreadId={null}
			compact
			next={undefined}
			now={Date.now()}
			onOpen={() => undefined}
			pileSize={24}
			running={running}
			snapshot={
				{
					agents: [],
					asks: [],
					events: [],
					threads: running,
				} as unknown as InterfaceSnapshot
			}
		/>
	);
	expect(container.innerHTML).toContain("Pott: 1 Thread aktiv. Anzeigen");
});

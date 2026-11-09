import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The Weekly schedule's picker chooses a day of the week, not a calendar day.
// "Day" is the calendar-day key (the Day view, a date's day field), so the
// picker must be labelled "Day of week" or locales that tell the two apart
// (ja 日 vs 曜日) name it wrongly.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// The dialog's data hooks are stand-ins so this stays a network-free DOM test.
const realAgents = await import("@/src/hooks/useAgents.ts");
mock.module("@/src/hooks/useAgents.ts", () => ({
	...realAgents,
	useAgents: () => ({
		agents: [
			{ id: "agent-release", lifecycleStatus: "active", name: "Release" },
		],
	}),
}));
const realActiveNode = await import("@/src/hooks/useActiveNode.ts");
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	...realActiveNode,
	useActiveNode: () => ({
		name: "Synthetic node",
		token: "synthetic-node",
		url: "http://127.0.0.1:7982",
		userJwt: null,
	}),
}));
const realChatHistory = await import("@/src/contexts/ChatHistoryContext.tsx");
mock.module("@/src/contexts/ChatHistoryContext.tsx", () => ({
	...realChatHistory,
	useChatHistoryContext: () => ({ conversations: [] }),
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { NewAutomationDialog } = await import("./NewAutomationDialog.tsx");

const JA: Record<string, string> = {
	Day: "日",
	"Day of week": "曜日",
};

let unmount: (() => Promise<void>) | undefined;

afterEach(async () => {
	await unmount?.();
	unmount = undefined;
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function settle(): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
}

/** Opens the dialog in `locale`, switches it to Weekly and returns the
 *  weekday picker. */
async function weeklyDayPicker(locale: string): Promise<HTMLSelectElement> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("ja") ? JA : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<NewAutomationDialog
					onCreated={() => undefined}
					onOpenChange={() => undefined}
					open
				/>
			</I18nProvider>
		);
	});
	unmount = async () => {
		await act(async () => root.unmount());
		container.remove();
	};
	await settle();
	const schedule = document.getElementById("automation-schedule");
	if (!(schedule instanceof HTMLSelectElement)) {
		throw new Error("the Schedule picker did not render");
	}
	await act(async () => {
		schedule.value = "weekly";
		schedule.dispatchEvent(new Event("change", { bubbles: true }));
	});
	await settle();
	const picker = document.getElementById("automation-weekly-day");
	if (!(picker instanceof HTMLSelectElement)) {
		throw new Error("the weekday picker did not render");
	}
	return picker;
}

function accessibleName(control: HTMLSelectElement): string {
	return [...control.labels]
		.map((label) => label.textContent?.trim() ?? "")
		.join(" ");
}

test("the weekly weekday picker is named Day of week", async () => {
	const picker = await weeklyDayPicker("en");
	expect(accessibleName(picker)).toBe("Day of week");
	expect(picker.value).toBe("monday");
});

test("the weekday picker uses the day-of-week sense in Japanese", async () => {
	const picker = await weeklyDayPicker("ja");
	expect(accessibleName(picker)).toBe("曜日");
	expect(accessibleName(picker)).not.toBe("日");
});

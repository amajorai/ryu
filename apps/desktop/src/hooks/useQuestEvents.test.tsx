import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

interface Shown {
	body: string;
	tag: string;
	title: string;
}
interface Toasted {
	description?: string;
	title: string;
}

const notifications: Shown[] = [];
const toasts: Toasted[] = [];
let emit: (event: unknown) => void = () => undefined;

mock.module("./useActiveNode.ts", () => ({
	useActiveNode: () => ({ url: "http://127.0.0.1:7980", token: "t" }),
}));
mock.module("@/src/lib/api/quests.ts", () => ({
	streamQuestEvents: (
		_target: unknown,
		onEvent: (event: unknown) => void,
		signal: AbortSignal
	) => {
		emit = onEvent;
		return new Promise<void>((resolve) => {
			signal.addEventListener("abort", () => resolve());
		});
	},
}));
mock.module("@/src/lib/notifications/os-notify.ts", () => ({
	showOsNotification: (input: Shown) => {
		notifications.push(input);
		return Promise.resolve();
	},
}));
mock.module("@ryu/ui/components/sileo.tsx", () => ({
	toast: {
		info: (input: Toasted) => toasts.push(input),
		success: (input: Toasted) => toasts.push(input),
	},
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { useQuestEvents } = await import("./useQuestEvents.ts");

const JA: Record<string, string> = {
	"Finished “{title}”?": "「{title}」は完了しましたか?",
	"Looks done: {title}": "完了したようです: {title}",
	"Done: {title}": "完了: {title}",
	"Auto-completed: {title}": "自動完了: {title}",
	"Ryu detected this task as finished.":
		"Ryu がこのタスクの完了を検出しました。",
	"Detected from your activity.": "アクティビティから検出しました。",
};

function Subscriber() {
	useQuestEvents();
	return null;
}

async function mountInJapanese(): Promise<() => Promise<void>> {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	const root = createRoot(document.createElement("div"));
	await act(async () => {
		root.render(
			<QueryClientProvider client={new QueryClient()}>
				<I18nProvider
					autoLocalizeDom={false}
					initialLocale="ja"
					initialPackId={null}
				>
					<Subscriber />
				</I18nProvider>
			</QueryClientProvider>
		);
	});
	return async () => {
		await act(async () => root.unmount());
	};
}

afterEach(() => {
	registerLiteralCatalogLoader(null);
	notifications.length = 0;
	toasts.length = 0;
});

test("a suggested quest raises a translated OS notification and toast", async () => {
	const unmount = await mountInJapanese();
	try {
		await act(async () => {
			emit({
				type: "suggested",
				quest: { id: "q1", title: "請求書" },
				reason: "メールを送信しました",
			});
		});
		expect(notifications).toEqual([
			{
				title: "「請求書」は完了しましたか?",
				body: "メールを送信しました",
				tag: "quest-q1",
			},
		]);
		expect(toasts[0]?.title).toBe("完了したようです: 請求書");
	} finally {
		await unmount();
	}
});

test("an auto-completed quest translates the banner title, body and toast", async () => {
	const unmount = await mountInJapanese();
	try {
		await act(async () => {
			emit({ type: "completed", auto: true, quest: { id: "q2", title: "X" } });
		});
		expect(notifications).toEqual([
			{
				title: "完了: X",
				body: "Ryu がこのタスクの完了を検出しました。",
				tag: "quest-q2",
			},
		]);
		expect(toasts).toEqual([
			{ title: "自動完了: X", description: "アクティビティから検出しました。" },
		]);
	} finally {
		await unmount();
	}
});

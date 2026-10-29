import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
// The machine runs in Los Angeles (west of UTC); the person reads dates in
// Tokyo. Each label below differs between those two zones.
const machineZone = process.env.TZ;
process.env.TZ = "America/Los_Angeles";
const { createRoot } = await import("react-dom/client");
const { createPlateEditor, Plate } = await import("platejs/react");
const ui = "../../../../packages/ui/src";
const { CommentKit } = await import(
	`${ui}/components/editor/plugins/comment-kit.tsx`
);
const { SuggestionKit } = await import(
	`${ui}/components/editor/plugins/suggestion-kit.tsx`
);
const { DiscussionKit } = await import(
	`${ui}/components/editor/plugins/discussion-kit.tsx`
);
const { DateKit } = await import(
	`${ui}/components/editor/plugins/date-kit.tsx`
);
const { useBlockDiscussionItems } = await import(
	"@ryu/ui/lib/block-discussion-index.ts"
);
const { nextDisplayDayBoundaryMs, resetTimezone, setTimezonePreference } =
	await import("@ryu/ui/lib/timezone.ts");

// Tokyo midnight starting Monday 9 March 2026 (no DST in Tokyo).
const TOKYO_MIDNIGHT = Date.parse("2026-03-08T15:00:00.000Z");
const BLOCK = [0];
const suggestedDates = ["2026-03-07", "2026-03-08", "2026-03-09", "2026-03-01"];

function documentValue() {
	return [
		{
			type: "p",
			children: [
				{ text: "Due " },
				...suggestedDates.flatMap((date, index) => [
					{
						type: "date",
						date,
						suggestion: true,
						[`suggestion_s${index}`]: {
							id: `s${index}`,
							createdAt: index + 1,
							type: "insert",
							userId: "local-user",
						},
						children: [{ text: "" }],
					},
					{ text: " " },
				]),
			],
		},
	];
}

function SuggestionTexts() {
	const { resolvedSuggestions } = useBlockDiscussionItems(BLOCK);
	return (
		<output>
			{JSON.stringify(
				resolvedSuggestions.map((suggestion) =>
					suggestion.type === "insert" ? suggestion.newText : suggestion.type
				)
			)}
		</output>
	);
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	container?.remove();
	container = undefined;
	setSystemTime();
	resetTimezone();
	document.documentElement.style.removeProperty("--ryu-locale");
});
afterAll(() => {
	if (machineZone === undefined) {
		delete process.env.TZ;
	} else {
		process.env.TZ = machineZone;
	}
});

test("suggested date chips read relative to the display zone's civil today, keep their civil date, and roll over at its midnight", async () => {
	document.documentElement.style.setProperty("--ryu-locale", "en-US");
	setTimezonePreference("Asia/Tokyo");
	setSystemTime(TOKYO_MIDNIGHT - 80);
	expect(nextDisplayDayBoundaryMs(TOKYO_MIDNIGHT - 80)).toBe(TOKYO_MIDNIGHT);
	const value = documentValue();
	const original = JSON.stringify(value);
	const editor = createPlateEditor({
		plugins: [...CommentKit, ...SuggestionKit, ...DiscussionKit, ...DateKit],
		value,
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => {
		root?.render(
			<Plate editor={editor}>
				<SuggestionTexts />
			</Plate>
		);
	});
	const texts = () => JSON.parse(container?.textContent ?? "null");
	// Sunday 8 March, 23:59 in Tokyo (07:59 that Sunday in Los Angeles).
	expect(texts()).toEqual(["Yesterday", "Today", "Tomorrow", "March 1, 2026"]);
	// Only the clock crosses Tokyo midnight; the document is not edited.
	await act(async () => {
		setSystemTime(TOKYO_MIDNIGHT + 1);
		await new Promise((resolve) => setTimeout(resolve, 120));
	});
	expect(texts()).toEqual([
		"March 7, 2026",
		"Yesterday",
		"Today",
		"March 1, 2026",
	]);
	expect(JSON.stringify(editor.children)).toBe(original);
});

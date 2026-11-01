// A paid unlock plays the achievement cue next to its success toast; a refused
// one stays silent and keeps the error toast.

import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let refusal: Error | null = null;
mock.module("@/src/lib/api/profile.ts", () => ({
	unlockFeature: (key: string) =>
		refusal
			? Promise.reject(refusal)
			: Promise.resolve({ key, pointsBalance: 934 }),
}));
const toasts: string[] = [];
mock.module("sileo", () => ({
	sileo: {
		error: ({ title }: { title: string }) => toasts.push(`error:${title}`),
		success: ({ title, description }: { title: string; description: string }) =>
			toasts.push(`success:${title}:${description}`),
	},
}));

const { __setSoundSinkForTests } = await import(
	"@/src/lib/sounds/play-sound.ts"
);
const { useUnlockFeatureMutation } = await import(
	"./StatsTab-unlock-mutation.ts"
);

const cues: { gesture?: boolean; id: string }[] = [];
let mutation: ReturnType<typeof useUnlockFeatureMutation> | null = null;
let root: Root | null = null;
const queryClient = new QueryClient();

function Harness() {
	mutation = useUnlockFeatureMutation();
	return null;
}

async function unlock(key: string) {
	await act(async () => {
		await mutation?.mutateAsync(key).catch(() => undefined);
		// React Query flushes observer updates on a timer; settle them in act.
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

beforeEach(() => {
	refusal = null;
	toasts.length = 0;
	cues.length = 0;
	__setSoundSinkForTests((id, options) => {
		cues.push({ gesture: options.gesture, id });
	});
	if (!root) {
		root = createRoot(document.createElement("div"));
		act(() => {
			root?.render(
				<QueryClientProvider client={queryClient}>
					<Harness />
				</QueryClientProvider>
			);
		});
	}
});

afterAll(() => {
	act(() => root?.unmount());
	__setSoundSinkForTests(null);
});

test("a successful unlock toasts the balance and plays the achievement cue", async () => {
	await unlock("custom-themes");
	expect(toasts).toEqual(["success:Feature unlocked:934 points remaining"]);
	expect(cues).toEqual([{ gesture: true, id: "achievement" }]);
});

test("a refused unlock reports the reason without a cue", async () => {
	refusal = new Error("Points are frozen during review");
	await unlock("custom-themes");
	expect(toasts).toEqual(["error:Points are frozen during review"]);
	expect(cues).toEqual([]);
});

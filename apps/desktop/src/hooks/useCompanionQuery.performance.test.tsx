import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { useQuery } from "@ryu/ui/hooks/use-query.ts";
import { act } from "react";
import { createRoot } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const container = document.createElement("div");
let root = createRoot(container);
let latest: ReturnType<typeof useQuery<string>>;
const pending: Array<{ key: string; resolve: (value: string) => void }> = [];
let visibility: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", {
	configurable: true,
	get: () => visibility,
});
function Harness({
	queryKey = "one",
	refetchInterval = 15,
}: {
	queryKey?: string;
	refetchInterval?: number;
}) {
	latest = useQuery({
		queryKey: [queryKey],
		queryFn: () =>
			new Promise<string>((resolve) =>
				pending.push({ key: queryKey, resolve })
			),
		refetchInterval,
	});
	return null;
}
const tick = async (ms = 50) => {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});
};
afterEach(async () => {
	await act(async () => root.unmount());
	root = createRoot(container);
	pending.length = 0;
	visibility = "visible";
});

test("slow bridge requests settle without being superseded by interval polls", async () => {
	await act(async () => root.render(<Harness />));
	await tick(80);
	expect(pending).toHaveLength(1);
	expect(latest.isLoading).toBe(true);
	await act(async () => pending[0].resolve("first result"));
	expect(latest.data).toBe("first result");
	expect(latest.isLoading).toBe(false);
	await tick(25);
	expect(pending).toHaveLength(2);
});
test("manual refresh wins over pending work and key changes discard old responses", async () => {
	await act(async () => root.render(<Harness />));
	await act(async () => {
		void latest.refetch();
	});
	expect(pending).toHaveLength(2);
	await act(async () => pending[0].resolve("stale"));
	expect(latest.data).toBeUndefined();
	await act(async () => pending[1].resolve("manual"));
	expect(latest.data).toBe("manual");
	await act(async () => root.render(<Harness queryKey="two" />));
	const second = pending.at(-1)!;
	await act(async () => root.render(<Harness queryKey="three" />));
	await act(async () => second.resolve("wrong key"));
	expect(latest.data).not.toBe("wrong key");
	await act(async () => pending.at(-1)!.resolve("current key"));
	expect(latest.data).toBe("current key");
});
test("hidden documents stop automatic polling and resume with one fresh read", async () => {
	await act(async () => root.render(<Harness />));
	visibility = "hidden";
	await act(async () => pending[0].resolve("ready"));
	await tick(70);
	expect(pending).toHaveLength(1);
	visibility = "visible";
	await act(async () => document.dispatchEvent(new Event("visibilitychange")));
	expect(pending).toHaveLength(2);
	await tick(60);
	expect(pending).toHaveLength(2);
});

test("awaiting manual refresh waits for the post-mutation read", async () => {
	await act(async () => root.render(<Harness refetchInterval={0} />));
	await act(async () => pending[0].resolve("before mutation"));
	let finished = false;
	let completion = Promise.resolve();
	await act(async () => {
		completion = latest.refetch().then(() => {
			finished = true;
		});
	});
	expect(finished).toBe(false);
	await act(async () => {
		pending.at(-1)!.resolve("after mutation");
		await completion;
	});
	expect(finished).toBe(true);
	expect(latest.data).toBe("after mutation");
});

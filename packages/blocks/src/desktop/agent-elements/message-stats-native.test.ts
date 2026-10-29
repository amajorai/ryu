import { expect, test } from "bun:test";
import type { UIMessage } from "ai";
import {
	extractGenerationStats,
	extractNativeAcpUsage,
} from "./message-stats-native.ts";
import type { NativeTokenOperand } from "./native-token-count.mjs";

test("generation stats retain independent legacy fields and native metadata identity", () => {
	const payload = {
		tokensPerSecond: Number.NaN,
		promptTokens: "0012",
		cachedTokens: false,
		metadata: new Map([["future", new Date(0)]]),
		get unrelated() {
			throw new Error("provider metadata must remain unread");
		},
	};
	const message: Pick<UIMessage, "parts"> = {
		parts: [{ type: "data-ryu-stats", data: payload }],
	};
	const stats = extractGenerationStats(message);
	expect(Object.is(stats, payload)).toBe(true);
	expect(stats?.promptTokens).toBe("0012");
	expect(stats?.cachedTokens).toBe(false);
});

test("the first ACP usage frame retains native fields and controls absent-frame fallback", () => {
	const emptyFirst: Pick<UIMessage, "parts"> = {
		parts: [
			{ type: "data-acp-usage", data: false },
			{ type: "data-acp-usage", data: { used: 42 } },
		],
	};
	expect(extractNativeAcpUsage(emptyFirst)).toBeNull();
	class NativeUsage {
		get used() {
			return "0012";
		}
		get metadata() {
			throw new Error("native metadata must remain unread");
		}
	}
	const payload = new NativeUsage();
	const native: Pick<UIMessage, "parts"> = {
		parts: [{ type: "data-acp-usage", data: payload }],
	};
	const usage = extractNativeAcpUsage(native);
	expect(Object.is(usage, payload)).toBe(true);
	expect(usage?.used).toBe("0012");
});

test("inherited primitive field getters retain their raw native receiver", () => {
	const payload = "0012";
	const descriptor = Object.getOwnPropertyDescriptor(
		String.prototype,
		"tokensPerSecond"
	);
	const receivers: boolean[] = [];
	try {
		Object.defineProperty(String.prototype, "tokensPerSecond", {
			configurable: true,
			get(this: NativeTokenOperand) {
				receivers.push(Object.is(this, payload));
				return 5;
			},
		});
		const generation: Pick<UIMessage, "parts"> = {
			parts: [{ type: "data-ryu-stats", data: payload }],
		};
		const stats = extractGenerationStats(generation);
		expect(Object.is(stats, payload)).toBe(true);
		expect(receivers).toEqual([true]);
		const acp: Pick<UIMessage, "parts"> = {
			parts: [{ type: "data-acp-usage", data: payload }],
		};
		const usage = extractNativeAcpUsage(acp);
		expect(Object.is(usage, payload)).toBe(true);
		expect(usage?.tokensPerSecond).toBe(5);
		expect(receivers).toEqual([true, true]);
	} finally {
		if (descriptor) {
			Object.defineProperty(String.prototype, "tokensPerSecond", descriptor);
		} else {
			Reflect.deleteProperty(String.prototype, "tokensPerSecond");
		}
	}
});

test("mutable generation part data retains the native second-read null error", () => {
	let reads = 0;
	const message: Pick<UIMessage, "parts"> = {
		parts: [
			{
				type: "data-ryu-stats",
				get data() {
					reads += 1;
					return reads === 1 ? { tokensPerSecond: 5 } : null;
				},
			},
		],
	};
	expect(() => extractGenerationStats(message)).toThrow(TypeError);
	expect(reads).toBe(2);
});

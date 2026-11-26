import { describe, expect, it } from "bun:test";
import { parseRyuDeepLink } from "./deep-link.ts";

// Security sweep 19 Nov 2026, finding DT-1: a `ryu://chat/new?project=` link
// must not carry a Windows network or device path to the desktop, which would
// hand it to Core's folder probe before anyone confirms anything.
const projectOf = (raw: string) => {
	const intent = parseRyuDeepLink(raw);
	if (intent?.kind !== "chat") {
		throw new Error(`not a chat intent: ${raw}`);
	}
	return intent;
};

describe("chat link project", () => {
	it("drops a network or device path and keeps the rest of the link", () => {
		for (const project of [
			"%5C%5Chost%5Cshare",
			"%5C%5Chost%40SSL%40443%5Cshare",
			"%2F%2Fhost%2Fshare",
			"%5C%2Fhost%2Fshare",
			"%2F%5Chost%5Cshare",
			"%5C%5C%3F%5CUNC%5Chost%5Cshare",
			"%5C%5C.%5Cpipe%5Cname",
			"%5C%3F%3F%5CUNC%5Chost%5Cshare",
			"%5Croot-relative",
			"%20%20%5C%5Chost%5Cshare",
		]) {
			expect(
				projectOf(`ryu://chat/new?prompt=hi&agent=ryu&project=${project}`)
			).toEqual({
				kind: "chat",
				conversationId: null,
				prompt: "hi",
				agent: "ryu",
				project: null,
			});
		}
	});

	it("keeps a local path on every platform", () => {
		for (const [encoded, decoded] of [
			["%2Fhome%2Fme%2Fapp", "/home/me/app"],
			["C%3A%5CUsers%5Cme%5Capp", "C:\\Users\\me\\app"],
			["C%3A%2FUsers%2Fme%2Fapp", "C:/Users/me/app"],
			["~%2Fapp", "~/app"],
		]) {
			expect(projectOf(`ryu://chat/new?project=${encoded}`).project).toBe(
				decoded
			);
		}
	});
});

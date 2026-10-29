import { expect, test } from "bun:test";
import { readHostedStandaloneAppId } from "./standalone-window.ts";

test("reads only validated hosted standalone app targets", () => {
	expect(
		readHostedStandaloneAppId("?window=standalone-app&appId=%40ryu%2Fexpenses")
	).toBe("@ryu/expenses");
	expect(readHostedStandaloneAppId("?window=tab&appId=%40ryu%2Fexpenses")).toBe(
		""
	);
	expect(
		readHostedStandaloneAppId("?window=standalone-app&appId=../../outside")
	).toBe("");
});

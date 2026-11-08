import { describe, expect, it } from "bun:test";
import {
	isLoginApprovalPushApproval,
	LOGIN_APPROVAL_PUSH_HEADER,
	withLoginApprovalPushMarker,
} from "./login-approval-push-marker.ts";

describe("login-approval push marker", () => {
	it("marks a copy and leaves the caller's headers untouched", () => {
		const original = new Headers({ authorization: "Bearer session" });
		const marked = withLoginApprovalPushMarker(original);
		expect(marked.get(LOGIN_APPROVAL_PUSH_HEADER)).toBe("1");
		expect(marked.get("authorization")).toBe("Bearer session");
		expect(original.has(LOGIN_APPROVAL_PUSH_HEADER)).toBe(false);
	});

	it("detects the marker on either the context headers or the request", () => {
		const marked = withLoginApprovalPushMarker(new Headers());
		expect(isLoginApprovalPushApproval({ headers: marked })).toBe(true);
		expect(
			isLoginApprovalPushApproval({
				request: new Request("http://localhost/", { headers: marked }),
			})
		).toBe(true);
		expect(isLoginApprovalPushApproval({ headers: new Headers() })).toBe(false);
		expect(isLoginApprovalPushApproval({})).toBe(false);
	});
});

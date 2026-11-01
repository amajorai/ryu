import { describe, expect, it } from "bun:test";
import { profileDisplayName } from "../components/pass-studio/paint-profile.ts";
import {
	certificatePassSeed,
	memberPassName,
	passBackdropSeed,
} from "./pass-share.ts";
import { waitlistShareFacts } from "./waitlist-share-facts.ts";

describe("passBackdropSeed", () => {
	it("prefers the handle, then the trimmed name", () => {
		expect(passBackdropSeed({ name: "Jay Doe", username: "jay" })).toBe("jay");
		expect(passBackdropSeed({ name: "  Jay Doe  " })).toBe("Jay Doe");
	});

	it("falls back to the name shared surfaces print for a nameless member", () => {
		// `waitlistShareFacts` sends "Member" for a member with no name and no
		// handle; the queue card hands the pass the blank name itself. Both must
		// land on the same hue.
		const shared = waitlistShareFacts(null, { reserved: null, userName: "  " });
		expect(shared.name).toBe("Member");
		expect(passBackdropSeed({ name: "  ", username: null })).toBe(
			passBackdropSeed(shared)
		);
		expect(passBackdropSeed({ name: "", username: "" })).toBe("Member");
		expect(passBackdropSeed({})).toBe("Member");
	});

	it("seeds from the full name, not a display-clamped one", () => {
		const long = "A".repeat(60);
		expect(passBackdropSeed({ name: long })).toBe(long);
	});
});

describe("memberPassName", () => {
	it("trims and falls back exactly as the profile card does", () => {
		for (const name of [" Bob ", "", "   ", null, undefined, "Alice"]) {
			expect(memberPassName(name)).toBe(profileDisplayName(name));
		}
		expect(memberPassName("  ")).toBe("A Ryu Developer");
	});
});

describe("certificatePassSeed", () => {
	it("trims the holder and falls back to ryu", () => {
		expect(certificatePassSeed(" Ada ")).toBe("Ada");
		expect(certificatePassSeed("  ")).toBe("ryu");
		expect(certificatePassSeed(null)).toBe("ryu");
	});
});

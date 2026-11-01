import { describe, expect, it } from "bun:test";
import { profileDisplayName } from "../components/pass-studio/paint-profile.ts";
import {
	certificatePassSeed,
	memberPassName,
	passBackdropSeed,
	passImageUrl,
	passPageUrl,
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

describe("passPageUrl", () => {
	const origin = "https://ryuhq.com";
	const facts = {
		name: "Jia Wei Ng",
		ref: "938RALFG",
		username: "jiawei",
		joined: "2026-08-17T19:37:19.322Z",
	};

	it("shares the short /pass/CODE form when there is a referral code", () => {
		expect(passPageUrl(facts, origin)).toBe("https://ryuhq.com/pass/938RALFG");
	});

	it("falls back to the long query form without a usable code", () => {
		expect(passPageUrl({ ...facts, ref: null }, origin)).toBe(
			"https://ryuhq.com/pass?name=Jia+Wei+Ng&username=jiawei&joined=2026-08-17T19%3A37%3A19.322Z"
		);
		const unsafe = passPageUrl({ ...facts, ref: "../x" }, origin);
		expect(unsafe).toStartWith("https://ryuhq.com/pass?");
		expect(new URL(unsafe).searchParams.get("ref")).toBe("../x");
	});

	it("keeps the OG image on the long form so its cache key is unchanged", () => {
		expect(passImageUrl(facts)).toBe(
			"/api/og/pass?name=Jia+Wei+Ng&ref=938RALFG&username=jiawei&joined=2026-08-17T19%3A37%3A19.322Z"
		);
	});
});

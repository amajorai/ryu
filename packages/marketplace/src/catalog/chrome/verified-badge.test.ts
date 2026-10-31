// Label rules for the publisher verification badge.
//
// The badge's label is the ONLY thing that distinguishes this axis — is the
// PUBLISHING ORGANIZATION identity-verified, the `org_verified` field — from the
// other two "verified" chips this repo already renders (the web marketplace's
// manifest SIGNATURE chip, which owns the bare wire word `verified` and means
// install trust, and the reviews panel's "Verified purchase"), and from the
// amber "Not reviewed by Ryu" notice it can legitimately sit beside. If it ever
// degrades to a bare "Verified" or — worse — to a bare "Community", the badge is
// still on screen and still looks right, so nothing but these assertions catches
// it. That is why the label lives in an exported pure function rather than
// inline in the JSX: the failure mode is silent otherwise.

import { describe, expect, test } from "bun:test";
import { formatMessage, type LiteralMessage } from "@ryu/i18n";
import { verifiedLabel as verifiedLabelWith } from "./verified-badge.tsx";

const tl: LiteralMessage = (source, values) => formatMessage(source, values);
const verifiedLabel = (tier?: string | null) => verifiedLabelWith(tl, tier);

describe("verifiedLabel", () => {
	test("names the organization axis and qualifies it with the tier", () => {
		expect(verifiedLabel("official")).toBe("Verified organization — Official");
		expect(verifiedLabel("partner")).toBe("Verified organization — Partner");
	});

	test('the "community" TIER never renders as a bare tier word', () => {
		// The one collision worth a test of its own: this tier means "a community
		// organization whose identity we checked", while `origin === "community"`
		// on the same card means "discovered from a GitHub topic and reviewed by
		// nobody". A bare "Community" chip next to the amber not-reviewed alert
		// would read as the second thing.
		const label = verifiedLabel("community");
		expect(label).toBe("Verified organization — Community");
		expect(label.startsWith("Verified organization")).toBe(true);
	});

	test("an unknown tier degrades to the unqualified label, never to nothing", () => {
		// `org_verified_tier` is a plain string precisely so a newer control plane can
		// mint a tier this build has not heard of. Losing the qualifier is fine;
		// losing the check, or printing the raw token, is not.
		expect(verifiedLabel("enterprise-2027")).toBe("Verified organization");
		expect(verifiedLabel("enterprise-2027")).not.toContain("enterprise");
	});

	test("absent / empty tier is safe", () => {
		expect(verifiedLabel()).toBe("Verified organization");
		expect(verifiedLabel(null)).toBe("Verified organization");
		expect(verifiedLabel("   ")).toBe("Verified organization");
	});

	test("the tier match is case- and whitespace-insensitive", () => {
		expect(verifiedLabel(" Official ")).toBe(
			"Verified organization — Official"
		);
	});
});

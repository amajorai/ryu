import { describe, expect, test } from "bun:test";
import {
	type CertificateFaceContent,
	certificateKicker,
	certificateScoreLabel,
	certificateStats,
} from "./paint-certificate.ts";

const base: CertificateFaceContent = {
	holderName: "Ada Lovelace",
	issued: "October 18, 2026",
	issuerName: "Ryu Academy",
	levelName: "Ryu Certified Builder",
	official: true,
	score: 92,
};

describe("certificate face helpers", () => {
	test("score label prints only a finite score", () => {
		expect(certificateScoreLabel(92)).toBe("92/100");
		expect(certificateScoreLabel(87.6)).toBe("88/100");
		expect(certificateScoreLabel(null)).toBeNull();
		expect(certificateScoreLabel(Number.POSITIVE_INFINITY)).toBeNull();
	});

	test("kicker names the provenance", () => {
		expect(certificateKicker(base)).toBe("RYU ACADEMY");
		expect(certificateKicker({ ...base, official: false })).toBe(
			"VERIFIED ON RYU"
		);
	});

	test("stats keep the issuer last and drop missing values", () => {
		expect(certificateStats(base)).toEqual([
			["Score", "92/100"],
			["Issued", "October 18, 2026"],
			["Issued by", "Ryu Academy"],
		]);
		expect(certificateStats({ ...base, issued: null, score: null })).toEqual([
			["Issued by", "Ryu Academy"],
		]);
	});

	test("an empty issuer never prints blank", () => {
		const stats = certificateStats({ ...base, issuerName: "  " });
		expect(stats.at(-1)).toEqual(["Issued by", "Community author"]);
	});
});

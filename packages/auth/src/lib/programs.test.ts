import { describe, expect, it } from "bun:test";
import {
	emailDomain,
	isAcademicEmail,
	normalizePartnerCode,
} from "./programs.ts";

describe("isAcademicEmail", () => {
	it("accepts US .edu and country edu/ac school domains", () => {
		for (const email of [
			"ada@mit.edu",
			"ada@cs.stanford.edu",
			"ada@u.nus.edu.sg",
			"ada@ox.ac.uk",
			"ada@g.ecc.u-tokyo.ac.jp",
			"Ada@Student.UNSW.edu.au",
		]) {
			expect(isAcademicEmail(email)).toBe(true);
		}
	});

	it("accepts reviewed universities outside edu/ac and their subdomains", () => {
		expect(isAcademicEmail("ada@ethz.ch")).toBe(true);
		expect(isAcademicEmail("ada@student.ethz.ch")).toBe(true);
		expect(isAcademicEmail("ada@notethz.ch")).toBe(false);
	});

	it("refuses consumer mailboxes, alumni forwarding and bare registries", () => {
		for (const email of [
			"ada@gmail.com",
			"ada@googlemail.com",
			"ada@outlook.com",
			"ada@icloud.com",
			"ada@alumni.stanford.edu",
			"ada@edu.sg",
			"ada@ac.uk",
			"ada@company.com",
			"ada@school.edu.example",
		]) {
			expect(isAcademicEmail(email)).toBe(false);
		}
	});

	it("refuses malformed addresses", () => {
		for (const email of ["", "mit.edu", "ada@", "@mit.edu", "ada@mit..edu"]) {
			expect(isAcademicEmail(email)).toBe(false);
		}
		expect(emailDomain("  Ada@MIT.edu ")).toBe("mit.edu");
	});
});

describe("normalizePartnerCode", () => {
	it("upper-cases and strips spaces from a typed code", () => {
		expect(normalizePartnerCode(" block71-7kq2xm ")).toBe("BLOCK71-7KQ2XM");
		expect(normalizePartnerCode("yc w26")).toBe("YCW26");
	});

	it("refuses anything that cannot be a code", () => {
		for (const value of ["", "ab", "-ABCD", "ABCD-", "AB_CD", "A".repeat(41)]) {
			expect(normalizePartnerCode(value)).toBeNull();
		}
	});
});

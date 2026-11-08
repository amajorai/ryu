import { describe, expect, test } from "bun:test";
import { formatMessage } from "./format.ts";
import {
	appendArgument,
	isolateArg,
	isolateLtr,
	stripBidiIsolates,
} from "./format-bidi.ts";

const FSI = "\u2068";
const LRI = "\u2066";
const PDI = "\u2069";

describe("formatMessage bidi isolation", () => {
	test("a handle in Arabic keeps its @ inside the isolate", () => {
		expect(formatMessage("@{handle} محجوز", { handle: "alice" }, "ar")).toBe(
			`${FSI}@alice${PDI} محجوز`
		);
		expect(formatMessage("مراسلة #{label}", { label: "general" }, "ar")).toBe(
			`مراسلة ${FSI}#general${PDI}`
		);
	});

	test("paths and names in RTL sentences are isolated", () => {
		expect(
			formatMessage('"{path}" مسار نسبي', { path: "./agents" }, "ar-EG")
		).toBe(`"${FSI}./agents${PDI}" مسار نسبي`);
		expect(formatMessage("فتح {name}.", { name: "Release v2.4" }, "fa")).toBe(
			`فتح ${FSI}Release v2.4${PDI}.`
		);
	});

	test("bare URLs and emails stay linkable", () => {
		expect(
			formatMessage("أدخل الرمز المرسل إلى {email}.", { email: "a@b.co" }, "ar")
		).toBe("أدخل الرمز المرسل إلى a@b.co.");
		expect(
			formatMessage("من {url}", { url: "https://ryuhq.com/pricing" }, "ar")
		).toBe("من https://ryuhq.com/pricing");
	});

	test("English and German output is byte-identical to before", () => {
		expect(formatMessage("@{handle} is reserved", { handle: "alice" })).toBe(
			"@alice is reserved"
		);
		expect(
			formatMessage("Senden an @{name}", { name: "alice" }, "de").includes(FSI)
		).toBe(false);
		expect(formatMessage('"{path}" ist relativ', { path: "./a" }, "de")).toBe(
			'"./a" ist relativ'
		);
	});

	test("Japanese output is unchanged", () => {
		expect(
			formatMessage("@{handle} は予約済みです", { handle: "alice" }, "ja")
		).toBe("@alice は予約済みです");
		expect(formatMessage("{path} を開く", { path: "./agents" }, "ja-JP")).toBe(
			"./agents を開く"
		);
	});

	test("numbers, plurals, selects and dates are not wrapped", () => {
		expect(formatMessage("{count} ملفات", { count: 3 }, "ar")).toBe("3 ملفات");
		const plural = formatMessage(
			"{count, plural, one {# ملف} other {# ملفات}}",
			{ count: 5 },
			"ar"
		);
		expect(plural.includes(FSI)).toBe(false);
		expect(
			formatMessage(
				"{kind, select, file {ملف} other {مجلد}}",
				{ kind: "file" },
				"ar"
			)
		).toBe("ملف");
		expect(formatMessage("{flag} مفعل", { flag: true }, "ar")).toBe(
			"true مفعل"
		);
	});

	test("a string inside a plural branch is still isolated", () => {
		const output = formatMessage(
			"{count, plural, other {# من {name}}}",
			{ count: 2, name: "bob" },
			"ar"
		);
		expect(output.endsWith(` من ${FSI}bob${PDI}`)).toBe(true);
		expect(output.startsWith(FSI)).toBe(false);
	});

	test("right-to-left text and numeric strings flow without isolates", () => {
		expect(formatMessage("المزيد عن {topic}", { topic: "الكواكب" }, "ar")).toBe(
			"المزيد عن الكواكب"
		);
		expect(formatMessage("{count} طلب سحب", { count: "15" }, "ar")).toBe(
			"15 طلب سحب"
		);
	});

	test("RTL sentences with a Latin name and placeholder echoes stay as they are", () => {
		const nested = "رفض Ryu Core الالتقاط.";
		expect(formatMessage("خطأ: {error}", { error: nested }, "ar")).toBe(
			`خطأ: ${nested}`
		);
		expect(formatMessage("حول {app}", { app: "{app}" }, "ar")).toBe(
			"حول {app}"
		);
		const handles = "@a_bot و@b_bot";
		expect(formatMessage("({list})", { list: handles }, "ar")).toBe(
			`(${handles})`
		);
	});

	test("a message that is the argument alone stays unwrapped", () => {
		expect(formatMessage("{text}", { text: "alice" }, "ar")).toBe("alice");
	});

	test("empty and missing values add nothing", () => {
		expect(formatMessage("مرحبا {name}", { name: "" }, "ar")).toBe("مرحبا ");
		expect(formatMessage("مرحبا {name}", {}, "ar")).toBe("مرحبا ");
	});
});

describe("isolate helpers", () => {
	test("isolateArg wraps only for RTL locales and never twice", () => {
		expect(isolateArg("alice", "ar")).toBe(`${FSI}alice${PDI}`);
		expect(isolateArg(isolateArg("alice", "ar"), "ar")).toBe(
			`${FSI}alice${PDI}`
		);
		expect(isolateArg("alice", "en")).toBe("alice");
		expect(isolateArg("", "ar")).toBe("");
	});

	test("isolateLtr always uses a left-to-right isolate", () => {
		expect(isolateLtr("C:\\tmp")).toBe(`${LRI}C:\\tmp${PDI}`);
		expect(isolateLtr("")).toBe("");
	});

	test("stripBidiIsolates removes the marks for matching", () => {
		expect(stripBidiIsolates(`مراسلة ${FSI}#general${PDI}`)).toBe(
			"مراسلة #general"
		);
	});

	test("appendArgument leaves non-string values alone", () => {
		expect(appendArgument("x ", "5", false, false, "ar")).toBe("x 5");
		expect(appendArgument("@", "a", true, false, "en")).toBe("@a");
	});
});

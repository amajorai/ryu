import { expect, test } from "bun:test";
import { browserOpenCommand } from "../core/openBrowser.ts";

const URL_WITH_AMPERSAND = "https://ryu.example/device?code=AB&next=%2Fhome";

test("the Windows opener avoids cmd and keeps an ampersand in the URL", () => {
	const command = browserOpenCommand(URL_WITH_AMPERSAND, "win32");
	expect(command).toEqual([
		"rundll32",
		"url.dll,FileProtocolHandler",
		URL_WITH_AMPERSAND,
	]);
	expect(command).not.toContain("cmd");
});

test("macOS and Linux pass the normalized URL to the system opener", () => {
	expect(browserOpenCommand("http://localhost:3000/a b", "darwin")).toEqual([
		"open",
		"http://localhost:3000/a%20b",
	]);
	expect(browserOpenCommand(URL_WITH_AMPERSAND, "linux")).toEqual([
		"xdg-open",
		URL_WITH_AMPERSAND,
	]);
});

test("non-web and malformed URLs are never opened", () => {
	for (const platform of ["win32", "darwin", "linux"] as const) {
		expect(browserOpenCommand("file:///x", platform)).toBeNull();
		expect(browserOpenCommand("javascript:alert(1)", platform)).toBeNull();
		expect(browserOpenCommand("myapp://open", platform)).toBeNull();
		expect(browserOpenCommand("not a url", platform)).toBeNull();
	}
});

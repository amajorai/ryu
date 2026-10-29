// Capability adapter for `browser.control / browser.navigate` backed by browser-use.
// Injected globals: `input`, `defaults`, `callTool`, and `callNamed`.
// This flat fragment runs inside Core's generated async adapter IIFE.
//
// browser-use acts on its active tab and reports some failures as plain text
// ("Error: ..." or "Element with index N not found") without isError, so both
// shapes count as failure here rather than being passed on as success.
//
// browser_navigate does not return the id of the tab it opens, so the adapter
// diffs browser-use's tab list before and after opening the URL in a new tab.

const url = typeof input.url === "string" ? input.url.trim() : "";
if (!url) {
	return { error: "url is required" };
}
const textOf = (result) => result?.content?.find((item) => item?.type === "text")?.text ?? "";
const failed = (result) =>
	!result ||
	result.isError === true ||
	Boolean(result.error) ||
	result.available === false ||
	/^(Error:|Element with index )/.test(textOf(result));
const listTabs = async () => {
	const raw = await callNamed("browseruse.browser_list_tabs", {});
	if (failed(raw)) {
		return { raw };
	}
	try {
		const tabs = JSON.parse(textOf(raw));
		return Array.isArray(tabs) ? { tabs } : { raw };
	} catch {
		return { raw };
	}
};

const before = await listTabs();
if (!before.tabs) {
	return { raw: before.raw };
}
const opened = await callTool({ url, new_tab: true });
if (failed(opened)) {
	return { raw: opened };
}
const after = await listTabs();
if (!after.tabs) {
	return { raw: after.raw };
}
const known = new Set(before.tabs.map((tab) => tab?.tab_id));
const created = after.tabs.filter((tab) => typeof tab?.tab_id === "string" && !known.has(tab.tab_id));
if (created.length !== 1) {
	return {
		error: "browser-use opened the URL but its new tab could not be identified; call browser.tabs",
		raw: opened,
	};
}
return {
	tab_id: created[0].tab_id,
	url: typeof created[0].url === "string" && created[0].url ? created[0].url : url,
	title: created[0].title,
	raw: opened,
};

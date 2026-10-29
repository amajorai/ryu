# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: marketplace-store-sources-contributed.spec.ts >> Marketplaces retains custom source after removal refusal and reads back retry
- Location: e2e/marketplace-store-sources-contributed.spec.ts:137:1

# Error details

```
Test timeout of 60000ms exceeded.
```

```
Error: page.goto: Test timeout of 60000ms exceeded.
Call log:
  - navigating to "http://127.0.0.1:5493/marketplace-store-sources-contributed.html?section=marketplaces", waiting until "load"

```

# Test source

```ts
  90  | 		});
  91  | 	});
  92  | });
  93  | test.afterEach(async ({ page }, testInfo) => {
  94  | 	const state = diagnostics.get(page)!;
  95  | 	mkdirSync(evidence, { recursive: true });
  96  | 	writeFileSync(
  97  | 		resolve(
  98  | 			evidence,
  99  | 			`${testInfo.title.replace(/[^a-z0-9]+/gi, "-")}-contracts.json`
  100 | 		),
  101 | 		JSON.stringify(state, null, 2)
  102 | 	);
  103 | 	expect(
  104 | 		state.unknown,
  105 | 		"all source/contributed API calls must have explicit fixtures"
  106 | 	).toEqual([]);
  107 | 	expect(state.errors, "uncaught production errors").toEqual([]);
  108 | });
  109 | const plugin = "com.ryu.store-proof";
  110 | const catalogPath = `/api/ext/${plugin}/catalog`;
  111 | const tab: PluginStoreTab = {
  112 | 	app_enabled: true,
  113 | 	app_installed: true,
  114 | 	id: "proof",
  115 | 	plugin,
  116 | 	title: "Local templates",
  117 | 	http_policy: "owner",
  118 | 	spec: {
  119 | 		source: { http: { method: "GET", path: catalogPath }, items: "items" },
  120 | 		map: {
  121 | 			id: "id",
  122 | 			title: "name",
  123 | 			description: "description",
  124 | 			installed: "installed",
  125 | 		},
  126 | 		install: {
  127 | 			label: "Use",
  128 | 			http: {
  129 | 				method: "POST",
  130 | 				path: `${catalogPath}/{{item.id}}/install`,
  131 | 				body: { template_id: "{{item.id}}" },
  132 | 			},
  133 | 		},
  134 | 	},
  135 | };
  136 | 
  137 | test("Marketplaces retains custom source after removal refusal and reads back retry", async ({
  138 | 	page,
  139 | }) => {
  140 | 	let removed = false;
  141 | 	let attempts = 0;
  142 | 	let reads = 0;
  143 | 	const mutations: unknown[] = [];
  144 | 	await page.route(
  145 | 		(url) => url.pathname.startsWith("/api/"),
  146 | 		async (route) => {
  147 | 			const request = route.request();
  148 | 			const url = new URL(request.url());
  149 | 			if (
  150 | 				url.pathname === "/api/catalog/sources" &&
  151 | 				request.method() === "GET"
  152 | 			) {
  153 | 				reads++;
  154 | 				const kind = url.searchParams.get("kind");
  155 | 				return json(route, {
  156 | 					kind,
  157 | 					active: "builtin",
  158 | 					sources: [
  159 | 						{ id: "builtin", display_name: "Managed source", builtin: true },
  160 | 						...(kind === "plugin" && !removed
  161 | 							? [
  162 | 									{
  163 | 										id: "custom",
  164 | 										display_name: "Local custom source",
  165 | 										builtin: false,
  166 | 									},
  167 | 								]
  168 | 							: []),
  169 | 					],
  170 | 				});
  171 | 			}
  172 | 			if (
  173 | 				url.pathname === "/api/catalog/sources" &&
  174 | 				request.method() === "DELETE"
  175 | 			) {
  176 | 				mutations.push(request.postDataJSON());
  177 | 				expect(request.headers().authorization).toBe(
  178 | 					"Bearer fixture-node-token"
  179 | 				);
  180 | 				attempts++;
  181 | 				if (attempts === 1) {
  182 | 					return json(route, { ok: false, error: "Removal policy denied" });
  183 | 				}
  184 | 				removed = true;
  185 | 				return json(route, { ok: true });
  186 | 			}
  187 | 			return json(route, { error: `Unexpected ${url.pathname}` }, 500);
  188 | 		}
  189 | 	);
> 190 | 	await page.goto(`${STORY}?section=marketplaces`);
      |             ^ Error: page.goto: Test timeout of 60000ms exceeded.
  191 | 	await expect(
  192 | 		page.getByText("Local custom source", { exact: true })
  193 | 	).toBeVisible();
  194 | 	const initialReads = reads;
  195 | 	await page
  196 | 		.getByRole("button", { name: "Remove Local custom source" })
  197 | 		.click();
  198 | 	await expect(
  199 | 		page.getByText("Removal policy denied", { exact: true })
  200 | 	).toBeVisible();
  201 | 	await expect(
  202 | 		page.getByText("Local custom source", { exact: true })
  203 | 	).toBeVisible();
  204 | 	expect(reads).toBe(initialReads);
  205 | 	await expect(
  206 | 		page.getByText("Marketplace removed", { exact: true })
  207 | 	).toHaveCount(0);
  208 | 	await proof(page, "marketplaces-removal-refusal.png");
  209 | 	await page
  210 | 		.getByRole("button", { name: "Remove Local custom source" })
  211 | 		.click();
  212 | 	await expect(
  213 | 		page.getByText("Local custom source", { exact: true })
  214 | 	).toHaveCount(0);
  215 | 	expect(mutations).toEqual([
  216 | 		{ id: "custom", kind: "plugin" },
  217 | 		{ id: "custom", kind: "plugin" },
  218 | 	]);
  219 | 	expect(reads).toBeGreaterThan(initialReads);
  220 | 	await page.reload();
  221 | 	await expect(
  222 | 		page.getByRole("heading", { name: "Marketplaces", exact: true })
  223 | 	).toBeVisible();
  224 | 	await expect(
  225 | 		page.getByText("Local custom source", { exact: true })
  226 | 	).toHaveCount(0);
  227 | 	await proof(page, "marketplaces-removal-readback.png");
  228 | });
  229 | async function json(route: Route, value: unknown, status = 200) {
  230 | 	const request = route.request();
  231 | 	const state = diagnostics.get(request.frame().page())!;
  232 | 	expect(new URL(request.url()).origin).toBe(state.origin);
  233 | 	expect(request.headers().authorization).toBe("Bearer fixture-node-token");
  234 | 	if (
  235 | 		typeof value === "object" &&
  236 | 		value !== null &&
  237 | 		"error" in value &&
  238 | 		String(value.error).startsWith("Unexpected")
  239 | 	) {
  240 | 		state.unknown.push(`${request.method()} ${request.url()}`);
  241 | 	}
  242 | 	await route.fulfill({
  243 | 		status,
  244 | 		contentType: "application/json",
  245 | 		body: JSON.stringify(value),
  246 | 	});
  247 | }
  248 | async function proof(page: Page, name: string) {
  249 | 	mkdirSync(evidence, { recursive: true });
  250 | 	await page.evaluate(() => document.fonts.ready);
  251 | 	await page.screenshot({
  252 | 		path: resolve(evidence, name),
  253 | 		fullPage: true,
  254 | 		animations: "disabled",
  255 | 	});
  256 | }
  257 | async function expectInstalledTemplate(page: Page) {
  258 | 	const detail = page.getByRole("dialog", { name: "Verified template" });
  259 | 	await expect(
  260 | 		detail.getByText("Added", { exact: true }).first()
  261 | 	).toBeVisible();
  262 | 	await expect(
  263 | 		detail.getByRole("button", { name: "Use", exact: true })
  264 | 	).toHaveCount(0);
  265 | 	await detail.getByRole("button", { name: "Close", exact: true }).click();
  266 | 	await expect(detail).toHaveCount(0);
  267 | 	await expect(
  268 | 		page.getByRole("button", { name: "Added", exact: true })
  269 | 	).toBeDisabled();
  270 | }
  271 | 
  272 | test("disabled contributed app refuses enable without success/readback, then retries", async ({
  273 | 	page,
  274 | }) => {
  275 | 	let enabled = false;
  276 | 	let attempts = 0;
  277 | 	let contributionReads = 0;
  278 | 	const calls: { path: string; method: string; auth: string | undefined }[] =
  279 | 		[];
  280 | 	await page.route(
  281 | 		(url) => url.pathname.startsWith("/api/"),
  282 | 		async (route) => {
  283 | 			const request = route.request();
  284 | 			const path = new URL(request.url()).pathname;
  285 | 			calls.push({
  286 | 				path,
  287 | 				method: request.method(),
  288 | 				auth: request.headers().authorization,
  289 | 			});
  290 | 			if (path === "/api/plugins/contributions" && request.method() === "GET") {
```
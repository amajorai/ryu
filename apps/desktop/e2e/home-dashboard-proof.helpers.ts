import type { Page } from "@playwright/test";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { widgetInputSchema } from "../src/components/dashboard/widgets/schema.ts";
import type { Dashboard, Widget } from "../src/lib/api/dashboard.ts";
import { type ProofJsonRecord, parseProofJsonRecord } from "./fixture-json.ts";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for home-dashboard-proof.spec.ts, kept apart so each file stays under the token limit.

export const evidenceDir = proofEvidencePath(
	"test-coverage-sweep-20260924/evidence"
);

export interface ApiCall {
	body: ProofJsonRecord | null;
	method: string;
	path: string;
}

export interface DashboardFixture {
	calls: ApiCall[];
	dashboards: Dashboard[];
	failNext: Set<string>;
	nextId: number;
	widgets: Record<string, Widget[]>;
}

declare global {
	interface Window {
		__homeDashboardProof?: { notifyResourceChanged: () => void };
	}
}

export function makeDashboard(id: string, name: string): Dashboard {
	return {
		created_at: "2026-09-26T00:00:00.000Z",
		id,
		name,
		updated_at: "2026-09-26T00:00:00.000Z",
		view_mode: "grid",
	};
}

export function makeWidget(
	dashboardId: string,
	options: Partial<Widget> = {}
): Widget {
	return {
		config: { label_key: "title" },
		dashboard_id: dashboardId,
		id: "widget-existing",
		kind: "list",
		last_value: [{ title: "Initial item" }],
		layout: { h: 3, w: 5, x: 0, y: 0 },
		source: { type: "core_endpoint", endpoint: "quests", selector: "quests" },
		title: "Existing widget",
		...options,
	};
}

export function makeFixture(
	options: {
		dashboards?: Dashboard[];
		failNext?: string[];
		widgets?: Widget[];
	} = {}
): DashboardFixture {
	const dashboards = options.dashboards ?? [makeDashboard("dash-home", "Home")];
	return {
		calls: [],
		dashboards,
		failNext: new Set(options.failNext),
		nextId: 1,
		widgets: Object.fromEntries(
			dashboards.map((dashboard) => [
				dashboard.id,
				(options.widgets ?? []).filter(
					(widget) => widget.dashboard_id === dashboard.id
				),
			])
		),
	};
}

export function jsonResponse<FixturePayload>(data: FixturePayload) {
	return {
		body: JSON.stringify(data),
		contentType: "application/json",
		status: 200,
	};
}

export async function installApiFixture(page: Page, state: DashboardFixture) {
	await page.route("**/api/dashboards**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const method = request.method();
		const path = url.pathname;
		let body: ProofJsonRecord | null = null;
		if (request.postData()) {
			body = parseProofJsonRecord(request.postData() ?? "{}");
		}
		state.calls.push({ body, method, path });

		if (path === "/api/dashboards/events") {
			await route.fulfill({
				body: ": fixture connected\n\n",
				contentType: "text/event-stream",
				status: 200,
			});
			return;
		}
		if (path === "/api/dashboards/catalog" && method === "GET") {
			await route.fulfill(
				jsonResponse({
					core_endpoints: ["connections", "quests", "monitors"],
					source_types: ["core_endpoint", "static"],
					widget_kinds: ["stat", "list", "table"],
				})
			);
			return;
		}
		if (state.failNext.delete(`${method} ${path}`)) {
			await route.fulfill({
				body: JSON.stringify({ error: "fixture unavailable" }),
				contentType: "application/json",
				status: 503,
			});
			return;
		}
		if (path === "/api/dashboards" && method === "GET") {
			await route.fulfill(jsonResponse({ dashboards: state.dashboards }));
			return;
		}
		if (path === "/api/dashboards" && method === "POST") {
			const dashboard = makeDashboard(
				`dash-created-${state.nextId++}`,
				String(body?.name ?? "")
			);
			state.dashboards.push(dashboard);
			state.widgets[dashboard.id] = [];
			await route.fulfill(jsonResponse({ dashboard }));
			return;
		}

		const widgetRoute = path.match(
			/^\/api\/dashboards\/([^/]+)\/widgets(?:\/([^/]+)(?:\/(refresh))?)?$/
		);
		if (widgetRoute) {
			const [, dashboardId, widgetId, action] = widgetRoute;
			const dashboardWidgets = state.widgets[dashboardId] ?? [];
			if (method === "POST" && !widgetId) {
				const input = widgetInputSchema
					.required({ kind: true, layout: true, source: true, title: true })
					.parse(body);
				const widget = {
					...input,
					config: input.config,
					dashboard_id: dashboardId,
					id: `widget-created-${state.nextId++}`,
				} satisfies Widget;
				state.widgets[dashboardId] = [...dashboardWidgets, widget];
				await route.fulfill(jsonResponse({ widget }));
				return;
			}
			if (method === "POST" && widgetId && action === "refresh") {
				await route.fulfill(
					jsonResponse({ value: [{ title: "Refreshed from fixture" }] })
				);
				return;
			}
			if (method === "DELETE" && widgetId) {
				state.widgets[dashboardId] = dashboardWidgets.filter(
					(widget) => widget.id !== widgetId
				);
				await route.fulfill({ body: "", status: 200 });
				return;
			}
		}

		const dashboardRoute = path.match(/^\/api\/dashboards\/([^/]+)$/);
		if (dashboardRoute) {
			const [, dashboardId] = dashboardRoute;
			const index = state.dashboards.findIndex(
				(dashboard) => dashboard.id === dashboardId
			);
			if (method === "GET" && index !== -1) {
				await route.fulfill(
					jsonResponse({
						dashboard: state.dashboards[index],
						widgets: state.widgets[dashboardId] ?? [],
					})
				);
				return;
			}
			if (method === "PUT" && index !== -1) {
				state.dashboards[index] = {
					...state.dashboards[index],
					...(isNativeText(body?.name) ? { name: body.name } : undefined),
					...(body?.view_mode === "grid" || body?.view_mode === "canvas"
						? { view_mode: body.view_mode }
						: undefined),
				};
				await route.fulfill(
					jsonResponse({ dashboard: state.dashboards[index] })
				);
				return;
			}
			if (method === "DELETE" && index !== -1) {
				state.dashboards.splice(index, 1);
				delete state.widgets[dashboardId];
				await route.fulfill({ body: "", status: 200 });
				return;
			}
		}

		await route.fulfill({
			body: JSON.stringify({
				error: `unhandled fixture request ${method} ${path}`,
			}),
			contentType: "application/json",
			status: 404,
		});
	});
}

export async function mountHome(page: Page, state: DashboardFixture) {
	await installApiFixture(page, state);
	const catalogLoaded = page.waitForResponse(
		(response) =>
			response.request().method() === "GET" &&
			new URL(response.url()).pathname === "/api/dashboards/catalog"
	);
	await page.goto("/home-dashboard-proof.html");
	await page.waitForSelector('body[data-home-dashboard-proof-ready="1"]');
	await catalogLoaded;
}

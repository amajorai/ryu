import { expect, test } from "@playwright/test";
import {
	capture,
	mountMail,
	openHost,
	state,
	waitForCall,
} from "./mail-companion-proof.helpers.ts";

test("webhook submission rejects local HTTP, preserves input, then creates the HTTPS fixture webhook", async ({
	page,
}) => {
	const companion = await mountMail(page);
	await companion.getByRole("tab", { name: "Webhooks" }).click();
	const endpoint = companion.getByPlaceholder(
		"https://your-agent.example/mail-events",
		{ exact: true }
	);
	const eventTypes = companion.getByRole("textbox").nth(1);
	await endpoint.fill("http://127.0.0.1:9000/mail-events");
	await eventTypes.fill("message.received, message.sent");
	await companion
		.getByRole("button", { name: "Add webhook", exact: true })
		.click();
	const rejected = await waitForCall(
		page,
		"mail.request:POST:/api/mail/webhooks",
		"/api/mail/webhooks"
	);
	expect(rejected.status).toBe(422);
	expect(rejected.args).toEqual({
		event_types: ["message.received", "message.sent"],
		inbox_ids: ["inbox-support", "inbox-billing"],
		url: "http://127.0.0.1:9000/mail-events",
	});
	await expect(endpoint).toHaveValue("http://127.0.0.1:9000/mail-events");

	await endpoint.fill("https://hooks.example.test/agent-mail");
	await companion
		.getByRole("button", { name: "Add webhook", exact: true })
		.click();
	const created = await waitForCall(
		page,
		"mail.request:POST:/api/mail/webhooks",
		"/api/mail/webhooks",
		1
	);
	expect(created.status).toBe(201);
	expect(created.args).toEqual({
		event_types: ["message.received", "message.sent"],
		inbox_ids: ["inbox-support", "inbox-billing"],
		url: "https://hooks.example.test/agent-mail",
	});
	await expect(
		companion.getByRole("option", {
			name: /https:\/\/hooks\.example\.test\/agent-mail/,
		})
	).toBeVisible();
	expect(
		(await state(page)).webhooks.some(
			(webhook) => webhook.webhook_id === "webhook-2"
		)
	).toBe(true);
	await capture(companion, "mail-companion-webhook-created.png");
});

test("first-party form events work in ExtensionHost while CSP blocks form POSTs", async ({
	page,
}) => {
	await openHost(page);
	const blockedAction = new URL("/__mail-proof/blocked-form-action", page.url())
		.href;
	const attemptedPosts: string[] = [];
	page.on("request", (request) => {
		if (request.method() === "POST" && request.url() === blockedAction) {
			attemptedPosts.push(request.url());
		}
	});
	await page.evaluate((actionUrl) => {
		window.__mailProof.mountFormActionProof({ actionUrl });
	}, blockedAction);
	const frame = page.frameLocator('iframe[title="Mail form action proof"]');
	await expect(
		frame.getByRole("heading", { name: "Form policy proof" })
	).toBeVisible();
	const csp = await frame
		.locator('meta[http-equiv="Content-Security-Policy"]')
		.getAttribute("content");
	expect(csp).toContain("connect-src 'none'");
	expect(csp).toContain("form-action 'none'");
	await expect(
		page.locator('iframe[title="Mail form action proof"]')
	).toHaveAttribute("sandbox", "allow-scripts allow-forms");
	const form = frame.locator("form");
	await form.evaluate((element) => {
		element.addEventListener(
			"submit",
			(event) => {
				element.setAttribute("data-proof-submit-fired", "true");
				queueMicrotask(() =>
					element.setAttribute(
						"data-proof-submit-prevented",
						String(event.defaultPrevented)
					)
				);
			},
			{ capture: true, once: true }
		);
	});
	await frame.getByRole("button", { name: "Send probe" }).click();
	await expect(form).toHaveAttribute("data-proof-submit-fired", "true");
	await expect(form).toHaveAttribute("data-proof-submit-prevented", "false");
	expect(attemptedPosts).toEqual([]);
	await expect(frame.getByRole("button", { name: "Send probe" })).toBeVisible();
});

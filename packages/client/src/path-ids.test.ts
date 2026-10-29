import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createBoxClient } from "./box.ts";
import * as clientRoot from "./index.ts";
import { MailAPI } from "./mail.ts";
import {
	createManagedAgentsClient,
	ManagedAgentsError,
	ManagedAgentsTransport,
} from "./managed-agents.ts";
import {
	createMessagingClient,
	MessagingError,
	MessagingTransport,
} from "./messaging.ts";
import { createNotifyClient, notifyRequest } from "./notify.ts";
import {
	assertSafeRequestPath,
	isSafeRequestPath,
	RyuPathIdError,
} from "./path-id.ts";
import type { RyuFetch } from "./types.ts";

const UNSAFE_IDS = ["", ".", ".."] as const;

/** A fetch that records each URL and answers `body` as JSON. */
function recordingFetch(body: unknown = {}) {
	const urls: string[] = [];
	const fetch: RyuFetch = (input) => {
		urls.push(String(input));
		return Promise.resolve(Response.json(body));
	};
	return { fetch, urls };
}

describe("path ids", () => {
	test("the package root exports RyuPathIdError and isSafeRequestPath", () => {
		expect(clientRoot.RyuPathIdError).toBe(RyuPathIdError);
		// @ryuhq/services' fetch shim runs this same scan on every request.
		expect(clientRoot.isSafeRequestPath).toBe(isSafeRequestPath);
	});

	test("Box refuses an empty or dot id before any request", async () => {
		const { fetch, urls } = recordingFetch();
		const box = createBoxClient({
			apiKey: "key",
			baseUrl: "https://box.example",
			fetch,
		});
		const refused = await box.deletePreview("box_1", "..").catch((e) => e);
		expect(refused).toBeInstanceOf(RyuPathIdError);
		expect(refused).toMatchObject({ code: "invalid_id", status: 0 });
		for (const id of UNSAFE_IDS) {
			await expect(box.deletePreview("box_1", id)).rejects.toThrow(
				"path id must be a non-empty id"
			);
			await expect(box.stop(id)).rejects.toThrow("path id");
			await expect(box.kill("box_1", id)).rejects.toThrow("path id");
			await expect(box.deleteSnapshot(id)).rejects.toThrow("path id");
			await expect(box.deleteSecret(id)).rejects.toThrow("path id");
			await expect(box.promptRun("box_1", id)).rejects.toThrow("path id");
		}
		expect(urls).toEqual([]);
		await box.deletePreview("box_1", "tok.en");
		expect(urls).toEqual([
			"https://box.example/v1/boxes/box_1/previews/tok.en",
		]);
	});

	test("Notify refuses an empty or dot id before any request", async () => {
		const { fetch, urls } = recordingFetch();
		const notify = createNotifyClient({
			apiKey: "key",
			baseUrl: "https://notify.example",
			fetch,
		});
		for (const id of UNSAFE_IDS) {
			await expect(notify.getEvent(id)).rejects.toThrow(
				"path id must be a non-empty id"
			);
			await expect(notify.deleteDestination(id)).rejects.toThrow("path id");
			await expect(notify.deleteSilence(id)).rejects.toThrow("path id");
			await expect(notify.publishTopic(id, "hi")).rejects.toThrow("path id");
		}
		expect(urls).toEqual([]);
		await notify.deleteSilence("sil_1");
		expect(urls).toEqual(["https://notify.example/v1/silences/sil_1"]);
	});

	test("Messaging refuses an empty or dot id with invalid_id", async () => {
		const { fetch, urls } = recordingFetch();
		const messaging = createMessagingClient({
			apiKey: "key",
			baseUrl: "https://api.example",
			fetch,
			organizationId: "org_1",
		});
		for (const id of UNSAFE_IDS) {
			const refused = await messaging.messages.get(id).catch((error) => error);
			expect(refused).toBeInstanceOf(MessagingError);
			expect(refused).toMatchObject({ code: "invalid_id", status: 0 });
			await expect(messaging.numbers.release(id)).rejects.toThrow(
				MessagingError
			);
			await expect(messaging.optOuts.remove(id)).rejects.toThrow(
				MessagingError
			);
			// A non-`async` method rejects instead of throwing synchronously.
			const pending = messaging.whatsapp.templates.list(id);
			await expect(pending).rejects.toThrow(MessagingError);
		}
		expect(urls).toEqual([]);
	});

	test("Messaging refuses a dot organization id before any org request", async () => {
		const { fetch, urls } = recordingFetch();
		for (const organizationId of UNSAFE_IDS) {
			const messaging = createMessagingClient({
				apiKey: "key",
				baseUrl: "https://api.example",
				fetch,
				organizationId,
			});
			const refused = await messaging.messages.list().catch((error) => error);
			expect(refused).toBeInstanceOf(MessagingError);
			expect(refused).toMatchObject({ code: "invalid_id", status: 0 });
			// A non-`async` method rejects instead of throwing synchronously.
			const pending = messaging.numbers.quote({
				country: "US",
				type: "LONG_CODE",
			});
			await expect(pending).rejects.toThrow(MessagingError);
		}
		expect(urls).toEqual([]);
		const valid = createMessagingClient({
			apiKey: "key",
			baseUrl: "https://api.example",
			fetch,
			organizationId: "org.1",
		});
		await valid.messages.list().catch(() => undefined);
		expect(urls[0]).toContain("/orgs/org.1/messages");
	});

	test("Messaging keeps building a client without an organization", () => {
		expect(() =>
			createMessagingClient({
				apiKey: "",
				baseUrl: "https://api.example",
				organizationId: "",
			})
		).not.toThrow();
	});

	test("Managed Agents refuses an empty or dot id with invalid_id", async () => {
		const { fetch, urls } = recordingFetch();
		const agents = createManagedAgentsClient({
			apiKey: "key",
			baseUrl: "https://api.example",
			fetch,
		});
		for (const id of UNSAFE_IDS) {
			const pending = agents.sessions.delete(id);
			const refused = await pending.catch((error) => error);
			expect(refused).toBeInstanceOf(ManagedAgentsError);
			expect(refused).toMatchObject({
				code: "invalid_id",
				requestId: null,
				status: 0,
			});
			await expect(agents.agents.get(id)).rejects.toThrow(ManagedAgentsError);
			await expect(agents.environments.archive(id)).rejects.toThrow(
				ManagedAgentsError
			);
		}
		// The stream stops on the refusal instead of reconnecting.
		const stream = agents.sessions.stream("..");
		await expect(stream.next()).rejects.toThrow(ManagedAgentsError);
		expect(urls).toEqual([]);
	});

	test("Managed Agents' transport reads segments the way the URL parser does", async () => {
		const { fetch, urls } = recordingFetch();
		const transport = new ManagedAgentsTransport({
			apiKey: "key",
			baseUrl: "https://api.example",
			fetch,
		});
		for (const path of [
			"/v1/sessions/a\\..",
			"/v1/sessions/.\t.",
			"/v1/sessions/..\r",
			"/v1/sessions/ .. ",
			"/v1/sessions/%2E%2e",
		]) {
			const refused = await transport
				.send("DELETE", path, { accept: "application/json" })
				.catch((error) => error);
			expect(refused).toBeInstanceOf(ManagedAgentsError);
			expect(refused).toMatchObject({
				code: "invalid_id",
				requestId: null,
				status: 0,
			});
		}
		expect(urls).toEqual([]);
	});

	test("Mail refuses an empty or dot id before any request", async () => {
		const { fetch, urls } = recordingFetch({ thread: null });
		const mail = new MailAPI({ baseUrl: "https://mail.example", fetch });
		for (const id of UNSAFE_IDS) {
			await expect(mail.getThread("in_1", id)).rejects.toThrow(
				"Mail: a path id must be a non-empty id"
			);
			await expect(mail.deleteInbox(id)).rejects.toThrow("path id");
			await expect(mail.downloadRaw(id)).rejects.toThrow("path id");
			await expect(
				mail.removeEntry("org", "org_1", "inbound", "block", id)
			).rejects.toThrow("path id");
		}
		// A raw `%2e%2e` id is a dot segment too.
		await expect(mail.deleteInbox("%2E%2e")).rejects.toThrow(RyuPathIdError);
		await expect(mail.deleteInbox("%2E%2e")).rejects.toThrow("path id");
		// The URL parser reads `\\` as `/` and drops tab/CR/LF, so these resolve
		// onto `/api/mail/` too.
		for (const id of ["..\\", "a\\..\\..", ".\t.", ".\n.", "..\r", " .. "]) {
			await expect(mail.deleteInbox(id)).rejects.toThrow(RyuPathIdError);
			await expect(mail.getThread("in_1", id)).rejects.toThrow("path id");
		}
		await expect(
			mail.removeEntry("org", "org_1", "in\\..", "block", "x")
		).rejects.toThrow(RyuPathIdError);
		expect(urls).toEqual([]);
		await mail.removeEntry("org", "org_1", "inbound", "block", "a.b@c.example");
		expect(urls).toEqual([
			"https://mail.example/api/mail/lists/org/org_1/inbound/block/a.b%40c.example",
		]);
	});

	test("the whole-path scan reads segments the way the URL parser does", () => {
		for (const path of [
			"/v1/boxes/box_1",
			"/v1/boxes/box_1/previews/tok.en",
			"/v1/events?after=..&x=/./",
			"/v1/secrets/a%2Fb",
			"/v1/snapshots/...",
		]) {
			expect(isSafeRequestPath(path)).toBe(true);
			expect(() => assertSafeRequestPath("Box", path)).not.toThrow();
		}
		for (const path of [
			"/v1/boxes/",
			"/v1/boxes//stop",
			"/v1/boxes/.",
			"/v1/boxes/../stop",
			"/v1/boxes/%2E%2e",
			"/v1/boxes/a\\..\\..",
			"/v1/boxes/.\t.",
			"/v1/boxes/ .. ?x=1",
			"/v1/boxes/..#frag",
			// It takes the request path, not a URL: `//` after the scheme is empty.
			"https://api.ryu.dev/v1/boxes/b",
		]) {
			expect(isSafeRequestPath(path)).toBe(false);
			expect(() => assertSafeRequestPath("Box", path)).toThrow(RyuPathIdError);
		}
		expect(() => assertSafeRequestPath("Notify", "/v1/events/..")).toThrow(
			"Ryu Notify: a path id must be a non-empty id"
		);
	});

	test("Box checks every request path in its transport", async () => {
		const { fetch, urls } = recordingFetch();
		const box = createBoxClient({
			apiKey: "key",
			baseUrl: "https://box.example",
			fetch,
		});
		// The transport the public methods share: a path that skipped `pathId`.
		const transport = Reflect.get(box, "request") as (
			method: string,
			path: string
		) => Promise<Response>;
		for (const path of ["/v1/boxes//stop", "/v1/boxes/%2e%2E", "/v1/a\\.."]) {
			const pending = transport.call(box, "DELETE", path);
			await expect(pending).rejects.toThrow(RyuPathIdError);
		}
		expect(urls).toEqual([]);
		await box.stop("box.1");
		expect(urls).toEqual(["https://box.example/v1/boxes/box.1/stop"]);
	});

	test("Notify checks every request path, the event stream included", async () => {
		const { fetch, urls } = recordingFetch({ events: [] });
		const notify = createNotifyClient({
			apiKey: "key",
			baseUrl: "https://notify.example",
			fetch,
		});
		const transport = Reflect.get(notify, "fetch") as (
			path: string,
			init: RequestInit
		) => Promise<Response>;
		for (const path of ["/v1/events//ack", "/v1/events/%2E", "/v1/a\\.."]) {
			const pending = transport.call(notify, path, { method: "GET" });
			await expect(pending).rejects.toThrow(RyuPathIdError);
		}
		// The module-level `request` wrapper every non-stream method uses: a
		// path that skipped `pathId` is refused before fetch.
		const options = { baseUrl: "https://notify.example", fetch, token: "key" };
		for (const path of ["/v1/silences//x", "/v1/topics/%2e%2E", "/v1/a\\.."]) {
			const refused = await notifyRequest(options, path, {
				method: "POST",
			}).catch((error) => error);
			expect(refused).toBeInstanceOf(RyuPathIdError);
			expect(refused).toMatchObject({ code: "invalid_id", status: 0 });
		}
		expect(urls).toEqual([]);
		await notifyRequest(options, "/v1/topics/t.1", { method: "POST" });
		expect(urls).toEqual(["https://notify.example/v1/topics/t.1"]);
		urls.length = 0;
		await notify.deleteSilence("sil.1");
		expect(urls).toEqual(["https://notify.example/v1/silences/sil.1"]);
	});

	test("Messaging's transport scans the whole path, not only org ids", async () => {
		const { fetch, urls } = recordingFetch({});
		const transport = new MessagingTransport({
			apiKey: "key",
			baseUrl: "https://api.example",
			fetch,
			organizationId: "org_1",
		});
		const schema = z.unknown();
		// Paths that skipped `segment`: only the whole-path scan catches these.
		for (const path of [
			transport.org("/numbers//x"),
			transport.org("/numbers/%2e%2E"),
			transport.org("/numbers/a\\.."),
			"/status/.",
		]) {
			const refused = await transport
				.json("GET", path, schema)
				.catch((error) => error);
			expect(refused).toBeInstanceOf(MessagingError);
			expect(refused).toMatchObject({ code: "invalid_id", status: 0 });
		}
		expect(urls).toEqual([]);
		await transport.json("GET", transport.org("/numbers/num.1"), schema);
		expect(urls).toEqual([
			"https://api.example/api/messaging/orgs/org_1/numbers/num.1",
		]);
	});

	test("Messaging still refuses a dot organization id on org paths", async () => {
		const { fetch, urls } = recordingFetch();
		for (const organizationId of UNSAFE_IDS) {
			const messaging = createMessagingClient({
				apiKey: "key",
				baseUrl: "https://api.example",
				fetch,
				organizationId,
			});
			const refused = await messaging.numbers
				.release("num_1")
				.catch((error) => error);
			expect(refused).toBeInstanceOf(MessagingError);
			expect(refused).toMatchObject({ code: "invalid_id", status: 0 });
		}
		expect(urls).toEqual([]);
		// Credential-free `status()` still works without an organization.
		const status = createMessagingClient({
			apiKey: "",
			baseUrl: "https://api.example",
			fetch,
			organizationId: "",
		});
		await status.status().catch(() => undefined);
		expect(urls).toEqual(["https://api.example/api/messaging/status"]);
	});
});

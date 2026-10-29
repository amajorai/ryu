import { z } from "zod";
import type {
	MessagingMessage,
	MessagingMessagePage,
	MessagingNumber,
	MessagingNumberQuote,
	MessagingOptOutPage,
	MessagingQuote,
	MessagingSettings,
	MessagingSettingsUpdate,
	MessagingStatus,
	MessagingUnknownWebhookEvent,
	MessagingWebhookEvent,
	MessagingWebhookEventType,
	MessagingWebhookSecretRotation,
	MessagingWhatsAppSender,
	MessagingWhatsAppTemplateCreated,
	MessagingWhatsAppTemplatePage,
} from "./messaging.ts";

// packages/client/src/messaging-contracts.ts
//
// Response contracts for the Ryu Messaging API (`/api/messaging`). Each contract validates the
// declared fields and returns the raw value, so fields the server adds later are kept.

const text = z.string();
const nullableText = text.nullable();
const microUsd = z.int().min(0);
const count = z.int().min(0);
const stringRecord = z.record(z.string(), z.string());
const jsonObject = z.record(z.string(), z.json());

const messageValidation = z.object({
	id: text,
	organizationId: text,
	channel: z.enum(["sms", "mms", "voice", "whatsapp"]),
	direction: z.enum(["outbound", "inbound"]),
	status: z.enum([
		"queued",
		"sending",
		"accepted",
		"delivered",
		"failed",
		"unresolved",
		"refused",
		"received",
	]),
	from: text,
	to: text,
	isoCountryCode: nullableText,
	numberId: nullableText,
	whatsappSenderId: nullableText,
	body: nullableText,
	bodyType: z.enum(["text", "ssml", "template", "media"]),
	encoding: z.enum(["GSM", "UCS2"]).nullable(),
	segments: count,
	template: z.object({ name: nullableText, language: nullableText }).nullable(),
	hasMedia: z.boolean(),
	providerMessageId: nullableText,
	providerStatus: nullableText,
	providerStatusDescription: nullableText,
	heldMicroUsd: microUsd,
	priceMicroUsd: microUsd.nullable(),
	chargedMicroUsd: microUsd,
	absorbedMicroUsd: microUsd,
	chargeState: z.enum([
		"none",
		"held",
		"settling",
		"settled",
		"released",
		"absorbed",
	]),
	estimated: z.boolean(),
	ttlSeconds: count.nullable(),
	metadata: stringRecord,
	error: nullableText,
	createdAt: text,
	updatedAt: text,
});

const numberValidation = z.object({
	id: text,
	organizationId: text,
	phoneNumber: nullableText,
	isoCountryCode: text,
	numberType: z.enum(["LONG_CODE", "TOLL_FREE", "TEN_DLC", "SIMULATOR"]),
	capabilities: z.array(z.enum(["SMS", "VOICE", "MMS"])),
	messageType: z.enum(["TRANSACTIONAL", "PROMOTIONAL"]),
	status: z.enum([
		"pending",
		"active",
		"suspended",
		"releasing",
		"released",
		"failed",
	]),
	label: nullableText,
	twoWayEnabled: z.boolean(),
	registrationId: nullableText,
	monthlyLeaseMicroUsd: microUsd,
	leasePeriod: count,
	currentPeriodEndsAt: nullableText,
	suspendedAt: nullableText,
	graceEndsAt: nullableText,
	releasedAt: nullableText,
	error: nullableText,
	createdAt: text,
	updatedAt: text,
});

const senderValidation = z.object({
	id: text,
	organizationId: text,
	wabaId: text,
	displayPhoneNumber: text,
	dedicatedWaba: z.boolean(),
	status: z.enum(["active", "disabled"]),
	label: nullableText,
	createdAt: text,
	updatedAt: text,
});

const settingsValidation = z.object({
	organizationId: text,
	webhookUrl: nullableText,
	webhookSecretSet: z.boolean(),
	allowedCountries: z.array(text),
	dailySendLimit: count.nullable(),
	defaultDailySendLimit: count,
});

// Wallet balances are sums of buckets, not guaranteed whole micro-USD.
const creditValidation = z.object({
	availableMicroUsd: z.number(),
	heldMicroUsd: z.number().min(0),
});

const smsQuoteValidation = z.object({
	ceilingMicroUsd: microUsd,
	encoding: z.enum(["GSM", "UCS2"]).nullable(),
	isoCountryCode: text,
	segments: count,
});

const quoteValidation = z.discriminatedUnion("channel", [
	z.object({
		channel: z.literal("sms"),
		credit: creditValidation,
		quote: smsQuoteValidation,
	}),
	z.object({
		channel: z.literal("mms"),
		credit: creditValidation,
		quote: smsQuoteValidation,
	}),
	z.object({
		channel: z.literal("voice"),
		credit: creditValidation,
		quote: z.object({
			ceilingMicroUsd: microUsd,
			estimatedMinutes: count,
			isoCountryCode: text,
			perMinuteMicroUsd: microUsd,
		}),
	}),
	z.object({
		channel: z.literal("whatsapp"),
		credit: creditValidation,
		quote: z.object({
			awsFeeMicroUsd: microUsd,
			ceilingMicroUsd: microUsd,
			isoCountryCode: text,
		}),
	}),
]);

const numberQuoteValidation = z.object({
	credit: creditValidation,
	isoCountryCode: text,
	numberType: numberValidation.shape.numberType,
	quote: z.object({
		ceilingMicroUsd: microUsd,
		monthlyLeaseMicroUsd: microUsd,
		setupFeeMicroUsd: microUsd,
	}),
});

const statusValidation = z.object({
	apiVersion: text,
	configured: z.boolean(),
	channels: z.object({
		sms: z.boolean(),
		voice: z.boolean(),
		mms: z.boolean(),
		whatsapp: z.boolean(),
	}),
});

const templateListValidation = z.object({
	templates: z.array(
		z.object({
			name: nullableText,
			metaTemplateId: nullableText,
			status: nullableText,
			language: nullableText,
			category: nullableText,
			qualityScore: nullableText,
		})
	),
	nextToken: nullableText,
});

const templateCreatedValidation = z.object({
	template: z.object({
		metaTemplateId: nullableText,
		status: nullableText,
		category: nullableText,
	}),
});

const optOutListValidation = z.object({
	optOuts: z.array(
		z.object({
			phoneNumber: text,
			optedOutAt: nullableText,
			endUserOptedOut: z.boolean(),
		})
	),
	nextToken: nullableText,
});

const messagingWebhookEventTypes: ReadonlySet<string> = new Set([
	"message.received",
	"message.delivered",
	"message.failed",
	"number.suspended",
	"number.released",
] satisfies MessagingWebhookEventType[]);

/** Whether a webhook `event_type` is one this client knows. */
export function isKnownMessagingWebhookEventType(
	eventType: string
): eventType is MessagingWebhookEventType {
	return messagingWebhookEventTypes.has(eventType);
}

const webhookEnvelopeValidation = z.object({
	type: z.literal("event"),
	event_type: text,
	event_id: text,
	data: jsonObject,
});

const webhookEventValidation = z.discriminatedUnion("event_type", [
	z.object({
		type: z.literal("event"),
		event_type: z.enum([
			"message.received",
			"message.delivered",
			"message.failed",
		]),
		event_id: text,
		data: z.object({ message: messageValidation }),
	}),
	z.object({
		type: z.literal("event"),
		event_type: z.enum(["number.suspended", "number.released"]),
		event_id: text,
		data: z.object({ number: numberValidation }),
	}),
]);

function contract<T>(validation: z.ZodType) {
	return z.custom<T>((value) => validation.safeParse(value).success);
}

export const messagingMessageSchema =
	contract<MessagingMessage>(messageValidation);
export const messagingNumberSchema =
	contract<MessagingNumber>(numberValidation);
export const messagingWhatsAppSenderSchema =
	contract<MessagingWhatsAppSender>(senderValidation);
export const messagingSettingsSchema =
	contract<MessagingSettings>(settingsValidation);

export const messagingStatusSchema =
	contract<MessagingStatus>(statusValidation);
export const messagingQuoteSchema = contract<MessagingQuote>(quoteValidation);
export const messagingNumberQuoteSchema = contract<MessagingNumberQuote>(
	numberQuoteValidation
);
export const messagingNumberListSchema = contract<{
	numbers: MessagingNumber[];
}>(z.object({ numbers: z.array(numberValidation) }));
export const messagingNumberReplySchema = contract<{
	number: MessagingNumber;
}>(z.object({ number: numberValidation }));
export const messagingMessageReplySchema = contract<{
	message: MessagingMessage;
}>(z.object({ message: messageValidation }));
export const messagingMessageListSchema = contract<MessagingMessagePage>(
	z.object({ messages: z.array(messageValidation), nextCursor: nullableText })
);
export const messagingWhatsAppSenderListSchema = contract<{
	senders: MessagingWhatsAppSender[];
}>(z.object({ senders: z.array(senderValidation) }));
export const messagingWhatsAppTemplateListSchema =
	contract<MessagingWhatsAppTemplatePage>(templateListValidation);
export const messagingWhatsAppTemplateCreatedSchema = contract<{
	template: MessagingWhatsAppTemplateCreated;
}>(templateCreatedValidation);
export const messagingOptOutListSchema =
	contract<MessagingOptOutPage>(optOutListValidation);
export const messagingOptOutReplySchema = contract<{
	optOut: { phoneNumber: string };
}>(z.object({ optOut: z.object({ phoneNumber: text }) }));
export const messagingOptOutDeletedSchema = contract<{ deleted: true }>(
	z.object({ deleted: z.literal(true) })
);
export const messagingSettingsReplySchema = contract<{
	settings: MessagingSettings;
}>(z.object({ settings: settingsValidation }));
export const messagingSettingsUpdateSchema = contract<MessagingSettingsUpdate>(
	z.object({ settings: settingsValidation, webhookSecret: text.optional() })
);
export const messagingWebhookSecretReplySchema =
	contract<MessagingWebhookSecretRotation>(
		z.object({ settings: settingsValidation, webhookSecret: text })
	);

/** The `{error, message, ...details}` body of every refusal. */
export const messagingErrorBodySchema = z.looseObject({
	error: text,
	message: text,
});

/** Any well-formed delivery; `data` is checked only as JSON. */
export const messagingWebhookEnvelopeSchema =
	contract<MessagingUnknownWebhookEvent>(webhookEnvelopeValidation);
/** A delivery of a known type whose `data` matches that type. */
export const messagingWebhookEventSchema = contract<MessagingWebhookEvent>(
	webhookEventValidation
);

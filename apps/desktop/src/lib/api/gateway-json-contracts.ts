/** Core owns JSON serialization admission, including extension fields and deep trees. */
export {
	type AppRequestValue as GatewayJsonValue,
	appRequestValueSchema as gatewayJsonValueSchema,
} from "@ryuhq/core-client/app-request-json";

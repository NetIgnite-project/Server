import { type Context } from "hono";
import { z } from "zod";

export class APIResponse {
	static success<Data extends APIResponse.Types.RequiredReturnData>(
		c: Context,
		message: string,
		data: Data,
	) {
		return c.json({ success: true, code: 200, message, data }, 200);
	}

	static successNoData(c: Context, message: string) {
		return c.json({ success: true, code: 200, message, data: null }, 200);
	}

	static created<Data extends APIResponse.Types.RequiredReturnData>(
		c: Context,
		message: string,
		data: Data,
	) {
		return c.json({ success: true, code: 201, message, data }, 201);
	}

	static createdNoData(c: Context, message: string) {
		return c.json({ success: true, code: 201, message, data: null }, 201);
	}

	static accepted<Data extends APIResponse.Types.RequiredReturnData>(
		c: Context,
		message: string,
		data: Data,
	) {
		return c.json({ success: true, code: 202, message, data }, 202);
	}

	static serverError(c: Context, message: string) {
		return c.json({ success: false, code: 500, message }, 500);
	}

	static unauthorized(c: Context, message: string) {
		return c.json({ success: false, code: 401, message }, 401);
	}
	static forbidden(c: Context, message: string) {
		return c.json({ success: false, code: 403, message }, 403);
	}

	static badRequest(c: Context, message: string) {
		return c.json({ success: false, code: 400, message }, 400);
	}

	static notFound(c: Context, message: string) {
		return c.json({ success: false, code: 404, message }, 404);
	}

	static conflict(c: Context, message: string) {
		return c.json({ success: false, code: 409, message }, 409);
	}

	static tooManyRequests(c: Context, message: string) {
		return c.json({ success: false, code: 429, message }, 429);
	}

	static badGateway(c: Context, message: string) {
		return c.json({ success: false, code: 502, message }, 502);
	}

	static serviceUnavailable(c: Context, message: string) {
		return c.json({ success: false, code: 503, message }, 503);
	}

	static gatewayTimeout(c: Context, message: string) {
		return c.json({ success: false, code: 504, message }, 504);
	}
}

export namespace APIResponse.Utils {
	export function genericErrorSchema<Code extends number, Message extends string>(
		code: Code,
		message: Message,
	) {
		return z.object({
			success: z.literal(false),
			code: z.literal(code),
			message: z.literal(message),
		});
	}

	export function createErrorSchemaFactory<Code extends number>(code: Code) {
		return function <Message extends string>(message: Message) {
			return genericErrorSchema(code, message);
		};
	}
}

export namespace APIResponse.Schema {
	export function success<
		Message extends string,
		Data extends z.ZodType<APIResponse.Types.NonRequiredReturnData>,
	>(message: Message, data: Data) {
		return z.object({
			success: z.literal(true),
			code: z.literal(200),
			message: z.literal(message),
			data,
		});
	}

	export function accepted<
		Message extends string,
		Data extends z.ZodType<APIResponse.Types.RequiredReturnData>,
	>(message: Message, data: Data) {
		return z.object({
			success: z.literal(true),
			code: z.literal(202),
			message: z.literal(message),
			data,
		});
	}

	export function created<
		Message extends string,
		Data extends z.ZodType<APIResponse.Types.NonRequiredReturnData>,
	>(message: Message, data: Data) {
		return z.object({
			success: z.literal(true),
			code: z.literal(201),
			message: z.literal(message),
			data,
		});
	}

	export const serverError = APIResponse.Utils.createErrorSchemaFactory(500);
	export const unauthorized = APIResponse.Utils.createErrorSchemaFactory(401);
	export const forbidden = APIResponse.Utils.createErrorSchemaFactory(403);
	export const badRequest = APIResponse.Utils.createErrorSchemaFactory(400);
	export const notFound = APIResponse.Utils.createErrorSchemaFactory(404);
	export const conflict = APIResponse.Utils.createErrorSchemaFactory(409);
	export const tooManyRequests = APIResponse.Utils.createErrorSchemaFactory(429);
	export const badGateway = APIResponse.Utils.createErrorSchemaFactory(502);
	export const serviceUnavailable = APIResponse.Utils.createErrorSchemaFactory(503);
	export const gatewayTimeout = APIResponse.Utils.createErrorSchemaFactory(504);
}

export namespace APIResponse.Types {
	// Can be JSON object or Array
	export type RequiredReturnData = { [key: string]: any } | Array<any>;

	export type NonRequiredReturnData = null | RequiredReturnData;

	export type BasicReturnData =
		| ReturnType<typeof APIResponse.success>
		| ReturnType<typeof APIResponse.accepted>
		| ReturnType<typeof APIResponse.created>
		| ReturnType<typeof APIResponse.serverError>
		| ReturnType<typeof APIResponse.unauthorized>
		| ReturnType<typeof APIResponse.forbidden>
		| ReturnType<typeof APIResponse.badRequest>
		| ReturnType<typeof APIResponse.notFound>
		| ReturnType<typeof APIResponse.conflict>
		| ReturnType<typeof APIResponse.tooManyRequests>;

	export type BasicResponseSchema =
		| z.infer<ReturnType<typeof APIResponse.Schema.success<any, z.ZodType<NonRequiredReturnData>>>>
		| z.infer<ReturnType<typeof APIResponse.Schema.accepted<any, z.ZodType<RequiredReturnData>>>>
		| z.infer<ReturnType<typeof APIResponse.Schema.created<any, z.ZodType<RequiredReturnData>>>>
		| z.infer<ReturnType<typeof APIResponse.Schema.serverError<any>>>
		| z.infer<ReturnType<typeof APIResponse.Schema.unauthorized<any>>>
		| z.infer<ReturnType<typeof APIResponse.Schema.forbidden<any>>>
		| z.infer<ReturnType<typeof APIResponse.Schema.badRequest<any>>>
		| z.infer<ReturnType<typeof APIResponse.Schema.notFound<any>>>
		| z.infer<ReturnType<typeof APIResponse.Schema.conflict<any>>>
		| z.infer<ReturnType<typeof APIResponse.Schema.tooManyRequests<any>>>;
}

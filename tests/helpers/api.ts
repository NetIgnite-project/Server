import { expect } from "bun:test";
import { ZodType, z } from "zod";
import { API } from "../../server/lib/api";
import { Logger } from "../../server/lib/utils/logger";

type HeadersInit = RequestInit["headers"];

export async function makeAPIRequest<ReturnBody = any>(
	path: string,
	opts: {
		method?: "GET" | "POST" | "PUT" | "DELETE";
		authToken?: string;
		body?: Record<string, any>;
		expectedBodySchema?: ZodType<ReturnBody>;
		additionalOptions?: RequestInit;
	} = {},
	expectedCode?: number,
) {
	const baseHeaders: HeadersInit = {
		...(opts.body ? { "Content-Type": "application/json" } : {}),
		...(opts.authToken ? { Authorization: `Bearer ${opts.authToken}` } : {}),
	};

	if (opts.additionalOptions?.headers) {
		const extraHeaders = opts.additionalOptions.headers as HeadersInit;
		if (extraHeaders instanceof Headers) {
			extraHeaders.forEach((value, key) => {
				(baseHeaders as Record<string, string>)[key] = value;
			});
		} else {
			Object.assign(baseHeaders as Record<string, string>, extraHeaders as Record<string, string>);
		}
	}

	const resolvedBody =
		opts.additionalOptions?.body ?? (opts.body ? JSON.stringify(opts.body) : undefined);

	const options: RequestInit = {
		method: opts.method ?? opts.additionalOptions?.method ?? "GET",
		...opts.additionalOptions,
		headers: baseHeaders,
		body: resolvedBody,
	};

	const res = await API.getApp().request(path, options);

	if (!expectedCode) {
		const successStatusCodes = [200, 201, 202, 204];

		if (!successStatusCodes.includes(res.status)) {
			const errorText = await res.text();
			Logger.error(`Expected status 2xx but got ${res.status}. Response body: ${errorText}`);
		}

		expect(res.status).toBeOneOf(successStatusCodes);
	} else {
		if (res.status !== expectedCode) {
			const errorText = await res.text();
			Logger.error(
				`Expected status ${expectedCode} but got ${res.status}. Response body: ${errorText}`,
			);
		}

		expect(res.status).toBe(expectedCode);
	}

	const contentType = res.headers.get("content-type") || "";
	const resBody = contentType.includes("application/json") ? ((await res.json()) as any) : null;

	if (opts.expectedBodySchema && resBody) {
		const parseResult = opts.expectedBodySchema.safeParse(resBody.data || {});
		if (parseResult.success) {
			expect(parseResult.success).toBe(true);
			return parseResult.data;
		} else {
			Logger.error("Response body did not match expected schema:", parseResult.error.message);
			//@ts-ignore
			expect(parseResult.success).toBe(true);
		}
	}

	if (resBody && typeof resBody === "object" && "data" in resBody) {
		return (resBody as any).data as ReturnBody;
	}

	return null as any as ReturnBody;
}

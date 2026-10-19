import type {
	GetAccountApikeysResponses,
	GetAccountResponses,
	GetAgentsResponses,
	GetDevicesByDeviceIdSharesResponses,
	GetDevicesResponses,
	PostAccountApikeysData,
	PostAgentsData,
	PostDevicesData,
} from "~/api-client";

export namespace UtilityTypes {
	export type SomePartial<T, K extends keyof T> = Partial<Pick<T, K>> & Omit<T, K>;
}

export type UserInfo = GetAccountResponses["200"]["data"];

export type APIKey = GetAccountApikeysResponses["200"]["data"][number];
export type NewAPIKey = NonNullable<PostAccountApikeysData["body"]>;

export type Agent = GetAgentsResponses["200"]["data"][number];
export type NewAgent = NonNullable<PostAgentsData["body"]>;

export type Device = GetDevicesResponses["200"]["data"][number];
export type NewDevice = NonNullable<PostDevicesData["body"]>;
export type DeviceShare = GetDevicesByDeviceIdSharesResponses["200"]["data"][number];

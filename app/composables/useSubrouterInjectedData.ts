import type { UtilityTypes } from "~/utils/types";
import type { UseAPITypes } from "./useAPI";

export namespace UseSubrouterInjectedDataTypes {
	export type SubrouterInjectedData<T> = UseAPITypes.AsyncDataReturn<T>;

	export interface SubrouterInjectedDataWithNew<T, NewT, IsNew extends boolean>
		extends UseAPITypes.AsyncDataReturn<IsNew extends true ? NewT : T> {
		isNew: IsNew;
	}

	export interface SubrouterInjectedDataWithNewProvideArgs<T, NewT, IsNew extends true>
		extends UtilityTypes.SomePartial<
			SubrouterInjectedDataWithNew<T, NewT, IsNew>,
			"loading" | "refresh"
		> {}

	export type SubrouterInjectedDataUnion<
		T,
		NewT,
		IncludeNew extends boolean,
	> = IncludeNew extends true
		? SubrouterInjectedDataWithNew<T, NewT, true> | SubrouterInjectedDataWithNew<T, NewT, false>
		: SubrouterInjectedData<T>;

	export type SubrouterInjectedDataProvideArgsUnion<
		T,
		NewT,
		IncludeNew extends boolean,
	> = IncludeNew extends true
		?
				| SubrouterInjectedDataWithNewProvideArgs<T, NewT, true>
				| SubrouterInjectedDataWithNew<T, NewT, false>
		: SubrouterInjectedData<T>;
}

class SubrouterInjectedDataHandler<T, NewT, IncludeNew extends boolean = false> {
	constructor(
		protected readonly key: string,
		protected readonly includeNew: IncludeNew,
	) {}

	public inject() {
		return inject(this.key) as UseSubrouterInjectedDataTypes.SubrouterInjectedDataUnion<
			T,
			NewT,
			IncludeNew
		>;
	}

	public provide<
		DataT extends UseSubrouterInjectedDataTypes.SubrouterInjectedDataProvideArgsUnion<
			T,
			NewT,
			IncludeNew
		>,
	>(data: DataT) {
		const finalData = { ...data };

		if ((data as any).isNew && this.includeNew) {
			if (!finalData.loading) {
				finalData.loading = ref(false);
			}
			if (!finalData.refresh) {
				finalData.refresh = async () => void 0;
			}
		}

		provide(this.key, finalData);
	}
}

export function useSubrouterInjectedData<T, NewT extends never = never>(
	key: string,
	includeNew?: false,
): SubrouterInjectedDataHandler<T, NewT, false>;
export function useSubrouterInjectedData<T, NewT>(
	key: string,
	includeNew: true,
): SubrouterInjectedDataHandler<T, NewT, true>;
export function useSubrouterInjectedData<T, NewT>(
	key: string,
	includeNew: boolean,
): SubrouterInjectedDataHandler<T, NewT, boolean>;
export function useSubrouterInjectedData(key: string, includeNew = false) {
	return new SubrouterInjectedDataHandler(key, includeNew);
}

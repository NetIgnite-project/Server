import type { BreadcrumbItem, NavigationMenuItem } from "@nuxt/ui";
import { SimpleRouteMatcher } from "~/utils/routeMatcher";

type NavigationMenuItemWithoutTo = NavigationMenuItem & { to?: any };

export namespace UseSubrouterPathDynamics {
	export interface PathDynamicValues {
		breadcrumbItems: BreadcrumbItem[];
	}

	export interface RichPathDynamicValues extends PathDynamicValues {
		seoSettings: {
			title?: string;
			description: string;
		} & Parameters<typeof useSeoMeta>[0];
	}

	export interface SubrouterPathDynamicsValue extends NavigationMenuItemWithoutTo {
		isNavLink: boolean;
		getDynamicValues: (
			routeParams: Record<string, string>,
		) => Promise<RichPathDynamicValues> | RichPathDynamicValues;
	}

	export interface RoutesConfig {
		[path: string]: SubrouterPathDynamicsValue;
	}

	export interface SubrouterPathDynamicsSettings {
		baseTitle: string;
		basebreadcrumbItems?: BreadcrumbItem[];
		/**
		 * The path dynamics for each subrouter path.
		 * Example:
		 * {
		 *   '/dashboard/packages/[package_name]': { ... },
		 *   '/dashboard/packages/[package_name]/releases': { ... },
		 */
		routes: Ref<RoutesConfig> | RoutesConfig;
	}

	export type SubrouterPathDynamicsReturn = {
		pathDynamicValues: Ref<PathDynamicValues>;
		links: NavigationMenuItem[];
	};
}

class SubrouterPathDynamics<
	Settings extends UseSubrouterPathDynamics.SubrouterPathDynamicsSettings,
> {
	readonly links: Settings["routes"] extends Ref<any>
		? Ref<NavigationMenuItem[][]>
		: NavigationMenuItem[][];

	constructor(private readonly options: Settings) {
		if (isRef(this.options.routes)) {
			//@ts-expect-error
			this.links = computed(() => {
				const links: NavigationMenuItem[] = [];
				for (const [path, dynamics] of Object.entries(this.options.routes.value)) {
					if (dynamics.isNavLink) {
						links.push({
							...dynamics,
							to: path,
						});
					}
				}
				return [links];
			});
		} else {
			const links: NavigationMenuItem[] = [];
			for (const [path, dynamics] of Object.entries(options.routes)) {
				if (dynamics.isNavLink) {
					links.push({
						...dynamics,
						to: path,
					});
				}
			}
			//@ts-expect-error
			this.links = [links];
		}
	}

	async getPathDynamicValues(path: string): Promise<UseSubrouterPathDynamics.RichPathDynamicValues> {
		const breadcrumbItems: BreadcrumbItem[] = [...(this.options.basebreadcrumbItems ?? [])];

		const routeSettings = await SimpleRouteMatcher.match(
			path,
			Object.keys(isRef(this.options.routes) ? this.options.routes.value : this.options.routes),
		);
		const routeDynamics = routeSettings
			? (isRef(this.options.routes) ? this.options.routes.value : this.options.routes)[
					routeSettings.route
				]
			: undefined;
		if (!routeSettings || !routeDynamics) {
			return { breadcrumbItems, seoSettings: { title: this.options.baseTitle, description: "" } };
		}

		const dynamicValues = await routeDynamics.getDynamicValues(routeSettings.params);
		breadcrumbItems.push(...dynamicValues.breadcrumbItems);

		const seoSettings = {
			...dynamicValues.seoSettings,
			title: dynamicValues.seoSettings.title
				? `${dynamicValues.seoSettings.title} | ${this.options.baseTitle}`
				: this.options.baseTitle,
		};

		return { breadcrumbItems, seoSettings };
	}
}

export function useSubrouterPathDynamics<
	Settings extends UseSubrouterPathDynamics.SubrouterPathDynamicsSettings,
>(options: Settings) {
	return new SubrouterPathDynamics<Settings>(options);
}

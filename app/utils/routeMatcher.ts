type RouteMatch = {
	route: string;
	params: Record<string, string>;
} | null;

export class SimpleRouteMatcher {
	constructor(protected readonly routes: string[]) {}

	match(path: string): RouteMatch {
		return SimpleRouteMatcher.match(path, this.routes);
	}

	addRoute(route: string): void {
		this.routes.push(route);
	}

	removeRoute(route: string): void {
		const index = this.routes.indexOf(route);
		if (index !== -1) {
			this.routes.splice(index, 1);
		}
	}

	static match(path: string, routes: string[]): RouteMatch | null {
		const normalizedPath = path.replace(/\/+$/, "") || "/";

		const staticRoutes: string[] = [];
		const dynamicRoutes: string[] = [];

		for (const route of routes) {
			if (route.includes("[")) {
				dynamicRoutes.push(route);
			} else {
				staticRoutes.push(route);
			}
		}

		// 1) Exact match for static routes
		for (const route of staticRoutes) {
			if (route === normalizedPath) {
				return { route, params: {} };
			}
		}

		// 2) Dynamic routes
		for (const route of dynamicRoutes) {
			const paramNames: string[] = [];

			const regexStr = route.replace(/\//g, "\\/").replace(/\[([^\]]+)\]/g, (_, paramName) => {
				paramNames.push(paramName);
				return "([^\\/]+)";
			});

			const regex = new RegExp(`^${regexStr}$`);
			const match = normalizedPath.match(regex);

			if (match) {
				const params: Record<string, string> = {};
				paramNames.forEach((name, index) => {
					(params[name] as any) = match[index + 1];
				});

				return { route, params };
			}
		}

		return null;
	}
}

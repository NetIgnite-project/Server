import { randomBytes as crypto_randomBytes } from "crypto";
import { mkdir as fs_mkdir } from "fs/promises";

export class Utils {
	static getRandomU32() {
		const timeComponent = Date.now() % 0x100000000;
		const randomComponent = crypto_randomBytes(4).readUInt32BE(0);

		return (timeComponent + randomComponent) % 0x100000000;
	}

	static splitNTimes(str: string, delim: string, count: number) {
		const parts = str.split(delim);
		const tail = parts.slice(count).join(delim);
		const result = parts.slice(0, count);
		if (tail) result.push(tail);
		return result;
	}

	static splitNTimesReverse(str: string, delim: string, count: number) {
		const parts = str.split(delim);
		const head = parts.slice(0, parts.length - count).join(delim);
		const result = parts.slice(parts.length - count);
		if (head) result.unshift(head);
		return result;
	}

	static mergeObjects<T extends object[]>(...objects: T): Utils.MergeArray<T> {
		return Object.assign({}, ...objects) as Utils.MergeArray<T>;
	}

	static sleep(ms: number) {
		return new Promise<void>((resolve) => setTimeout(() => resolve(), ms));
	}

	static async ensureDirectoryExists(path: string) {
		try {
			await fs_mkdir(path, { recursive: true });
		} catch (err) {
			// ignore
		}
	}

	static asExact<Shape>() {
		return <T extends Shape>(obj: T & Utils.DeepExact<Shape, T>): T => obj;
	}
}

export namespace Utils {
	export type MergeArray<T extends object[]> = T extends [infer First, ...infer Rest]
		? First & MergeArray<Rest extends object[] ? Rest : []>
		: {};

	export type CreateError<DoError extends boolean, T = symbol> = DoError extends true
		? CreateError<DoError>
		: T;

	export type SameType<A, B> = CreateError<
		(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? false : true,
		A
	>;

	export type DeepExact<Shape, T> =
		// 1. Bypass functions early
		Shape extends (...args: any[]) => any
			? T
			: // 2. Handle Arrays/Tuples using Mapped Types
				Shape extends readonly any[]
				? T extends readonly any[]
					? { [I in keyof T]: DeepExact<Shape[number], T[I]> }
					: never
				: // 3. Handle Objects
					Shape extends object
					? T extends object
						? {
								[K in keyof T]: K extends keyof Shape ? DeepExact<Shape[K], T[K]> : never;
							}
						: never
					: // 4. Handle Primitives
						T;
}

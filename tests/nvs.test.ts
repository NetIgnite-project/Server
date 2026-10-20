import { describe, expect, test } from "bun:test";
import path from "path";
import { NVSImage } from "../server/lib/firmware/nvs";

const FIXTURES = path.join(import.meta.dir, "fixtures", "nvs");

/**
 * Reads an `nvs_partition_gen.py` CSV (key,type,encoding,value). The fixtures' `.bin` files were
 * generated from these CSVs with Espressif's tool (esp-idf-nvs-partition-gen 0.3.0):
 *
 *   python -X utf8 -m esp_idf_nvs_partition_gen generate <name>.csv <name>.bin 0x5000
 */
async function readCSV(name: string) {
	const lines = (await Bun.file(path.join(FIXTURES, `${name}.csv`)).text())
		.trim()
		.split("\n")
		.slice(1);
	const namespaces: NVSImage.Namespace[] = [];

	for (const line of lines) {
		const [key, type, encoding, ...rest] = line.split(",");
		const value = rest.join(",");
		if (type === "namespace") {
			namespaces.push({ name: key as string, entries: {} });
			continue;
		}
		const entries = (namespaces.at(-1) as NVSImage.Namespace).entries;
		entries[key as string] =
			encoding === "string"
				? { type: "string", value }
				: { type: encoding as "u8" | "u32", value: Number(value) };
	}
	return namespaces;
}

async function reference(name: string) {
	return new Uint8Array(await Bun.file(path.join(FIXTURES, `${name}.bin`)).arrayBuffer());
}

describe("NVS image", () => {
	test("CRC-32 matches zlib.crc32(data, 0xFFFFFFFF)", () => {
		// python -c "import zlib; print(hex(zlib.crc32(b'123456789', 0xFFFFFFFF)))"
		expect(NVSImage.crc32(new TextEncoder().encode("123456789"))).toBe(0xd202d277);
	});

	test("provisioning image is byte-identical to nvs_partition_gen.py", async () => {
		const image = NVSImage.generate(await readCSV("provision"), 0x5000);
		expect(image).toEqual(await reference("provision"));
	});

	test("multi-page image with u8/u32, two namespaces and UTF-8 is byte-identical", async () => {
		const image = NVSImage.generate(await readCSV("multipage"), 0x5000);
		expect(image).toEqual(await reference("multipage"));
	});

	test("rejects invalid keys, values and sizes", () => {
		const one = (entries: Record<string, NVSImage.Value>) => [{ name: "netignite", entries }];

		expect(() => NVSImage.generate(one({}), 0x5001)).toThrow();
		expect(() => NVSImage.generate(one({}), 0x2000)).toThrow();
		expect(() =>
			NVSImage.generate(one({ "a-key-that-is-too-long": { type: "u8", value: 1 } }), 0x5000),
		).toThrow();
		expect(() => NVSImage.generate(one({ level: { type: "u8", value: 256 } }), 0x5000)).toThrow();
		expect(() =>
			NVSImage.generate(one({ big: { type: "string", value: "x".repeat(4000) } }), 0x5000),
		).toThrow();

		const full: Record<string, NVSImage.Value> = {};
		for (let i = 0; i < 40; i++) full[`k${i}`] = { type: "string", value: "x".repeat(1000) };
		expect(() => NVSImage.generate(one(full), 0x5000)).toThrow("don't fit");
	});
});

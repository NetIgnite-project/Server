/**
 * Writes ESP-IDF NVS partition images (format version 2, unencrypted) — the same bytes as
 * Espressif's `nvs_partition_gen.py` for the same entries. The web installer flashes one at the
 * agent's NVS partition, so a new agent boots with its server URL and enrollment token.
 *
 * Layout of a 4 KB page: 32-byte header, 32-byte entry state bitmap, then 126 entries of 32 bytes.
 * A string takes one header entry plus one entry per 32 bytes of data. The last page of the
 * partition stays empty: NVS needs it for garbage collection.
 */
export class NVSImage {
	static readonly PAGE_SIZE = 4096;

	/** Max. length of a key or namespace name in bytes. */
	static readonly MAX_KEY_LENGTH = 15;
	/** Max. size of a string value in bytes, including its terminating NUL. */
	static readonly MAX_STRING_SIZE = 4000;

	/**
	 * Builds an image of `size` bytes (a multiple of 4096, at least 3 pages) with the namespaces in
	 * order. Throws if an entry is invalid or doesn't fit.
	 */
	static generate(namespaces: NVSImage.Namespace[], size: number): Uint8Array<ArrayBuffer> {
		if (size % this.PAGE_SIZE !== 0 || size < 3 * this.PAGE_SIZE) {
			throw new Error("The NVS partition size must be a multiple of 4096 and at least 12288 bytes");
		}

		const writer = new PageWriter(size / this.PAGE_SIZE - 1);
		let namespaceIndex = 0;

		for (const namespace of namespaces) {
			namespaceIndex += 1;
			writer.writePrimitive(0, namespace.name, { type: "u8", value: namespaceIndex });

			for (const [key, value] of Object.entries(namespace.entries)) {
				if (value.type === "string") {
					writer.writeString(namespaceIndex, key, value.value);
				} else {
					writer.writePrimitive(namespaceIndex, key, value);
				}
			}
		}

		const image = new Uint8Array(size).fill(0xff);
		writer.pages.forEach((page, index) => {
			image.set(page.buffer, index * this.PAGE_SIZE);
		});
		return image;
	}

	/** CRC-32 as computed by `zlib.crc32(data, 0xFFFFFFFF)`, which NVS uses everywhere. */
	static crc32(data: Uint8Array) {
		let crc = 0;
		for (const byte of data) {
			crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
		}
		return ~crc >>> 0;
	}
}

export namespace NVSImage {
	export type Value = { type: "string"; value: string } | { type: "u8" | "u32"; value: number };

	export interface Namespace {
		name: string;
		entries: Record<string, Value>;
	}
}

const ENTRY_SIZE = 32;
const FIRST_ENTRY_OFFSET = 64;
const ENTRIES_PER_PAGE = 126;

const PAGE_STATE_ACTIVE = 0xfffffffe;
const PAGE_STATE_FULL = 0xfffffffc;
const PAGE_VERSION_2 = 0xfe;
const CHUNK_ANY = 0xff;

const ItemType = { u8: 0x01, u32: 0x04, string: 0x21 } as const;

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

class PageFullError extends Error {}

class Page {
	readonly buffer = new Uint8Array(NVSImage.PAGE_SIZE).fill(0xff);
	private readonly view = new DataView(this.buffer.buffer);
	entryCount = 0;

	constructor(sequence: number) {
		this.view.setUint32(0, PAGE_STATE_ACTIVE, true);
		this.view.setUint32(4, sequence, true);
		this.buffer[8] = PAGE_VERSION_2;
		this.view.setUint32(28, NVSImage.crc32(this.buffer.subarray(4, 28)), true);
	}

	markFull() {
		this.view.setUint32(0, PAGE_STATE_FULL, true);
	}

	/** Writes `data` from the next free entry on and marks `count` entries as written. */
	write(data: Uint8Array, count: number) {
		this.buffer.set(data, FIRST_ENTRY_OFFSET + ENTRY_SIZE * this.entryCount);
		for (let i = 0; i < count; i++) {
			// Two bits per entry: 11 empty, 10 written.
			const bit = this.entryCount * 2;
			(this.buffer[32 + (bit >> 3)] as number) &= ~(1 << (bit & 7));
			this.entryCount += 1;
		}
	}
}

class PageWriter {
	readonly pages: Page[] = [new Page(0)];

	constructor(private readonly maxPages: number) {}

	private get current() {
		return this.pages[this.pages.length - 1] as Page;
	}

	private withNewPageOnFull(write: (page: Page) => void) {
		try {
			write(this.current);
		} catch (error) {
			if (!(error instanceof PageFullError)) throw error;
			if (this.pages.length >= this.maxPages) {
				throw new Error("The entries don't fit into the NVS partition");
			}
			this.current.markFull();
			this.pages.push(new Page(this.pages.length));
			write(this.current);
		}
	}

	writePrimitive(namespaceIndex: number, key: string, value: { type: "u8" | "u32"; value: number }) {
		const limit = value.type === "u8" ? 0xff : 0xffffffff;
		if (!Number.isInteger(value.value) || value.value < 0 || value.value > limit) {
			throw new Error(`NVS: ${key} isn't a valid ${value.type}`);
		}

		const entry = entryHeader(namespaceIndex, ItemType[value.type], 1, key);
		const view = new DataView(entry.buffer);
		if (value.type === "u8") entry[24] = value.value;
		else view.setUint32(24, value.value, true);
		setEntryCRC(entry);

		this.withNewPageOnFull((page) => {
			if (page.entryCount >= ENTRIES_PER_PAGE) throw new PageFullError();
			page.write(entry, 1);
		});
	}

	writeString(namespaceIndex: number, key: string, value: string) {
		const data = new TextEncoder().encode(`${value}\0`);
		if (data.length > NVSImage.MAX_STRING_SIZE) {
			throw new Error(`NVS: ${key} is longer than ${NVSImage.MAX_STRING_SIZE - 1} bytes`);
		}
		const dataEntries = Math.ceil(data.length / ENTRY_SIZE);

		const entry = entryHeader(namespaceIndex, ItemType.string, dataEntries + 1, key);
		const view = new DataView(entry.buffer);
		view.setUint16(24, data.length, true);
		view.setUint32(28, NVSImage.crc32(data), true);
		setEntryCRC(entry);

		this.withNewPageOnFull((page) => {
			// Like nvs_partition_gen.py: a string never ends in the page's last entry.
			if (page.entryCount + dataEntries + 1 >= ENTRIES_PER_PAGE) throw new PageFullError();
			page.write(entry, 1);
			page.write(data, dataEntries);
		});
	}
}

function entryHeader(namespaceIndex: number, type: number, span: number, key: string) {
	const keyBytes = new TextEncoder().encode(key);
	if (keyBytes.length === 0 || keyBytes.length > NVSImage.MAX_KEY_LENGTH) {
		throw new Error(`NVS: key "${key}" must be 1–${NVSImage.MAX_KEY_LENGTH} bytes long`);
	}

	const entry = new Uint8Array(ENTRY_SIZE).fill(0xff);
	entry[0] = namespaceIndex;
	entry[1] = type;
	entry[2] = span;
	entry[3] = CHUNK_ANY;
	entry.fill(0, 8, 24);
	entry.set(keyBytes, 8);
	return entry;
}

/** The entry's CRC covers everything except the CRC field (bytes 4–7). */
function setEntryCRC(entry: Uint8Array) {
	const data = new Uint8Array(28);
	data.set(entry.subarray(0, 4), 0);
	data.set(entry.subarray(8, 32), 4);
	new DataView(entry.buffer).setUint32(4, NVSImage.crc32(data), true);
}

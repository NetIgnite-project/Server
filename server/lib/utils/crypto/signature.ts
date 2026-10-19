import elliptic from "elliptic";
import { FixedUint, Uint8, Uint64 } from "low-level";

export interface EllipticBinarySignature extends elliptic.ec.Signature {
	recoveryParam: number;
}

export class Signature extends FixedUint {
	public static override byteLength = 66;

	public static fromElliptic(signature: EllipticBinarySignature) {
		return this.concat([
			signature.r.toArrayLike(Buffer),
			signature.s.toArrayLike(Buffer),
			Uint8.from(signature.recoveryParam),
		]);
	}

	public getElliptic() {
		return {
			r: this.buffer.subarray(1, 33),
			s: this.buffer.subarray(33, 65),
			recoveryParam: this.buffer.subarray(65, 66).readUint8(0),
		};
	}

	public getRecoveryParam() {
		return this.buffer.subarray(65, 66).readUint8(0);
	}
}

export class FullSignature {
	public r: Uint64;
	public s: Uint64;
	public recoveryParam: number;

	constructor(r: Uint64, s: Uint64, recoveryParam: number) {
		this.r = r;
		this.s = s;
		this.recoveryParam = recoveryParam;
	}

	public static fromRaw(raw: Signature) {
		return new this(
			new Uint64(raw.slice(1, 33).getRaw()),
			new Uint64(raw.slice(33, 65).getRaw()),
			raw.slice(65, 66).getRaw().readUint8(0),
		);
	}

	public getRaw() {
		return Signature.concat([this.r, this.s, Uint8.from(this.recoveryParam)]);
	}

	public getElliptic() {
		return {
			r: this.r.getRaw(),
			s: this.s.getRaw(),
			recoveryParam: this.recoveryParam,
		};
	}
}

import { type ec as ellipticCurve } from "elliptic";
import { FixedUint, Uint, Uint256 } from "low-level";
import { LCrypt } from "./lcrypt";
import { type EllipticBinarySignature, Signature } from "./signature";

type NewKeyPair<T> = new (keyPair: ellipticCurve.KeyPair) => T;

export class PublicKey extends FixedUint {
	public static override readonly byteLength = 33;
}

export class PrivateKey extends Uint256 {}

export class SharedSecret extends Uint256 {}

export class PublicKeyPair {
	protected keyPair: ellipticCurve.KeyPair;

	constructor(keyPair: PublicKeyPair | ellipticCurve.KeyPair) {
		this.keyPair = keyPair instanceof PublicKeyPair ? keyPair.keyPair : keyPair;
	}

	static fromPrivate<T>(this: NewKeyPair<T>, privateKey: PrivateKey) {
		return new this(LCrypt.ec.keyFromPrivate(privateKey.getRaw()));
	}

	static fromPublic<T>(this: NewKeyPair<T>, publicKey: PublicKey) {
		return new this(LCrypt.ec.keyFromPublic(publicKey.getRaw()));
	}

	public getPublic() {
		return PublicKey.from(this.keyPair.getPublic(true, "array"));
	}

	public getPrivate() {
		return PrivateKey.from(this.keyPair.getPrivate().toBuffer());
	}
}

export class KeyPair extends PublicKeyPair {
	public derive(publicKey: PublicKey) {
		return new SharedSecret(
			this.keyPair.derive(KeyPair.fromPublic(publicKey).keyPair.getPublic()).toBuffer(),
		);
	}

	public sign(msg: Uint) {
		return this.keyPair.sign(msg.getRaw()) as EllipticBinarySignature;
	}

	public verify(msg: Uint, signature: Signature) {
		return this.keyPair.verify(msg.getRaw(), signature.getElliptic());
	}
}

import { createHmac, timingSafeEqual } from "node:crypto";

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export class Signer {
  constructor(private readonly key: string) {}

  private mac(data: string): string {
    return createHmac("sha256", this.key).update(data).digest("base64url");
  }

  sign(payload: object): string {
    const body = b64(JSON.stringify(payload));
    return `${body}.${this.mac(body)}`;
  }

  verify<T>(token: string): T | undefined {
    const [body, sig] = token.split(".");
    if (!body || !sig) return undefined;
    if (!safeEqual(sig, this.mac(body))) return undefined;
    try {
      return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
    } catch {
      return undefined;
    }
  }

  derive(label: string): string {
    return this.mac(`derive:${label}`);
  }
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

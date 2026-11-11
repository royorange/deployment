import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
} from "node:crypto";
import { readPrivate, writePrivate } from "./files.ts";

export type Values = Record<string, string>;
export type VaultData = {
  credentials: Values;
  profiles: Record<string, Values>;
};
const derive = (password: string, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      32,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
const aad = Buffer.from("project-setup:v1:scrypt-32768-8-1:aes-256-gcm");
type Envelope = {
  version: number;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

function decode(value: unknown, length?: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    throw new Error("invalid");
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.toString("base64") !== value ||
    (length !== undefined && bytes.length !== length)
  )
    throw new Error("invalid");
  return bytes;
}
function dictionary(value: unknown): value is Values {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([key, val]) =>
        !["__proto__", "constructor", "prototype"].includes(key) &&
        typeof val === "string",
    )
  );
}

export class Vault {
  data: VaultData = { credentials: {}, profiles: {} };
  private previous: string | null = null;
  private key!: Buffer;
  private salt!: Buffer;
  private path!: string;

  static async open(path: string, password: string): Promise<Vault> {
    if (password.length < 12) throw new Error("保险库口令至少 12 个字符。");
    const vault = new Vault();
    vault.path = path;
    vault.previous = (await readPrivate(path)) ?? null;
    let envelope: Envelope | undefined;
    try {
      envelope = vault.previous
        ? (JSON.parse(vault.previous) as Envelope)
        : undefined;
      if (envelope && envelope.version !== 1) throw new Error("invalid");
      vault.salt = envelope ? decode(envelope.salt, 16) : randomBytes(16);
      vault.key = await derive(password, vault.salt);
      if (envelope) {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          vault.key,
          decode(envelope.iv, 12),
        );
        decipher.setAAD(aad);
        decipher.setAuthTag(decode(envelope.tag, 16));
        const plain = Buffer.concat([
          decipher.update(decode(envelope.ciphertext)),
          decipher.final(),
        ]);
        try {
          const data = JSON.parse(plain.toString("utf8")) as VaultData;
          if (
            !dictionary(data.credentials) ||
            !data.profiles ||
            Array.isArray(data.profiles) ||
            !Object.values(data.profiles).every(dictionary)
          )
            throw new Error("invalid");
          vault.data = data;
        } finally {
          plain.fill(0);
        }
      }
      return vault;
    } catch {
      vault.key?.fill(0);
      throw new Error("保险库解锁失败：口令错误或文件已损坏；不会覆盖原文件。");
    }
  }

  async save(): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(aad);
    const plaintext = Buffer.from(JSON.stringify(this.data));
    let ciphertext: Buffer;
    try {
      ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    } finally {
      plaintext.fill(0);
    }
    const contents = JSON.stringify({
      version: 1,
      salt: this.salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    });
    await writePrivate(this.path, contents, this.previous);
    this.previous = contents;
  }

  close(): void {
    this.key.fill(0);
    this.data = { credentials: {}, profiles: {} };
  }
}

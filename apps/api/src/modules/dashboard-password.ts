import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const HASH_PREFIX = "scrypt:v1";
const KEY_LENGTH = 64;
const SALT_BYTES = 24;

export async function hashDashboardPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES).toString("base64url");
  const derived = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return `${HASH_PREFIX}:${salt}:${derived.toString("base64url")}`;
}

export async function verifyDashboardPassword(password: string, passwordHash: string): Promise<boolean> {
  const [prefix, version, salt, encodedHash] = passwordHash.split(":");
  if (`${prefix}:${version}` !== HASH_PREFIX || !salt || !encodedHash) return false;

  const expected = Buffer.from(encodedHash, "base64url");
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

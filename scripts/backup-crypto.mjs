import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import {
  appendFileSync,
  createReadStream,
  createWriteStream,
  openSync,
  closeSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";

const MAGIC = Buffer.from("AMBBK001", "ascii");
const SALT_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + SALT_BYTES + NONCE_BYTES;
const SCRYPT_OPTIONS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

function readPassword() {
  const raw = readFileSync(0);
  if (raw.length > 4096) {
    raw.fill(0);
    throw new Error("Backup encryption password input is unexpectedly large");
  }
  let end = raw.length;
  if (end > 0 && raw[end - 1] === 0x0a) end -= 1;
  if (end > 0 && raw[end - 1] === 0x0d) end -= 1;
  const password = Buffer.from(raw.subarray(0, end));
  raw.fill(0);
  if (password.length < 32) {
    password.fill(0);
    throw new Error("Backup encryption password must contain at least 32 bytes");
  }
  return password;
}

function deriveKey(password, salt) {
  try {
    return scryptSync(password, salt, 32, SCRYPT_OPTIONS);
  } finally {
    password.fill(0);
  }
}

async function encrypt(inputPath, outputPath, password) {
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const header = Buffer.concat([MAGIC, salt, nonce]);
  const key = deriveKey(password, salt);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(header);
    writeFileSync(outputPath, header, { flag: "wx", mode: 0o600 });
    await pipeline(
      createReadStream(inputPath),
      cipher,
      createWriteStream(outputPath, { flags: "a", mode: 0o600 }),
    );
    appendFileSync(outputPath, cipher.getAuthTag());
  } finally {
    key.fill(0);
  }
}

async function decrypt(inputPath, outputPath, password) {
  const size = statSync(inputPath).size;
  if (size <= HEADER_BYTES + TAG_BYTES) throw new Error("Encrypted backup is truncated");

  const fd = openSync(inputPath, "r");
  const header = Buffer.alloc(HEADER_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  try {
    if (readSync(fd, header, 0, header.length, 0) !== header.length) {
      throw new Error("Encrypted backup header is truncated");
    }
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error("Unsupported encrypted backup format");
    }
    if (readSync(fd, tag, 0, tag.length, size - TAG_BYTES) !== tag.length) {
      throw new Error("Encrypted backup authentication tag is truncated");
    }
  } finally {
    closeSync(fd);
  }

  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
  const nonce = header.subarray(MAGIC.length + SALT_BYTES);
  const key = deriveKey(password, salt);
  const temporaryOutput = `${outputPath}.partial-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    await pipeline(
      createReadStream(inputPath, { start: HEADER_BYTES, end: size - TAG_BYTES - 1 }),
      decipher,
      createWriteStream(temporaryOutput, { flags: "wx", mode: 0o600 }),
    );
    renameSync(temporaryOutput, outputPath);
  } finally {
    key.fill(0);
    rmSync(temporaryOutput, { force: true });
  }
}

const [operation, inputPath, outputPath] = process.argv.slice(2);
if (!operation || !inputPath || !outputPath || !["encrypt", "decrypt"].includes(operation)) {
  throw new Error("Usage: backup-crypto.mjs <encrypt|decrypt> <input> <output>");
}

const password = readPassword();
if (operation === "encrypt") await encrypt(inputPath, outputPath, password);
else await decrypt(inputPath, outputPath, password);

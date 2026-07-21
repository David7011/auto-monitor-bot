export class ResponseTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Response exceeded the ${maxBytes} byte limit`);
    this.name = "ResponseTooLargeError";
  }
}

export async function readResponseBuffer(response: Response, maxBytes: number): Promise<Buffer> {
  const safeLimit = Math.max(1, Math.trunc(maxBytes));
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > safeLimit) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError(safeLimit);
  }

  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > safeLimit) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError(safeLimit);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } finally {
    reader.releaseLock();
  }
}

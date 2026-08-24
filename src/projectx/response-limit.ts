export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class ResponseTooLargeError extends Error {
  public constructor(public readonly maxBytes: number) {
    super(`ProjectX response exceeded ${maxBytes} bytes`);
    this.name = "ResponseTooLargeError";
  }
}

export async function readLimitedResponseText(
  response: Response,
  maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ResponseTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

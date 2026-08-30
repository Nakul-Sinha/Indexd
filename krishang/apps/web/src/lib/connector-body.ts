export const MAX_CONNECTOR_BODY_BYTES = 16 * 1024;

export class ConnectorBodyTooLargeError extends Error {
  constructor() {
    super("Connector request body exceeds the allowed size.");
    this.name = "ConnectorBodyTooLargeError";
  }
}

export async function readConnectorBody(
  request: Request,
  maxBytes = MAX_CONNECTOR_BODY_BYTES,
): Promise<ArrayBuffer | undefined> {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || !request.body) return undefined;

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
      throw new ConnectorBodyTooLargeError();
    }
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ConnectorBodyTooLargeError();
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

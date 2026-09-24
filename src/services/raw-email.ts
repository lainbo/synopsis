export interface RawEmailData {
  bytes: Uint8Array;
  rawSize: number;
}

export async function readRawEmail(
  message: ForwardableEmailMessage
): Promise<RawEmailData> {
  const arrayBuffer = await new Response(message.raw).arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  return {
    bytes,
    rawSize: typeof message.rawSize === "number" ? message.rawSize : bytes.byteLength
  };
}

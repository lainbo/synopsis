export async function putKvValue(
  kv: KVNamespace,
  key: string,
  value: string,
  options?: KVNamespacePutOptions
): Promise<void> {
  try {
    await kv.put(key, value, options);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("KV PUT failed: 429")) {
      throw error;
    }

    // KV 同一个 key 每秒只能写入一次。
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await kv.put(key, value, options);
  }
}

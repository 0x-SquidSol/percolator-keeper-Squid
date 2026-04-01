export function validateKeeperEnvGuards(env: NodeJS.ProcessEnv = process.env): void {
  const supabaseKey = env.SUPABASE_KEY?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (supabaseKey && serviceRoleKey && supabaseKey === serviceRoleKey) {
    throw new Error(
      "Keeper misconfiguration: SUPABASE_KEY must not equal SUPABASE_SERVICE_ROLE_KEY. " +
      "Set SUPABASE_KEY to the anon key for keeper runtime."
    );
  }

  // Reject insecure (plaintext) RPC URLs unless explicitly allowed.
  // http:// and ws:// transmit signed transactions and account data unencrypted,
  // enabling MITM attacks on the network path.
  const allowInsecure = env.ALLOW_INSECURE_RPC === "true";
  if (!allowInsecure) {
    const rpcUrl = env.SOLANA_RPC_URL?.trim();
    if (rpcUrl && !rpcUrl.startsWith("https://")) {
      throw new Error(
        `SOLANA_RPC_URL must use https:// (got ${rpcUrl.slice(0, 30)}...). ` +
        "Plaintext HTTP exposes signed transactions to MITM. " +
        "Set ALLOW_INSECURE_RPC=true to override for local development."
      );
    }
    const wsUrl = env.SOLANA_RPC_WS_URL?.trim();
    if (wsUrl && !wsUrl.startsWith("wss://")) {
      throw new Error(
        `SOLANA_RPC_WS_URL must use wss:// (got ${wsUrl.slice(0, 30)}...). ` +
        "Plaintext WebSocket exposes account data to MITM. " +
        "Set ALLOW_INSECURE_RPC=true to override for local development."
      );
    }
  }
}

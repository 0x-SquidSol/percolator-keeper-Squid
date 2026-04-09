/** Known devnet RPC hostnames / URL substrings — used to detect network mismatch */
const DEVNET_INDICATORS = ["devnet", "api.devnet.solana.com"];

function looksLikeDevnet(url: string): boolean {
  const lower = url.toLowerCase();
  return DEVNET_INDICATORS.some((indicator) => lower.includes(indicator));
}

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
    // Validate fallback RPC URL — used by discovery and liquidation retry.
    // Same MITM risk as primary: signed transactions sent over plaintext.
    const fallbackRpcUrl = env.FALLBACK_RPC_URL?.trim();
    if (fallbackRpcUrl && !fallbackRpcUrl.startsWith("https://")) {
      throw new Error(
        `FALLBACK_RPC_URL must use https:// (got ${fallbackRpcUrl.slice(0, 30)}...). ` +
        "Plaintext HTTP exposes signed transactions to MITM. " +
        "Set ALLOW_INSECURE_RPC=true to override for local development."
      );
    }
  }

  // C2: On mainnet, FALLBACK_RPC_URL must be explicitly set and must NOT point to devnet.
  // The shared config defaults fallbackRpcUrl to "https://api.devnet.solana.com" when
  // FALLBACK_RPC_URL is unset, which silently sends fallback RPCs (discovery, liquidation
  // retry, 429 read-only retry) to the wrong network.
  if (env.NETWORK === "mainnet") {
    const fallback = env.FALLBACK_RPC_URL?.trim();
    if (!fallback) {
      throw new Error(
        "FALLBACK_RPC_URL must be set when NETWORK=mainnet. " +
        "The shared config defaults to devnet, which would cause fallback RPCs " +
        "to read wrong-network data. Set it to a mainnet RPC endpoint."
      );
    }
    if (looksLikeDevnet(fallback)) {
      throw new Error(
        `FALLBACK_RPC_URL appears to be a devnet endpoint (${fallback.slice(0, 50)}), ` +
        "but NETWORK=mainnet. Fallback RPCs would return wrong-network data. " +
        "Set FALLBACK_RPC_URL to a mainnet RPC endpoint."
      );
    }
  }
}

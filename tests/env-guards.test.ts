import { describe, it, expect } from "vitest";
import { validateKeeperEnvGuards } from "../src/env-guards.js";

describe("validateKeeperEnvGuards", () => {
  it("throws when SUPABASE_KEY equals SUPABASE_SERVICE_ROLE_KEY", () => {
    const env = {
      SUPABASE_KEY: "same-key",
      SUPABASE_SERVICE_ROLE_KEY: "same-key",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).toThrow(
      "Keeper misconfiguration: SUPABASE_KEY must not equal SUPABASE_SERVICE_ROLE_KEY"
    );
  });

  it("does not throw when keys differ", () => {
    const env = {
      SUPABASE_KEY: "anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).not.toThrow();
  });

  it("does not throw when one key is missing", () => {
    const env = {
      SUPABASE_KEY: "anon-key",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).not.toThrow();
  });

  it("throws when SOLANA_RPC_URL uses http://", () => {
    const env = {
      SOLANA_RPC_URL: "http://api.mainnet-beta.solana.com",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).toThrow("must use https://");
  });

  it("throws when SOLANA_RPC_WS_URL uses ws://", () => {
    const env = {
      SOLANA_RPC_WS_URL: "ws://api.mainnet-beta.solana.com",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).toThrow("must use wss://");
  });

  it("allows insecure URLs when ALLOW_INSECURE_RPC=true", () => {
    const env = {
      SOLANA_RPC_URL: "http://localhost:8899",
      SOLANA_RPC_WS_URL: "ws://localhost:8900",
      ALLOW_INSECURE_RPC: "true",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).not.toThrow();
  });

  it("does not throw for https:// and wss:// URLs", () => {
    const env = {
      SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
      SOLANA_RPC_WS_URL: "wss://api.mainnet-beta.solana.com",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).not.toThrow();
  });

  it("throws when FALLBACK_RPC_URL uses http://", () => {
    const env = {
      FALLBACK_RPC_URL: "http://api.devnet.solana.com",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).toThrow("FALLBACK_RPC_URL must use https://");
  });

  it("allows insecure FALLBACK_RPC_URL when ALLOW_INSECURE_RPC=true", () => {
    const env = {
      FALLBACK_RPC_URL: "http://localhost:8899",
      ALLOW_INSECURE_RPC: "true",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).not.toThrow();
  });

  it("does not throw for https:// FALLBACK_RPC_URL", () => {
    const env = {
      FALLBACK_RPC_URL: "https://api.devnet.solana.com",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).not.toThrow();
  });

  // C2: mainnet fallback RPC network mismatch guard
  it("throws when NETWORK=mainnet and FALLBACK_RPC_URL is not set", () => {
    const env = {
      NETWORK: "mainnet",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).toThrow(
      "FALLBACK_RPC_URL must be set when NETWORK=mainnet"
    );
  });

  it("throws when NETWORK=mainnet and FALLBACK_RPC_URL points to devnet", () => {
    const env = {
      NETWORK: "mainnet",
      FALLBACK_RPC_URL: "https://api.devnet.solana.com",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).toThrow(
      "appears to be a devnet endpoint"
    );
  });

  it("throws when NETWORK=mainnet and FALLBACK_RPC_URL contains devnet in Helius URL", () => {
    const env = {
      NETWORK: "mainnet",
      FALLBACK_RPC_URL: "https://devnet.helius-rpc.com/?api-key=abc123",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).toThrow(
      "appears to be a devnet endpoint"
    );
  });

  it("does not throw when NETWORK=mainnet and FALLBACK_RPC_URL is a mainnet endpoint", () => {
    const env = {
      NETWORK: "mainnet",
      FALLBACK_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=abc123",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).not.toThrow();
  });

  it("does not throw when NETWORK=devnet and FALLBACK_RPC_URL is not set", () => {
    const env = {
      NETWORK: "devnet",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).not.toThrow();
  });
});

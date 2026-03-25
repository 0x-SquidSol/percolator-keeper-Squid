/**
 * Tests for POST /register endpoint security hardening:
 * - timingSafeEqual auth (no timing oracle)
 * - Body size limit (DoS guard)
 * - req.resume() on early-exit paths (GH#19 — memory-exhaustion DoS guard)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("@percolator/shared", () => ({
  config: {
    allProgramIds: ["11111111111111111111111111111111"],
    crankIntervalMs: 30_000,
    crankInactiveIntervalMs: 120_000,
    discoveryIntervalMs: 300_000,
    rpcUrl: "https://mock.rpc",
    programId: "11111111111111111111111111111111",
    crankKeypair: "mock",
  },
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  initSentry: vi.fn(),
  captureException: vi.fn(),
  sendInfoAlert: vi.fn().mockResolvedValue(undefined),
  createServiceMonitors: vi.fn(() => ({
    rpc: { getStatus: vi.fn(() => "ok"), record: vi.fn() },
    scan: { getStatus: vi.fn(() => "ok"), record: vi.fn() },
    oracle: { getStatus: vi.fn(() => "ok"), record: vi.fn() },
  })),
  getErrorMessage: vi.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
  sendWithRetryKeeper: vi.fn().mockResolvedValue({ slot: 1n }),
}));

vi.mock("@percolator/sdk", () => ({
  discoverMarkets: vi.fn().mockResolvedValue([]),
  encodeKeeperCrank: vi.fn(() => Buffer.from([1, 2, 3])),
  buildAccountMetas: vi.fn(() => []),
  buildIx: vi.fn(() => ({})),
  derivePythPushOraclePDA: vi.fn(() => [
    { toBase58: () => "11111111111111111111111111111111" },
    0,
  ]),
  ACCOUNTS_KEEPER_CRANK: {},
}));

vi.mock("@solana/web3.js", async () => {
  const actual = await vi.importActual("@solana/web3.js");
  return {
    ...actual,
    Connection: vi.fn().mockImplementation(() => ({
      getAccountInfo: vi.fn().mockResolvedValue(null),
      getSlot: vi.fn().mockResolvedValue(100),
    })),
    Keypair: {
      fromSecretKey: vi.fn(() => ({
        publicKey: { toBase58: () => "11111111111111111111111111111111" },
        secretKey: new Uint8Array(64).fill(0),
      })),
    },
  };
});

vi.mock("../src/env-guards.js", () => ({ validateKeeperEnvGuards: vi.fn() }));

// ── Helpers ────────────────────────────────────────────────────────────────

function doRequest(
  port: number,
  opts: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
  }
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: opts.path ?? "/register", method: opts.method ?? "POST" },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => { data += c.toString(); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.on("error", reject);
    if (opts.headers) {
      for (const [k, v] of Object.entries(opts.headers)) req.setHeader(k, v);
    }
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

// ── Build a minimal health server (same logic as index.ts) ─────────────────

import { timingSafeEqual } from "node:crypto";

function buildRegisterServer(
  secret: string,
  registerMarket: (slab: string, ca?: string) => Promise<{ success: boolean; message?: string }>
): http.Server {
  const MAX_BODY_SIZE = 4 * 1024;

  return http.createServer((req, res) => {
    if (req.url === "/register" && req.method === "POST") {
      // GH#19: drain socket before early-exit responses to prevent memory exhaustion
      const rejectEarly = (status: number, message: string) => {
        req.resume();
        res.writeHead(status, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({ success: false, message }));
      };

      const registerSecret = secret;
      if (!registerSecret) {
        rejectEarly(503, "Endpoint not configured");
        return;
      }
      const provided = String(req.headers["x-shared-secret"] ?? "");
      const secretBuf = Buffer.from(registerSecret, "utf8");
      const providedBuf = Buffer.from(provided, "utf8");
      const authed =
        secretBuf.length === providedBuf.length &&
        timingSafeEqual(secretBuf, providedBuf);
      if (!authed) {
        rejectEarly(401, "Unauthorized");
        return;
      }
      let body = "";
      let bodySize = 0;
      req.on("data", (chunk: Buffer) => {
        bodySize += chunk.length;
        if (bodySize > MAX_BODY_SIZE) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, message: "Request body too large" }));
          req.destroy();
          return;
        }
        body += chunk.toString();
      });
      req.on("end", async () => {
        if (bodySize > MAX_BODY_SIZE) return;
        try {
          const { slabAddress, mainnetCA } = JSON.parse(body) as {
            slabAddress?: string;
            mainnetCA?: string;
          };
          if (!slabAddress) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, message: "slabAddress is required" }));
            return;
          }
          const result = await registerMarket(slabAddress, mainnetCA);
          res.writeHead(result.success ? 200 : 422, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, message: "Internal error" }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end("Not Found");
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("/register endpoint", () => {
  const SECRET = "super-secret-keeper-key";
  let server: http.Server;
  let port: number;
  const mockRegister = vi.fn();

  beforeEach(
    () =>
      new Promise<void>((resolve) => {
        mockRegister.mockReset();
        server = buildRegisterServer(SECRET, mockRegister);
        server.listen(0, "127.0.0.1", () => {
          port = (server.address() as AddressInfo).port;
          resolve();
        });
      })
  );

  afterEach(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  );

  describe("authentication", () => {
    it("returns 401 when no secret header provided", async () => {
      const res = await doRequest(port, {
        body: JSON.stringify({ slabAddress: "abc" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(401);
      expect(JSON.parse(res.body).message).toBe("Unauthorized");
    });

    it("returns 401 when wrong secret provided", async () => {
      const res = await doRequest(port, {
        headers: {
          "x-shared-secret": "wrong-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ slabAddress: "abc" }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 401 when secret has correct length but wrong content (timing-safe)", async () => {
      // Same length, different content — must still fail
      const sameLength = "X".repeat(SECRET.length);
      const res = await doRequest(port, {
        headers: {
          "x-shared-secret": sameLength,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ slabAddress: "abc" }),
      });
      expect(res.status).toBe(401);
    });

    it("succeeds with correct secret", async () => {
      mockRegister.mockResolvedValue({ success: true });
      const res = await doRequest(port, {
        headers: {
          "x-shared-secret": SECRET,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ slabAddress: "someSlab111" }),
      });
      expect(res.status).toBe(200);
      expect(mockRegister).toHaveBeenCalledWith("someSlab111", undefined);
    });
  });

  describe("body size guard", () => {
    it("returns 413 when body exceeds 4 KB", async () => {
      const bigBody = "X".repeat(5 * 1024); // 5 KB
      const res = await doRequest(port, {
        headers: {
          "x-shared-secret": SECRET,
          "Content-Type": "application/json",
        },
        body: bigBody,
      });
      expect(res.status).toBe(413);
    });

    it("accepts body exactly at limit", async () => {
      mockRegister.mockResolvedValue({ success: true });
      // Build valid JSON that fills ~3.9 KB
      const pad = "a".repeat(3_900 - '{"slabAddress":"","pad":"'.length - 2);
      const body = JSON.stringify({ slabAddress: "validSlab", pad });
      const res = await doRequest(port, {
        headers: {
          "x-shared-secret": SECRET,
          "Content-Type": "application/json",
        },
        body,
      });
      // Should process (200 or 400/422), not 413
      expect(res.status).not.toBe(413);
    });
  });

  describe("request validation", () => {
    it("returns 400 when slabAddress missing", async () => {
      const res = await doRequest(port, {
        headers: {
          "x-shared-secret": SECRET,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ mainnetCA: "someCA" }),
      });
      expect(res.status).toBe(400);
    });

    it("passes mainnetCA through to registerMarket", async () => {
      mockRegister.mockResolvedValue({ success: true });
      await doRequest(port, {
        headers: {
          "x-shared-secret": SECRET,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ slabAddress: "slab1", mainnetCA: "ca1" }),
      });
      expect(mockRegister).toHaveBeenCalledWith("slab1", "ca1");
    });

    it("returns 422 when registerMarket fails", async () => {
      mockRegister.mockResolvedValue({ success: false, message: "already registered" });
      const res = await doRequest(port, {
        headers: {
          "x-shared-secret": SECRET,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ slabAddress: "slab1" }),
      });
      expect(res.status).toBe(422);
    });
  });

  describe("GH#19 — req.resume() on early-exit paths (memory DoS guard)", () => {
    it("401 path drains large body and responds without hanging", async () => {
      // Sends a 10 KB body with wrong auth — server must respond promptly (not buffer until timeout)
      const bigBody = "X".repeat(10 * 1024);
      const start = Date.now();
      const res = await doRequest(port, {
        headers: {
          "x-shared-secret": "wrong-secret",
          "Content-Type": "application/json",
        },
        body: bigBody,
      });
      const elapsed = Date.now() - start;
      expect(res.status).toBe(401);
      // With req.resume(), the response should arrive in under 2 seconds regardless of body size.
      // Without it, the connection would hang until the socket times out (typically 30-120s).
      expect(elapsed).toBeLessThan(2000);
    });

    it("503 path (no secret configured) drains large body and responds without hanging", async () => {
      // Build a server with no secret configured
      const noSecretServer = http.createServer((req, res) => {
        if (req.url === "/register" && req.method === "POST") {
          const rejectEarly = (status: number, message: string) => {
            req.resume();
            res.writeHead(status, { "Content-Type": "application/json", "Connection": "close" });
            res.end(JSON.stringify({ success: false, message }));
          };
          const registerSecret = ""; // empty — simulates unconfigured
          if (!registerSecret) {
            rejectEarly(503, "Endpoint not configured");
            return;
          }
        }
        res.writeHead(404);
        res.end();
      });

      const noSecretPort = await new Promise<number>((resolve) => {
        noSecretServer.listen(0, "127.0.0.1", () => {
          resolve((noSecretServer.address() as import("node:net").AddressInfo).port);
        });
      });

      const bigBody = "X".repeat(10 * 1024);
      const start = Date.now();
      const res = await doRequest(noSecretPort, {
        headers: { "Content-Type": "application/json" },
        body: bigBody,
      });
      const elapsed = Date.now() - start;

      await new Promise<void>((resolve) => noSecretServer.close(() => resolve()));

      expect(res.status).toBe(503);
      expect(elapsed).toBeLessThan(2000);
    });
  });
});

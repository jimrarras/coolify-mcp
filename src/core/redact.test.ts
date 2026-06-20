// src/core/redact.test.ts
import { describe, it, expect } from "vitest";
import { SENSITIVE_KEY_RE, redact } from "./redact.js";

describe("SENSITIVE_KEY_RE", () => {
  const shouldMatch = [
    "password",
    "PASSWORD",
    "secret",
    "token",
    "api_key",
    "apikey",
    "private_key",
    "dsn",
    "connection_string",
    "connectionstring",
    "COOLIFY_TOKEN",
    "DB_PASSWORD",
    "SECRET_KEY",
    "access_token",
    "refresh_token",
    "auth_token",
    "env",
    // New additions — R10 redaction-foundation
    "authorization",
    "Authorization",
    "app_key",
    "appkey",
    "database_url",
    "databaseurl",
    "DATABASE_URL",
    "bearer",
    "credential",
    "credentials",
  ];

  const shouldNotMatch = [
    "name",
    "status",
    "uuid",
    "description",
    "build_pack",
    "server_uuid",
    "fqdn",
    "count",
    "message",
    // Word-boundary check: these must NOT be matched after the \benv\b fix
    "environment",
    "environment_name",
    "env_id",
    "envs",
  ];

  for (const key of shouldMatch) {
    it(`matches sensitive key: ${key}`, () => {
      expect(SENSITIVE_KEY_RE.test(key)).toBe(true);
    });
  }

  for (const key of shouldNotMatch) {
    it(`does not match safe key: ${key}`, () => {
      expect(SENSITIVE_KEY_RE.test(key)).toBe(false);
    });
  }
});

describe("redact()", () => {
  it("returns primitives unchanged", () => {
    expect(redact("hello")).toBe("hello");
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBe(undefined);
  });

  it("masks string values under sensitive keys", () => {
    const input = { password: "hunter2", name: "myapp" };
    const output = redact(input) as any;
    expect(output.password).toBe("***REDACTED***");
    expect(output.name).toBe("myapp");
  });

  it("masks string values under sensitive keys", () => {
    const input = { token: "abc123", token_id: 5 };
    const output = redact(input) as any;
    expect(output.token).toBe("***REDACTED***");
    // numeric — NOT a string or Buffer, so left as-is
    expect(output.token_id).toBe(5);
  });

  it("deep-clones — does not mutate the original", () => {
    const input = { password: "secret" };
    redact(input);
    expect(input.password).toBe("secret");
  });

  it("recursively redacts nested objects", () => {
    const input = {
      outer: "visible",
      nested: {
        password: "p@ssw0rd",
        safe: "safe-value",
      },
    };
    const output = redact(input) as any;
    expect(output.nested.password).toBe("***REDACTED***");
    expect(output.nested.safe).toBe("safe-value");
    expect(output.outer).toBe("visible");
  });

  it("recursively redacts items inside arrays", () => {
    const input = [
      { token: "tok1", name: "app1" },
      { token: "tok2", name: "app2" },
    ];
    const output = redact(input) as any[];
    expect(output[0].token).toBe("***REDACTED***");
    expect(output[0].name).toBe("app1");
    expect(output[1].token).toBe("***REDACTED***");
    expect(output[1].name).toBe("app2");
  });

  it("handles deeply nested arrays within objects", () => {
    const input = {
      envs: [
        { key: "DATABASE_URL", value: "postgres://user:pass@host/db" },
        { key: "APP_NAME", value: "myapp" },
      ],
    };
    const output = redact(input) as any;
    // After the \benv\b word-boundary fix, "envs" does NOT match SENSITIVE_KEY_RE
    // so the array is traversed normally; items with "value" key also do NOT match
    expect(Array.isArray(output.envs)).toBe(true);
    expect(output.envs[0].value).toBe("postgres://user:pass@host/db");
  });

  it("never throws for any input shape", () => {
    expect(() => redact(undefined)).not.toThrow();
    expect(() => redact(null)).not.toThrow();
    expect(() => redact({ circular: null as any })).not.toThrow();
    expect(() => redact([[[{ secret: "x" }]]])).not.toThrow();
  });

  it("masks dsn and connection fields", () => {
    const input = { dsn: "postgres://user:pass@host/db", connection: "Server=localhost" };
    const output = redact(input) as any;
    expect(output.dsn).toBe("***REDACTED***");
    expect(output.connection).toBe("***REDACTED***");
  });

  it("case-insensitive matching of sensitive keys", () => {
    const input = { PASSWORD: "p@ss", Secret: "shh", TOKEN: "t0k" };
    const output = redact(input) as any;
    expect(output.PASSWORD).toBe("***REDACTED***");
    expect(output.Secret).toBe("***REDACTED***");
    expect(output.TOKEN).toBe("***REDACTED***");
  });

  // R10 regression: new keywords
  it("masks authorization, app_key, database_url, bearer, credential", () => {
    const input = {
      authorization: "Bearer tok123",
      app_key: "myappkey",
      database_url: "postgres://user:pass@host/db",
      bearer: "eyJhbGci...",
      credential: "s3cr3t",
    };
    const output = redact(input) as any;
    expect(output.authorization).toBe("***REDACTED***");
    expect(output.app_key).toBe("***REDACTED***");
    expect(output.database_url).toBe("***REDACTED***");
    expect(output.bearer).toBe("***REDACTED***");
    expect(output.credential).toBe("***REDACTED***");
  });

  // R10 regression: Buffer values under sensitive keys must be redacted
  it("masks Buffer values under sensitive keys", () => {
    const buf = Buffer.from("PEM-PRIVATE-KEY-BYTES");
    const input = { private_key: buf, name: "my-key" };
    const output = redact(input) as any;
    expect(output.private_key).toBe("***REDACTED***");
    expect(output.name).toBe("my-key");
  });

  // R10 regression: word-boundary — environment/env_id/envs must NOT be redacted
  it("does NOT redact environment, env_id, envs (word-boundary check)", () => {
    const input = {
      environment: "production",
      environment_name: "prod",
      env_id: 42,
      envs: ["VAR=value"],
    };
    const output = redact(input) as any;
    expect(output.environment).toBe("production");
    expect(output.environment_name).toBe("prod");
    expect(output.env_id).toBe(42);
    expect(Array.isArray(output.envs)).toBe(true);
    expect(output.envs[0]).toBe("VAR=value");
  });
});

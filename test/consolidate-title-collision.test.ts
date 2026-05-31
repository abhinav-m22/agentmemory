import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/functions/audit.js", () => ({
  recordAudit: vi.fn(),
}));

import { registerConsolidateFunction } from "../src/functions/consolidate.js";
import { KV } from "../src/state/schema.js";
import type {
  CompressedObservation,
  Memory,
  MemoryProvider,
  Session,
} from "../src/types.js";

function makeMockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function makeMockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => {
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id =
        typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload =
        typeof idOrInput === "string"
          ? data
          : (idOrInput as { payload: unknown }).payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function registered: ${id}`);
      return fn(payload);
    },
  };
}

function makeSession(id: string, project: string): Session {
  return {
    id,
    project,
    cwd: `/srv/${project}`,
    startedAt: new Date().toISOString(),
    status: "completed",
    observationCount: 5,
  };
}

function makeObs(
  id: string,
  sessionId: string,
  concept: string,
): CompressedObservation {
  return {
    id,
    sessionId,
    timestamp: new Date().toISOString(),
    type: "decision",
    title: `${concept} observation ${id}`,
    facts: [`fact about ${concept}`],
    narrative: `detailed narrative about ${concept} pattern usage`,
    concepts: [concept],
    files: ["src/auth.ts"],
    importance: 8,
  };
}

describe("mem::consolidate — same-title collision within a single run", () => {
  it("evolves the first-created memory when a second concept group produces the same title", async () => {
    const sdk = makeMockSdk();
    const kv = makeMockKV();

    let callCount = 0;
    const provider: MemoryProvider = {
      name: "mock",
      compress: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(
          `<memory>
            <type>pattern</type>
            <title>Auth middleware pattern</title>
            <content>synthesized content iteration ${callCount}</content>
            <concepts><concept>${callCount === 1 ? "auth" : "session"}</concept></concepts>
            <files><file>src/auth.ts</file></files>
            <strength>7</strength>
          </memory>`,
        );
      }),
      embed: vi.fn().mockResolvedValue(new Float32Array(384)),
      embedBatch: vi.fn().mockResolvedValue([]),
      dimensions: 384,
      compressionModel: "mock-model",
    };

    const session = makeSession("sess_1", "myapp");
    await kv.set(KV.sessions, session.id, session);

    for (let i = 0; i < 4; i++) {
      await kv.set(
        KV.observations(session.id),
        `obs_auth_${i}`,
        makeObs(`obs_auth_${i}`, session.id, "auth"),
      );
    }
    for (let i = 0; i < 4; i++) {
      await kv.set(
        KV.observations(session.id),
        `obs_session_${i}`,
        makeObs(`obs_session_${i}`, session.id, "session"),
      );
    }

    registerConsolidateFunction(sdk as never, kv as never, provider as never);
    const result = (await sdk.trigger("mem::consolidate", {
      project: "myapp",
      minObservations: 1,
    })) as { consolidated: number };

    expect(result.consolidated).toBe(2);

    const allMemories = await kv.list<Memory>(KV.memories);
    const latestMemories = allMemories.filter((m) => m.isLatest);

    expect(latestMemories).toHaveLength(1);

    const latest = latestMemories[0];
    expect(latest.title).toBe("Auth middleware pattern");
    expect(latest.version).toBe(2);
    expect(latest.parentId).toBeDefined();

    const demoted = allMemories.find((m) => !m.isLatest);
    expect(demoted).toBeDefined();
    expect(demoted!.title).toBe("Auth middleware pattern");
    expect(demoted!.version).toBe(1);

    expect(latest.supersedes).toContain(demoted!.id);
  });

  it("does not produce orphaned memories when three groups collide on the same title", async () => {
    const sdk = makeMockSdk();
    const kv = makeMockKV();

    let callCount = 0;
    const provider: MemoryProvider = {
      name: "mock",
      compress: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(
          `<memory>
            <type>pattern</type>
            <title>Common Title</title>
            <content>content iteration ${callCount}</content>
            <concepts><concept>concept${callCount}</concept></concepts>
            <files><file>src/file.ts</file></files>
            <strength>7</strength>
          </memory>`,
        );
      }),
      embed: vi.fn().mockResolvedValue(new Float32Array(384)),
      embedBatch: vi.fn().mockResolvedValue([]),
      dimensions: 384,
      compressionModel: "mock-model",
    };

    const session = makeSession("sess_1", "myapp");
    await kv.set(KV.sessions, session.id, session);

    for (const concept of ["alpha", "beta", "gamma"]) {
      for (let i = 0; i < 4; i++) {
        await kv.set(
          KV.observations(session.id),
          `obs_${concept}_${i}`,
          makeObs(`obs_${concept}_${i}`, session.id, concept),
        );
      }
    }

    registerConsolidateFunction(sdk as never, kv as never, provider as never);
    const result = (await sdk.trigger("mem::consolidate", {
      project: "myapp",
      minObservations: 1,
    })) as { consolidated: number };

    expect(result.consolidated).toBe(3);

    const allMemories = await kv.list<Memory>(KV.memories);

    const latestMemories = allMemories.filter((m) => m.isLatest);
    expect(latestMemories).toHaveLength(1);
    expect(latestMemories[0].version).toBe(3);

    const demoted = allMemories.filter((m) => !m.isLatest);
    expect(demoted).toHaveLength(2);

    const chain = latestMemories[0].supersedes ?? [];
    expect(chain).toHaveLength(2);
    for (const d of demoted) {
      expect(chain).toContain(d.id);
    }
  });

  it("creates separate memories when titles are distinct (no false positive collisions)", async () => {
    const sdk = makeMockSdk();
    const kv = makeMockKV();

    let callCount = 0;
    const provider: MemoryProvider = {
      name: "mock",
      compress: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(
          `<memory>
            <type>pattern</type>
            <title>Unique Title ${callCount}</title>
            <content>content ${callCount}</content>
            <concepts><concept>concept${callCount}</concept></concepts>
            <files><file>src/file.ts</file></files>
            <strength>7</strength>
          </memory>`,
        );
      }),
      embed: vi.fn().mockResolvedValue(new Float32Array(384)),
      embedBatch: vi.fn().mockResolvedValue([]),
      dimensions: 384,
      compressionModel: "mock-model",
    };

    const session = makeSession("sess_1", "myapp");
    await kv.set(KV.sessions, session.id, session);

    for (const concept of ["alpha", "beta"]) {
      for (let i = 0; i < 4; i++) {
        await kv.set(
          KV.observations(session.id),
          `obs_${concept}_${i}`,
          makeObs(`obs_${concept}_${i}`, session.id, concept),
        );
      }
    }

    registerConsolidateFunction(sdk as never, kv as never, provider as never);
    await sdk.trigger("mem::consolidate", {
      project: "myapp",
      minObservations: 1,
    });

    const allMemories = await kv.list<Memory>(KV.memories);
    const latestMemories = allMemories.filter((m) => m.isLatest);

    expect(latestMemories).toHaveLength(2);
    const titles = latestMemories.map((m) => m.title).sort();
    expect(titles[0]).not.toBe(titles[1]);
  });

  it("title collision with a pre-existing memory evolves it correctly", async () => {
    const sdk = makeMockSdk();
    const kv = makeMockKV();

    const preExisting: Memory = {
      id: "mem_pre",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      type: "pattern",
      title: "Auth middleware pattern",
      content: "original content",
      concepts: ["auth"],
      files: ["src/auth.ts"],
      sessionIds: ["old_sess"],
      strength: 6,
      version: 1,
      isLatest: true,
      project: "myapp",
    };
    await kv.set(KV.memories, preExisting.id, preExisting);

    let callCount = 0;
    const provider: MemoryProvider = {
      name: "mock",
      compress: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(
          `<memory>
            <type>pattern</type>
            <title>Auth middleware pattern</title>
            <content>updated content iteration ${callCount}</content>
            <concepts><concept>${callCount === 1 ? "auth" : "session"}</concept></concepts>
            <files><file>src/auth.ts</file></files>
            <strength>8</strength>
          </memory>`,
        );
      }),
      embed: vi.fn().mockResolvedValue(new Float32Array(384)),
      embedBatch: vi.fn().mockResolvedValue([]),
      dimensions: 384,
      compressionModel: "mock-model",
    };

    const session = makeSession("sess_1", "myapp");
    await kv.set(KV.sessions, session.id, session);

    for (const concept of ["auth", "session"]) {
      for (let i = 0; i < 4; i++) {
        await kv.set(
          KV.observations(session.id),
          `obs_${concept}_${i}`,
          makeObs(`obs_${concept}_${i}`, session.id, concept),
        );
      }
    }

    registerConsolidateFunction(sdk as never, kv as never, provider as never);
    await sdk.trigger("mem::consolidate", {
      project: "myapp",
      minObservations: 1,
    });

    const allMemories = await kv.list<Memory>(KV.memories);
    const latestMemories = allMemories.filter((m) => m.isLatest);

    expect(latestMemories).toHaveLength(1);
    expect(latestMemories[0].version).toBe(3);

    const chain = latestMemories[0].supersedes ?? [];
    expect(chain).toContain("mem_pre");

    const preExistingAfter = await kv.get<Memory>(KV.memories, "mem_pre");
    expect(preExistingAfter?.isLatest).toBe(false);
  });
});

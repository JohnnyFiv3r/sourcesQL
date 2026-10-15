import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Pool, type PoolConfig } from "pg";
import {
  BackendError,
  MotherDuckEngine,
  type MotherDuckOptions,
} from "../server/motherduck.js";

const options = {
  database: "synthetic",
  host: "pg.us-east-1-aws.motherduck.com",
  token: "synthetic-token-do-not-expose",
  flightId: "0a111111-1111-4111-a111-111111111111",
  principal: "synthetic-owner-a",
};

function harness(overrides: Partial<MotherDuckOptions> = {}) {
  const clients: FakeClient[] = [];
  const configurations: PoolConfig[] = [];
  const pools: Pool[] = [];
  let connectFailure: Error | undefined;
  let queryFailure: ((sql: string) => Error | undefined) | undefined;

  class FakeClient extends EventEmitter {
    readonly id = clients.length + 1;
    readonly queries: string[] = [];
    readonly _queryable = true;
    _ending = false;
    ends = 0;
    constructor() {
      super();
      clients.push(this);
    }
    connect(callback: (error?: Error) => void) {
      const error = connectFailure;
      connectFailure = undefined;
      queueMicrotask(() => callback(error));
    }
    async query(sql: string) {
      this.queries.push(sql);
      const error = queryFailure?.(sql);
      if (error) throw error;
      return { rows: [{ physical_connection: this.id }] };
    }
    end(callback?: () => void) {
      this._ending = true;
      this.ends++;
      callback?.();
      this.emit("end");
    }
    unref() {}
  }

  const poolFactory: NonNullable<MotherDuckOptions["poolFactory"]> = (
    configuration,
  ) => {
    configurations.push(configuration);
    const pool = new Pool({
      ...configuration,
      Client: FakeClient as unknown as PoolConfig["Client"],
    });
    pools.push(pool);
    return pool;
  };
  const engine = new MotherDuckEngine({
    ...options,
    ...overrides,
    poolFactory,
  });
  return {
    engine,
    clients,
    configurations,
    pools,
    poolFactory,
    failConnect: (error: Error) => (connectFailure = error),
    failQuery: (failure: (sql: string) => Error | undefined) =>
      (queryFailure = failure),
    close: async () => {
      await Promise.all(pools.map((pool) => pool.end()));
    },
  };
}

test("MotherDuck pool reuses a physical connection with bounded, strict-TLS configuration", async () => {
  const h = harness();
  try {
    const first = await h.engine.connection((client) =>
      client.query("SELECT 1"),
    );
    const second = await h.engine.transaction(false, (client) =>
      client.query("SELECT 2"),
    );
    assert.equal(
      first.rows[0].physical_connection,
      second.rows[0].physical_connection,
    );
    assert.equal(h.clients.length, 1);
    assert.deepEqual(h.clients[0].queries, [
      "SELECT 1",
      "BEGIN TRANSACTION",
      "SELECT 2",
      "COMMIT",
    ]);
    assert.equal(h.clients[0].ends, 0);
    assert.equal(h.pools[0].idleCount, 1);
    assert.equal(h.configurations[0].max, 3);
    assert.equal(h.configurations[0].idleTimeoutMillis, 5000);
    assert.equal(h.configurations[0].allowExitOnIdle, true);
    assert.equal(h.configurations[0].connectionTimeoutMillis, 15000);
    assert.equal(h.configurations[0].query_timeout, 15000);
    assert.deepEqual(h.configurations[0].ssl, { rejectUnauthorized: true });
    assert.equal(h.configurations[0].password, options.token);
    assert.equal(h.configurations[0].host, options.host);
    assert.equal(h.configurations[0].database, options.database);
  } finally {
    await h.close();
  }
});

test("MotherDuck pool limits concurrent leases and releases them for queued work", async () => {
  const h = harness();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const held = Array.from({ length: 3 }, () =>
    h.engine.connection(async (client) => {
      await gate;
      return client.query("SELECT held");
    }),
  );
  let fourth: Promise<unknown> | undefined;
  try {
    await nextTurn();
    fourth = h.engine.connection((client) => client.query("SELECT queued"));
    await nextTurn();
    assert.equal(h.pools[0].totalCount, 3);
    assert.equal(h.pools[0].idleCount, 0);
    assert.equal(h.pools[0].waitingCount, 1);
    release();
    await Promise.all([...held, fourth]);
    assert.equal(h.clients.length, 3);
    assert.equal(h.pools[0].waitingCount, 0);
    assert.equal(h.pools[0].idleCount, 3);
  } finally {
    release();
    await Promise.allSettled([...held, ...(fourth ? [fourth] : [])]);
    await h.close();
  }
});

test("MotherDuck query errors discard the connection and expose only a safe error", async () => {
  const h = harness();
  try {
    h.failQuery((sql) =>
      sql === "SELECT fail"
        ? Object.assign(new Error(options.token), { code: "40001" })
        : undefined,
    );
    await assert.rejects(
      h.engine.transaction(false, (client) => client.query("SELECT fail")),
      (error: unknown) => {
        assert.ok(error instanceof BackendError);
        assert.equal(error.code, "storage_conflict");
        assert.equal(
          error.message,
          "MotherDuck storage operation failed safely",
        );
        assert.ok(!String(error).includes(options.token));
        return true;
      },
    );
    assert.deepEqual(h.clients[0].queries, [
      "BEGIN TRANSACTION",
      "SELECT fail",
      "ROLLBACK",
    ]);
    assert.equal(h.clients[0].ends, 1);
    assert.equal(h.pools[0].totalCount, 0);
    const next = await h.engine.connection((client) =>
      client.query("SELECT safe"),
    );
    assert.equal(next.rows[0].physical_connection, 2);
  } finally {
    await h.close();
  }
});

test("MotherDuck discards a failed query even when work catches the error", async () => {
  const h = harness();
  try {
    h.failQuery((sql) =>
      sql === "FAIL" ? new Error("synthetic failure") : undefined,
    );
    const result = await h.engine.connection(async (client) => {
      await client.query("FAIL").catch(() => undefined);
      return "handled";
    });
    assert.equal(result, "handled");
    assert.equal(h.clients[0].ends, 1);
    assert.equal(h.pools[0].totalCount, 0);
    const next = await h.engine.connection((client) =>
      client.query("SELECT safe"),
    );
    assert.equal(next.rows[0].physical_connection, 2);
  } finally {
    await h.close();
  }
});

test("MotherDuck rollback errors cannot return an uncertain transaction to the pool", async () => {
  const h = harness();
  const expected = new BackendError("invalid_request", "synthetic validation");
  try {
    h.failQuery((sql) =>
      sql === "ROLLBACK" ? new Error(options.token) : undefined,
    );
    await assert.rejects(
      h.engine.transaction(false, async () => {
        throw expected;
      }),
      (error: unknown) => error === expected,
    );
    assert.deepEqual(h.clients[0].queries, ["BEGIN TRANSACTION", "ROLLBACK"]);
    assert.equal(h.clients[0].ends, 1);
    assert.equal(h.pools[0].totalCount, 0);
    const next = await h.engine.connection((client) =>
      client.query("SELECT safe"),
    );
    assert.equal(next.rows[0].physical_connection, 2);
  } finally {
    await h.close();
  }
});

test("MotherDuck handles idle socket failures and safely acquires a replacement", async () => {
  const h = harness();
  try {
    await h.engine.connection((client) => client.query("SELECT first"));
    assert.doesNotThrow(() =>
      h.clients[0].emit("error", new Error(options.token)),
    );
    assert.equal(h.clients[0].ends, 1);
    assert.equal(h.pools[0].totalCount, 0);
    const next = await h.engine.connection((client) =>
      client.query("SELECT safe"),
    );
    assert.equal(next.rows[0].physical_connection, 2);
  } finally {
    await h.close();
  }
});

test("MotherDuck handles a socket error during a lease without reusing the connection", async () => {
  const h = harness();
  try {
    await h.engine.connection(async (client) => {
      await client.query("SELECT first");
      assert.doesNotThrow(() =>
        h.clients[0].emit("error", new Error(options.token)),
      );
    });
    assert.equal(h.clients[0].ends, 1);
    // The lease handler is removed; only pg's own disposal listener remains.
    assert.equal(h.clients[0].listenerCount("error"), 1);
    assert.equal(h.pools[0].totalCount, 0);
    const next = await h.engine.connection((client) =>
      client.query("SELECT safe"),
    );
    assert.equal(next.rows[0].physical_connection, 2);
  } finally {
    await h.close();
  }
});

test("MotherDuck pool acquisition errors remain bounded and do not leak credentials", async () => {
  const h = harness();
  try {
    h.failConnect(new Error(options.token));
    await assert.rejects(
      h.engine.connection((client) => client.query("SELECT unavailable")),
      (error: unknown) => {
        assert.ok(error instanceof BackendError);
        assert.equal(error.code, "storage_unavailable");
        assert.ok(!String(error).includes(options.token));
        return true;
      },
    );
    assert.equal(h.clients[0].queries.length, 0);
    assert.equal(h.pools[0].totalCount, 0);
    const next = await h.engine.connection((client) =>
      client.query("SELECT safe"),
    );
    assert.equal(next.rows[0].physical_connection, 2);
  } finally {
    await h.close();
  }
});

test("MotherDuck pools are engine-local across principals and credential changes", async () => {
  const h = harness();
  const other = new MotherDuckEngine({
    ...options,
    principal: "synthetic-owner-b",
    token: "other-synthetic-token",
    poolFactory: h.poolFactory,
  });
  const samePrincipal = new MotherDuckEngine({
    ...options,
    token: "rotated-synthetic-token",
    poolFactory: h.poolFactory,
  });
  try {
    const first = await h.engine.connection((client) =>
      client.query("SELECT first"),
    );
    const second = await other.connection((client) =>
      client.query("SELECT other"),
    );
    const third = await samePrincipal.connection((client) =>
      client.query("SELECT rotated"),
    );
    assert.equal(h.pools.length, 3);
    assert.equal(
      new Set(
        [first, second, third].map(
          (result) => result.rows[0].physical_connection,
        ),
      ).size,
      3,
    );
    assert.notEqual(h.engine.namespace, other.namespace);
    assert.equal(h.engine.namespace, samePrincipal.namespace);
    assert.equal(h.configurations[1].password, "other-synthetic-token");
    assert.equal(h.configurations[2].password, "rotated-synthetic-token");
  } finally {
    await h.close();
  }
});

test("MotherDuck clientFactory retains fresh connect/end semantics without creating a pool", async () => {
  let creates = 0;
  let connects = 0;
  let ends = 0;
  const engine = new MotherDuckEngine({
    ...options,
    clientFactory: () => {
      creates++;
      return {
        connect: async () => {
          connects++;
        },
        end: async () => {
          ends++;
        },
        query: async () => ({ rows: [] }),
      };
    },
    poolFactory: () => {
      throw new Error("clientFactory must not create a pool");
    },
  });
  await engine.connection((client) => client.query("SELECT first"));
  await assert.rejects(
    engine.connection(async () => {
      throw new Error("synthetic failure");
    }),
    { code: "storage_unavailable" },
  );
  assert.equal(creates, 2);
  assert.equal(connects, 2);
  assert.equal(ends, 2);
});

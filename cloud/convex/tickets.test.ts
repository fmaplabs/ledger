import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

// import.meta.glob is provided by Vite at runtime; the convex/ tsconfig
// has no vite/client types, so declare just what's used.
declare global {
  interface ImportMeta {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const HOUR_MS = 3_600_000;

function ticketArgs(
  ids: { clientId: Id<"clients">; projectId: Id<"projects"> },
  overrides: Record<string, unknown> = {},
) {
  return {
    externalId: "EXT-1",
    name: "Fix login bug",
    totalTimeMs: 2 * HOUR_MS,
    ...ids,
    ...overrides,
  };
}

// One client + one project owned by `subject`, seeded directly: projects have
// no public create mutation (auto-registered on sync), and clients.create
// schedules a Stripe push we don't want running in these tests.
async function fixturesFor(t: ReturnType<typeof convexTest>, subject: string) {
  return await t.run(async (ctx) => {
    const clientId = await ctx.db.insert("clients", {
      userId: subject,
      name: `client-of-${subject}`,
      email: `${subject}@example.com`,
    });
    const projectId = await ctx.db.insert("projects", {
      userId: subject,
      name: `proj-of-${subject}`,
    });
    return { clientId, projectId };
  });
}

describe("tickets.create", () => {
  test("stores the declared time in ms, owned by the caller", async () => {
    const t = convexTest(schema, modules);
    const ids = await fixturesFor(t, "user-1");
    const asUser = t.withIdentity({ subject: "user-1" });

    const id = await asUser.mutation(api.tickets.create, ticketArgs(ids));

    const ticket = await t.run(async (ctx) => ctx.db.get(id));
    expect(ticket).toMatchObject({
      userId: "user-1",
      externalId: "EXT-1",
      name: "Fix login bug",
      clientId: ids.clientId,
      projectId: ids.projectId,
      totalTimeMs: 2 * HOUR_MS,
    });
  });

  test("rejects unauthenticated callers", async () => {
    const t = convexTest(schema, modules);
    const ids = await fixturesFor(t, "user-1");
    await expect(
      t.mutation(api.tickets.create, ticketArgs(ids)),
    ).rejects.toThrow("Not authenticated");
  });

  test("rejects a clientId or projectId owned by another user", async () => {
    const t = convexTest(schema, modules);
    const own = await fixturesFor(t, "user-1");
    const theirs = await fixturesFor(t, "user-2");
    const asUser = t.withIdentity({ subject: "user-1" });
    await expect(
      asUser.mutation(
        api.tickets.create,
        ticketArgs({ clientId: theirs.clientId, projectId: own.projectId }),
      ),
    ).rejects.toThrow("Client not found");
    await expect(
      asUser.mutation(
        api.tickets.create,
        ticketArgs({ clientId: own.clientId, projectId: theirs.projectId }),
      ),
    ).rejects.toThrow("Project not found");
  });

  test("rejects fractional and negative durations", async () => {
    const t = convexTest(schema, modules);
    const ids = await fixturesFor(t, "user-1");
    const asUser = t.withIdentity({ subject: "user-1" });
    for (const totalTimeMs of [1.5, -1]) {
      await expect(
        asUser.mutation(api.tickets.create, ticketArgs(ids, { totalTimeMs })),
      ).rejects.toThrow("totalTimeMs must be a non-negative integer");
    }
  });

  test("rejects a duplicate externalId for the same user but not across users", async () => {
    const t = convexTest(schema, modules);
    const idsA = await fixturesFor(t, "user-1");
    const idsB = await fixturesFor(t, "user-2");
    const asUserA = t.withIdentity({ subject: "user-1" });
    const asUserB = t.withIdentity({ subject: "user-2" });

    await asUserA.mutation(api.tickets.create, ticketArgs(idsA));
    await expect(
      asUserA.mutation(api.tickets.create, ticketArgs(idsA)),
    ).rejects.toThrow("already exists");

    // The same external tracker id is fine for a different user.
    const id = await asUserB.mutation(api.tickets.create, ticketArgs(idsB));
    expect(id).toBeDefined();
  });
});

describe("tickets.list", () => {
  test("joins client/project names and sorts newest-first", async () => {
    const t = convexTest(schema, modules);
    const ids = await fixturesFor(t, "user-1");
    const asUser = t.withIdentity({ subject: "user-1" });
    // projectName prefers displayName over the raw sync name.
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.projectId, { displayName: "Nice Project" });
    });

    // Creation order deliberately differs from externalId order so the
    // assertion catches a sort by index order (externalId) too.
    for (const externalId of ["EXT-2", "EXT-3", "EXT-1"]) {
      await asUser.mutation(
        api.tickets.create,
        ticketArgs(ids, { externalId }),
      );
    }

    const rows = await asUser.query(api.tickets.list, {});
    expect(rows.map((r) => r.externalId)).toEqual(["EXT-1", "EXT-3", "EXT-2"]);
    expect(rows[0]).toMatchObject({
      name: "Fix login bug",
      clientId: ids.clientId,
      clientName: "client-of-user-1",
      projectId: ids.projectId,
      projectName: "Nice Project",
      totalTimeMs: 2 * HOUR_MS,
    });
    // createdAt mirrors the system _creationTime.
    const doc = await t.run(async (ctx) => ctx.db.get(rows[0]._id));
    expect(rows[0].createdAt).toBe(doc?._creationTime);
  });

  test("never includes another user's tickets", async () => {
    const t = convexTest(schema, modules);
    const own = await fixturesFor(t, "user-1");
    const theirs = await fixturesFor(t, "user-2");
    const asUserA = t.withIdentity({ subject: "user-1" });
    const asUserB = t.withIdentity({ subject: "user-2" });

    await asUserA.mutation(api.tickets.create, ticketArgs(own));
    await asUserB.mutation(
      api.tickets.create,
      ticketArgs(theirs, { externalId: "EXT-THEIRS" }),
    );

    const rows = await asUserA.query(api.tickets.list, {});
    expect(rows.map((r) => r.externalId)).toEqual(["EXT-1"]);
  });

  test("renders placeholders for dangling joins instead of throwing", async () => {
    const t = convexTest(schema, modules);
    const ids = await fixturesFor(t, "user-1");
    const asUser = t.withIdentity({ subject: "user-1" });
    await asUser.mutation(api.tickets.create, ticketArgs(ids));

    await t.run(async (ctx) => {
      await ctx.db.delete(ids.clientId);
      await ctx.db.delete(ids.projectId);
    });

    const rows = await asUser.query(api.tickets.list, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].clientName).toBe("(unknown client)");
    expect(rows[0].projectName).toBe("(unknown project)");
  });

  test("rejects unauthenticated callers", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.tickets.list, {})).rejects.toThrow(
      "Not authenticated",
    );
  });

  test("keeps the NEWEST 500 when the cap overflows", async () => {
    const t = convexTest(schema, modules);
    const ids = await fixturesFor(t, "user-1");
    const asUser = t.withIdentity({ subject: "user-1" });

    // 501 tickets, oldest first: a capped ascending scan would keep
    // EXT-0…EXT-499 and silently drop the just-created EXT-500.
    await t.run(async (ctx) => {
      for (let i = 0; i <= 500; i++) {
        await ctx.db.insert("tickets", {
          userId: "user-1",
          externalId: `EXT-${i}`,
          name: `ticket ${i}`,
          clientId: ids.clientId,
          projectId: ids.projectId,
          totalTimeMs: HOUR_MS,
        });
      }
    });

    const rows = await asUser.query(api.tickets.list, {});
    expect(rows).toHaveLength(500);
    expect(rows[0].externalId).toBe("EXT-500");
    expect(rows.at(-1)?.externalId).toBe("EXT-1");
  });
});

describe("tickets.listByClient", () => {
  test("returns only that client's tickets, newest-first", async () => {
    const t = convexTest(schema, modules);
    const ids = await fixturesFor(t, "user-1");
    const asUser = t.withIdentity({ subject: "user-1" });
    const otherClientId = await t.run(async (ctx) =>
      ctx.db.insert("clients", {
        userId: "user-1",
        name: "other-client",
        email: "other@example.com",
      }),
    );

    await asUser.mutation(api.tickets.create, ticketArgs(ids));
    await asUser.mutation(
      api.tickets.create,
      ticketArgs(ids, { externalId: "EXT-OTHER", clientId: otherClientId }),
    );
    await asUser.mutation(
      api.tickets.create,
      ticketArgs(ids, { externalId: "EXT-2" }),
    );

    const rows = await asUser.query(api.tickets.listByClient, {
      clientId: ids.clientId,
    });
    expect(rows.map((r) => r.externalId)).toEqual(["EXT-2", "EXT-1"]);
    expect(rows.every((r) => r.clientName === "client-of-user-1")).toBe(true);
  });

  test("rejects a clientId owned by another user", async () => {
    const t = convexTest(schema, modules);
    await fixturesFor(t, "user-1");
    const theirs = await fixturesFor(t, "user-2");
    const asUser = t.withIdentity({ subject: "user-1" });
    await expect(
      asUser.query(api.tickets.listByClient, { clientId: theirs.clientId }),
    ).rejects.toThrow("Client not found");
  });

  test("rejects unauthenticated callers", async () => {
    const t = convexTest(schema, modules);
    const ids = await fixturesFor(t, "user-1");
    await expect(
      t.query(api.tickets.listByClient, { clientId: ids.clientId }),
    ).rejects.toThrow("Not authenticated");
  });
});

describe("tickets.listByProject", () => {
  test("returns only that project's tickets, newest-first", async () => {
    const t = convexTest(schema, modules);
    const ids = await fixturesFor(t, "user-1");
    const asUser = t.withIdentity({ subject: "user-1" });
    const otherProjectId = await t.run(async (ctx) =>
      ctx.db.insert("projects", {
        userId: "user-1",
        name: "other-proj",
      }),
    );

    await asUser.mutation(api.tickets.create, ticketArgs(ids));
    await asUser.mutation(
      api.tickets.create,
      ticketArgs(ids, { externalId: "EXT-OTHER", projectId: otherProjectId }),
    );
    await asUser.mutation(
      api.tickets.create,
      ticketArgs(ids, { externalId: "EXT-2" }),
    );

    const rows = await asUser.query(api.tickets.listByProject, {
      projectId: ids.projectId,
    });
    expect(rows.map((r) => r.externalId)).toEqual(["EXT-2", "EXT-1"]);
    expect(rows.every((r) => r.projectName === "proj-of-user-1")).toBe(true);
  });

  test("rejects a projectId owned by another user", async () => {
    const t = convexTest(schema, modules);
    await fixturesFor(t, "user-1");
    const theirs = await fixturesFor(t, "user-2");
    const asUser = t.withIdentity({ subject: "user-1" });
    await expect(
      asUser.query(api.tickets.listByProject, { projectId: theirs.projectId }),
    ).rejects.toThrow("Project not found");
  });

  test("rejects unauthenticated callers", async () => {
    const t = convexTest(schema, modules);
    const ids = await fixturesFor(t, "user-1");
    await expect(
      t.query(api.tickets.listByProject, { projectId: ids.projectId }),
    ).rejects.toThrow("Not authenticated");
  });
});

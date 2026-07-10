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

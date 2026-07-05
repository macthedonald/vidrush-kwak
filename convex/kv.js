import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

async function requireUser(ctx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");
  return identity.subject;
}

// All key/value rows for the signed-in user.
export const list = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const rows = await ctx.db
      .query("kv")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .collect();
    return rows.map((r) => ({ key: r.key, value: r.value }));
  },
});

// Upsert one key.
export const set = mutation({
  args: { key: v.string(), value: v.any() },
  handler: async (ctx, { key, value }) => {
    const userId = await requireUser(ctx);
    const existing = await ctx.db
      .query("kv")
      .withIndex("by_user_key", (q) => q.eq("userId", userId).eq("key", key))
      .unique();
    if (existing) await ctx.db.patch(existing._id, { value, updatedAt: Date.now() });
    else await ctx.db.insert("kv", { userId, key, value, updatedAt: Date.now() });
  },
});

// Batch upsert — used for the one-time migration of legacy localStorage into the account.
export const setMany = mutation({
  args: { entries: v.array(v.object({ key: v.string(), value: v.any() })) },
  handler: async (ctx, { entries }) => {
    const userId = await requireUser(ctx);
    for (const { key, value } of entries) {
      const existing = await ctx.db
        .query("kv")
        .withIndex("by_user_key", (q) => q.eq("userId", userId).eq("key", key))
        .unique();
      if (existing) await ctx.db.patch(existing._id, { value, updatedAt: Date.now() });
      else await ctx.db.insert("kv", { userId, key, value, updatedAt: Date.now() });
    }
  },
});

export const remove = mutation({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const userId = await requireUser(ctx);
    const existing = await ctx.db
      .query("kv")
      .withIndex("by_user_key", (q) => q.eq("userId", userId).eq("key", key))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});

import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

async function requireUser(ctx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");
  return identity.subject;
}

// Short-lived URL the browser POSTs a media blob to → returns { storageId }.
export const uploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

// Record (or replace) the stored file for a media key. Old file is cleaned up.
export const set = mutation({
  args: { key: v.string(), storageId: v.id("_storage") },
  handler: async (ctx, { key, storageId }) => {
    const userId = await requireUser(ctx);
    const existing = await ctx.db
      .query("media")
      .withIndex("by_user_key", (q) => q.eq("userId", userId).eq("key", key))
      .unique();
    if (existing) {
      if (existing.storageId !== storageId) { try { await ctx.storage.delete(existing.storageId); } catch {} }
      await ctx.db.patch(existing._id, { storageId, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("media", { userId, key, storageId, updatedAt: Date.now() });
    }
  },
});

// All of the user's media as { key, url } — served URLs the client fetches to re-hydrate.
export const list = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const rows = await ctx.db
      .query("media")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .collect();
    const out = [];
    for (const r of rows) {
      const url = await ctx.storage.getUrl(r.storageId);
      if (url) out.push({ key: r.key, url });
    }
    return out;
  },
});

export const remove = mutation({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const userId = await requireUser(ctx);
    const existing = await ctx.db
      .query("media")
      .withIndex("by_user_key", (q) => q.eq("userId", userId).eq("key", key))
      .unique();
    if (existing) {
      try { await ctx.storage.delete(existing.storageId); } catch {}
      await ctx.db.delete(existing._id);
    }
  },
});

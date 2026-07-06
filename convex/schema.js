import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Per-user key/value store. Every localStorage key the app used (niches, settings/API keys,
// templates, learning memory, per-topic studio state) becomes a row scoped to the Clerk user.
// Large binaries (rendered videos, frames) stay in the browser's IndexedDB by design.
export default defineSchema({
  kv: defineTable({
    userId: v.string(),   // Clerk subject (identity.subject)
    key: v.string(),
    value: v.any(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_key", ["userId", "key"]),

  // Generated binaries (frames, sourced clips, renders) stored in Convex file storage so a
  // video's assets follow the user across devices. Each row maps a per-topic media key to a
  // stored file; the bytes live in Convex storage, only the storageId is in the table.
  media: defineTable({
    userId: v.string(),
    key: v.string(),
    storageId: v.id("_storage"),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_key", ["userId", "key"]),
});

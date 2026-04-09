/**
 * Server load and form actions for the API key settings page.
 *
 * - load: Lists the user's API keys (masked).
 * - add: Validates and encrypts a new API key.
 * - delete: Removes an API key by ID.
 */

import { fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { getSql } from "$lib/server/norush";
import {
  listApiKeys,
  createApiKey,
  deleteApiKey,
  validateApiKeyInput,
} from "$lib/server/api-keys";

/** Extract authenticated user ID, redirecting to login if absent. */
function requireUser(locals: App.Locals): string {
  if (!locals.user) redirect(302, "/login");
  return locals.user.id;
}

export const load: PageServerLoad = async ({ locals }) => {
  const userId = requireUser(locals);
  const sql = getSql();

  let keys: Awaited<ReturnType<typeof listApiKeys>> = [];
  let loadError: string | null = null;

  try {
    keys = await listApiKeys(sql, userId);
  } catch (err) {
    // Don't expose internal errors to the client
    console.error("[settings] Failed to load API keys:", err);
    loadError = "Failed to load API keys. Please check server configuration.";
  }

  return { keys, loadError };
};

export const actions = {
  add: async ({ request, locals }) => {
    const userId = requireUser(locals);
    const sql = getSql();
    const data = await request.formData();

    const provider = (data.get("provider") as string | null) ?? "";
    const label = (data.get("label") as string | null) ?? "";
    const apiKey = (data.get("apiKey") as string | null) ?? "";
    const priorityRaw = data.get("priority") as string | null;
    const priority = priorityRaw ? parseInt(priorityRaw, 10) : 0;

    // Server-side validation
    const errors = validateApiKeyInput({ provider, label, apiKey });

    // Priority range validation (clients can bypass HTML min/max)
    if (isNaN(priority) || priority < 0 || priority > 99 || !Number.isInteger(priority)) {
      errors.push({ field: "priority", message: "Priority must be an integer between 0 and 99" });
    }

    if (errors.length > 0) {
      return fail(400, {
        action: "add" as const,
        errors,
        values: { provider, label, priority },
      });
    }

    try {
      await createApiKey(sql, {
        userId,
        provider,
        label: label.trim(),
        apiKey: apiKey.trim(),
        priority: isNaN(priority) ? 0 : priority,
      });
    } catch (err) {
      console.error("[settings] Failed to create API key:", err);
      return fail(500, {
        action: "add" as const,
        errors: [{ field: "general", message: "Failed to store API key. Please try again." }],
        values: { provider, label, priority },
      });
    }

    return { success: true };
  },

  delete: async ({ request, locals }) => {
    const userId = requireUser(locals);
    const sql = getSql();
    const data = await request.formData();

    const keyId = (data.get("keyId") as string | null) ?? "";
    if (!keyId) {
      return fail(400, {
        action: "delete" as const,
        errors: [{ field: "keyId", message: "Key ID is required" }],
      });
    }

    try {
      const deleted = await deleteApiKey(sql, userId, keyId);
      if (!deleted) {
        return fail(404, {
          action: "delete" as const,
          errors: [{ field: "keyId", message: "API key not found" }],
        });
      }
    } catch (err) {
      console.error("[settings] Failed to delete API key:", err);
      return fail(500, {
        action: "delete" as const,
        errors: [{ field: "general", message: "Failed to delete API key. Please try again." }],
      });
    }

    return { success: true };
  },
} satisfies Actions;

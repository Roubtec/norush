/**
 * POST /api/messages — Submit a new message for batch processing.
 * GET  /api/messages — List the authenticated user's messages with results.
 *
 * Both endpoints require authentication via session cookie.
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSql } from '$lib/server/norush';
import { getEngine } from '$lib/server/norush';
import { validateMessageInput, listMessages, findUserApiKeyId } from '$lib/server/messages';

// ---------------------------------------------------------------------------
// POST — submit a message
// ---------------------------------------------------------------------------

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) {
    error(401, 'Authentication required');
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    error(400, 'Invalid JSON body');
  }

  const provider = String(body.provider ?? '');
  const model = String(body.model ?? '');
  const content = String(body.content ?? '');

  // Validate input
  const validationErrors = validateMessageInput({ provider, model, content });
  if (validationErrors.length > 0) {
    return json({ errors: validationErrors }, { status: 400 });
  }

  const sql = getSql();

  // Look up user's API key for the selected provider
  const apiKeyId = await findUserApiKeyId(sql, locals.user.id, provider);
  if (!apiKeyId) {
    return json(
      {
        errors: [
          {
            field: 'provider',
            message: `No API key configured for ${provider}. Add one in Settings.`,
          },
        ],
      },
      { status: 400 },
    );
  }

  // Enqueue the request via the norush engine
  const engine = await getEngine();
  const norushRequest = await engine.enqueue({
    provider: provider as 'claude' | 'openai',
    model,
    params: {
      messages: [{ role: 'user', content: content.trim() }],
    },
    userId: locals.user.id,
  });

  return json(
    {
      id: norushRequest.id,
      provider: norushRequest.provider,
      model: norushRequest.model,
      status: norushRequest.status,
      createdAt: norushRequest.createdAt.toISOString(),
    },
    { status: 201 },
  );
};

// ---------------------------------------------------------------------------
// GET — list messages
// ---------------------------------------------------------------------------

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user) {
    error(401, 'Authentication required');
  }

  const limitParam = url.searchParams.get('limit');
  const offsetParam = url.searchParams.get('offset');
  const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 50, 100) : 50;
  const offset = offsetParam ? Math.max(parseInt(offsetParam, 10) || 0, 0) : 0;

  const sql = getSql();
  const messages = await listMessages(sql, locals.user.id, { limit, offset });

  return json({ messages });
};

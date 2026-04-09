// See https://svelte.dev/docs/kit/types#app.d.ts

declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      /** Populated by hooks.server.ts when the session cookie is valid. */
      user?: {
        /** WorkOS user ID, also the PK in the `users` table. */
        id: string;
        email: string;
        firstName: string | null;
        lastName: string | null;
        /** WorkOS session ID (for logout URL generation). */
        sessionId: string;
      };
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};

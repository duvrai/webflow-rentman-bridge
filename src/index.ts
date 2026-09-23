import { handleRequest } from "./handler.ts";
import type { Env } from "./types.ts";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      console.error(JSON.stringify({ event: "unhandled_error", message }));
      return new Response(
        JSON.stringify({
          ok: false,
          error: "internal_error",
          message: "Unexpected worker error.",
        }),
        {
          status: 500,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    }
  },
};

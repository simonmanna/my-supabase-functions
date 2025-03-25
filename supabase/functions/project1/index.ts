import { serve } from "https://deno.land/std/http/server.ts";

serve((req) => {
  return new Response("Updated project1 via GitHub Actions! Hello 2", { status: 200 });
});
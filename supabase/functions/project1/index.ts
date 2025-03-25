import { serve } from "https://deno.land/std/http/server.ts";

serve((req) => {
  return new Response("Updated project1 via GitHub Actions!", { status: 200 });
});
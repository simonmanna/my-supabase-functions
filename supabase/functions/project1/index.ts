import { serve } from "https://deno.land/std/http/server.ts";

serve((req) => {
  return new Response("Hello from project1!", { status: 200 });
});
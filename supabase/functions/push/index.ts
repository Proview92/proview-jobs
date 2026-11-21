// Proview Jobs: notifications on phones (iPhone home-screen app, Android, desktop browsers).
// Deploy with:  supabase functions deploy push --no-verify-jwt
// (The database calls this with its own secret, and phones fetch the public key before anyone is checked,
//  so the function does its own checks instead of requiring a login on every call.)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handle } from "./handler.ts";

Deno.serve((req: Request) =>
  handle(req, {
    SUPABASE_URL: Deno.env.get("SUPABASE_URL")!,
    SERVICE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    SITE_URL: Deno.env.get("SITE_URL") || undefined,
  })
);

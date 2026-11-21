// Proview Jobs: WhatsApp -> job.
// Deploy with:  supabase functions deploy whatsapp-webhook --no-verify-jwt
// (WhatsApp cannot send a Supabase login, so the function checks WhatsApp's own signature instead.)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handle } from "./handler.ts";

Deno.serve((req: Request) =>
  handle(req, {
    SUPABASE_URL: Deno.env.get("SUPABASE_URL")!,
    SERVICE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    WA_VERIFY_TOKEN: Deno.env.get("WA_VERIFY_TOKEN") || undefined,
    WA_APP_SECRET: Deno.env.get("WA_APP_SECRET") || undefined,
    WA_ACCESS_TOKEN: Deno.env.get("WA_ACCESS_TOKEN") || undefined,
    WA_GRAPH_VERSION: Deno.env.get("WA_GRAPH_VERSION") || undefined,
    WA_PHONE_NUMBER_ID: Deno.env.get("WA_PHONE_NUMBER_ID") || undefined,
    WA_TEMPLATE: Deno.env.get("WA_TEMPLATE") || undefined,
    WA_TEMPLATE_LANG: Deno.env.get("WA_TEMPLATE_LANG") || undefined,
    // the reply to a forwarded batch waits a few seconds for more items, after WhatsApp has its answer
    defer: (p) => (globalThis as any).EdgeRuntime?.waitUntil ? (globalThis as any).EdgeRuntime.waitUntil(p) : void p,
  })
);

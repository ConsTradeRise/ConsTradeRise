import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export function getServiceClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } }
  );
}

export function getUserClient(authHeader: string) {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } }
    }
  );
}

export function corsHeaders(origin?: string) {
  const allowed = ['https://constradehire.com', 'https://www.constradehire.com'];
  const o = origin || '';
  const isAllowed = allowed.includes(o) || o.endsWith('.vercel.app') || o.startsWith('http://localhost');
  return {
    'Access-Control-Allow-Origin':  isAllowed ? o : 'https://constradehire.com',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  };
}

export function json(data: unknown, status = 200, origin?: string) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' }
  });
}

export function err(msg: string, status = 400, origin?: string) {
  return json({ error: msg }, status, origin);
}

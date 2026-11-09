import { createClient } from '@supabase/supabase-js';

/** Supabase Auth proves who someone is. What they may do stays in the CRM (roles and permissions). */
let client: ReturnType<typeof createClient> | null = null;
const auth = () => {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY must be set');
    client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
  }
  return client.auth;
};

const passwordPage = () => `${(process.env.WEB_ORIGIN || 'http://localhost:5173').split(',')[0].trim().replace(/\/$/, '')}/set-password`;

/** Returns the Auth user id from an access token, or throws if it isn't valid. */
export async function verifyAuthToken(token: string): Promise<string> {
  const { data, error } = await auth().getClaims(token);
  if (error) throw error;
  if (!data?.claims.sub || data.claims.aud !== 'authenticated') throw new Error('Invalid token');
  return data.claims.sub;
}

/** The user's email, only if Supabase has confirmed that they own it. */
export async function verifiedEmail(authUserId: string): Promise<string | null> {
  const { data, error } = await auth().admin.getUserById(authUserId);
  if (error) throw error;
  return data.user.email && data.user.email_confirmed_at ? data.user.email.toLowerCase() : null;
}

/** The Auth account for an email, if one exists. */
export async function authIdByEmail(email: string): Promise<string | null> {
  for (let page = 1; ; page++) {
    const { data, error } = await auth().admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const match = data.users.find((u) => u.email?.toLowerCase() === email);
    if (match) return match.id;
    if (data.users.length < 200) return null;
  }
}

/** Sets a password chosen by an admin, which also confirms the email. Returns Supabase's reason if it refuses. */
export async function setPassword(authUserId: string, password: string): Promise<string | null> {
  const { error } = await auth().admin.updateUserById(authUserId, { password, email_confirm: true });
  return error?.message ?? null;
}

/** Creates a sign-in with a password chosen by an admin. Returns Supabase's reason if it refuses. */
export async function createSignIn(email: string, password: string): Promise<string | null> {
  const { error } = await auth().admin.createUser({ email, password, email_confirm: true });
  return error?.message ?? null;
}

/** Removes the Auth account, if there is one. */
export async function removeSignIn(authUserId: string | null, email: string) {
  const id = authUserId ?? (await authIdByEmail(email));
  if (!id) return;
  const { error } = await auth().admin.deleteUser(id);
  if (error) throw error;
}

/** Emails a link for choosing a password: an invitation, or a reset if they already have an account. */
export async function sendInvitation(email: string) {
  const { error } = await auth().admin.inviteUserByEmail(email, { redirectTo: passwordPage() });
  if (!error) return;
  if (error.code !== 'email_exists') throw error;
  const reset = await auth().resetPasswordForEmail(email, { redirectTo: passwordPage() });
  if (reset.error) throw reset.error;
}

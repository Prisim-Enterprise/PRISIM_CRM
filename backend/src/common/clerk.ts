import { createClerkClient, verifyToken } from '@clerk/backend';

/** Clerk proves who someone is. What they may do stays in the CRM (roles and permissions). */
const secretKey = () => {
  const key = process.env.CLERK_SECRET_KEY;
  if (!key) throw new Error('CLERK_SECRET_KEY must be set');
  return key;
};

const origins = () => (process.env.WEB_ORIGIN || 'http://localhost:5173').split(',').map((o) => o.trim()).filter(Boolean);

let client: ReturnType<typeof createClerkClient> | null = null;
export const clerk = () => (client ??= createClerkClient({ secretKey: secretKey() }));

/** Returns the Clerk user id from a session token, or throws if it isn't valid for this app. */
export async function verifyClerkToken(token: string): Promise<string> {
  const payload = await verifyToken(token, { secretKey: secretKey(), authorizedParties: origins() });
  return payload.sub;
}

/** The user's primary email, only if Clerk has verified that they own it. */
export async function verifiedPrimaryEmail(clerkUserId: string): Promise<string | null> {
  const u = await clerk().users.getUser(clerkUserId);
  const primary = u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId);
  return primary?.verification?.status === 'verified' ? primary.emailAddress.toLowerCase() : null;
}

/** The Clerk account for an email, if one exists. */
export async function clerkIdByEmail(email: string): Promise<string | null> {
  const { data } = await clerk().users.getUserList({ emailAddress: [email], limit: 1 });
  return data[0]?.id ?? null;
}

/** Sets a new password and signs the person out everywhere. Returns Clerk's reason if it refuses. */
export async function setClerkPassword(clerkUserId: string, password: string): Promise<string | null> {
  try {
    await clerk().users.updateUser(clerkUserId, { password, signOutOfOtherSessions: true });
    return null;
  } catch (e) {
    const first = (e as { errors?: { longMessage?: string; message?: string }[] }).errors?.[0];
    return first?.longMessage ?? first?.message ?? 'Clerk could not change the password';
  }
}

/** Removes the Clerk account and any invitation still waiting for this email. */
export async function removeFromClerk(clerkUserId: string | null, email: string) {
  const id = clerkUserId ?? (await clerkIdByEmail(email));
  if (id) await clerk().users.deleteUser(id);
  const { data } = await clerk().invitations.getInvitationList({ status: 'pending', query: email, limit: 20 });
  for (const inv of data.filter((i) => i.emailAddress.toLowerCase() === email)) await clerk().invitations.revokeInvitation(inv.id);
}

/** Emails a sign-up link. Safe to repeat: an existing pending invitation is ignored. */
export async function sendInvitation(email: string) {
  await clerk().invitations.createInvitation({ emailAddress: email, redirectUrl: `${origins()[0]}/sign-up`, ignoreExisting: true, notify: true });
}

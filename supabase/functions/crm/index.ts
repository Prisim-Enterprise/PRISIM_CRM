import { createClient, type User } from "@supabase/supabase-js";
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

type Table<Row> = {
  Row: Row;
  Insert: Partial<Row>;
  Update: Partial<Row>;
  Relationships: [];
};

interface Database {
  public: {
    Tables: {
      audit_logs: Table<{ id: string; actorId: string | null; action: string; entityType: string; entityId: string | null; ip: string | null }>;
      permissions: Table<{ id: string; key: string }>;
      role_permissions: Table<{ roleId: string; permissionId: string }>;
      roles: Table<{ id: string; key: string }>;
      teams: Table<{ id: string; name: string; leaderId: string | null }>;
      user_permissions: Table<{ userId: string; permissionId: string; effect: "GRANT" | "DENY" }>;
      user_roles: Table<{ userId: string; roleId: string }>;
      users: Table<{
        id: string;
        fullName: string;
        email: string;
        phone: string | null;
        timezone: string;
        teamId: string | null;
        authUserId: string | null;
        isActive: boolean;
        lastLoginAt: string | null;
      }>;
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: { PermissionEffect: "GRANT" | "DENY" };
    CompositeTypes: Record<string, never>;
  };
}

type CrmDb = ReturnType<typeof createClient<Database>>;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, PATCH, OPTIONS",
};

type HttpError = { status: number; message: string };
type UserRow = {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  timezone: string;
  teamId: string | null;
  authUserId: string | null;
  isActive: boolean;
  lastLoginAt: string | null;
};

const response = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: corsHeaders });

const errorResponse = (status: number, message: string) =>
  response({ statusCode: status, message }, status);

function requiredEnv(name: string, fallback?: string) {
  const value = Deno.env.get(name) ?? (fallback ? Deno.env.get(fallback) : undefined);
  if (!value) throw new Error(`Missing Edge Function environment variable: ${name}`);
  return value;
}

function getClients() {
  const url = requiredEnv("SUPABASE_URL");
  const publishableKey = requiredEnv("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY");
  const secretKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY");
  const authClient = createClient<Database>(url, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const db = createClient<Database>(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return { authClient, db };
}

async function getCrmUser(db: CrmDb, authUser: User): Promise<UserRow> {
  if (!authUser.email || !authUser.email_confirmed_at) {
    throw { status: 403, message: "This account has not been added to Prisim CRM. Ask your administrator." } satisfies HttpError;
  }

  const linked = await db.from("users")
    .select("id, fullName, email, phone, timezone, teamId, authUserId, isActive, lastLoginAt")
    .eq("authUserId", authUser.id)
    .maybeSingle();
  if (linked.error) throw new Error(`Could not load CRM user: ${linked.error.message}`);

  let user = linked.data as UserRow | null;
  if (!user) {
    const byEmail = await db.from("users")
      .select("id, fullName, email, phone, timezone, teamId, authUserId, isActive, lastLoginAt")
      .eq("email", authUser.email.toLowerCase())
      .maybeSingle();
    if (byEmail.error) throw new Error(`Could not look up CRM user: ${byEmail.error.message}`);
    user = byEmail.data as UserRow | null;
    if (!user || (user.authUserId && user.authUserId !== authUser.id)) {
      throw { status: 403, message: "This account has not been added to Prisim CRM. Ask your administrator." } satisfies HttpError;
    }
    if (!user.authUserId) {
      const link = await db.from("users")
        .update({ authUserId: authUser.id })
        .eq("id", user.id)
        .is("authUserId", null)
        .select("authUserId")
        .maybeSingle();
      if (link.error) throw new Error(`Could not link CRM user: ${link.error.message}`);
      if (link.data?.authUserId !== authUser.id) {
        const current = await db.from("users").select("authUserId").eq("id", user.id).single();
        if (current.error) throw new Error(`Could not verify CRM user link: ${current.error.message}`);
        if (current.data.authUserId !== authUser.id) {
          throw { status: 403, message: "This account has not been added to Prisim CRM. Ask your administrator." } satisfies HttpError;
        }
      }
      user.authUserId = authUser.id;
    }
  }

  if (!user.isActive) throw { status: 401, message: "Account is inactive" } satisfies HttpError;
  return user;
}

async function getMe(db: CrmDb, user: UserRow, request: Request) {
  const userRoles = await db.from("user_roles").select("roleId").eq("userId", user.id);
  if (userRoles.error) throw new Error(`Could not load user roles: ${userRoles.error.message}`);
  const roleIds = (userRoles.data ?? []).map((row) => row.roleId);

  const roles = roleIds.length
    ? await db.from("roles").select("id, key").in("id", roleIds)
    : { data: [], error: null };
  if (roles.error) throw new Error(`Could not load roles: ${roles.error.message}`);
  const roleKeys = (roles.data ?? []).map((role) => role.key);

  const rolePermissions = roleIds.length
    ? await db.from("role_permissions").select("permissionId").in("roleId", roleIds)
    : { data: [], error: null };
  if (rolePermissions.error) throw new Error(`Could not load role permissions: ${rolePermissions.error.message}`);
  const permissionIds = new Set((rolePermissions.data ?? []).map((row) => row.permissionId));

  const overrides = await db.from("user_permissions")
    .select("permissionId, effect")
    .eq("userId", user.id);
  if (overrides.error) throw new Error(`Could not load user permissions: ${overrides.error.message}`);
  for (const override of overrides.data ?? []) permissionIds.add(override.permissionId);

  const permissionRows = permissionIds.size
    ? await db.from("permissions").select("id, key").in("id", [...permissionIds])
    : { data: [], error: null };
  if (permissionRows.error) throw new Error(`Could not load permissions: ${permissionRows.error.message}`);
  const keysById = new Map((permissionRows.data ?? []).map((permission) => [permission.id, permission.key]));
  const permissions = new Set<string>();
  for (const row of rolePermissions.data ?? []) {
    const key = keysById.get(row.permissionId);
    if (key) permissions.add(key);
  }
  for (const override of overrides.data ?? []) {
    const key = keysById.get(override.permissionId);
    if (!key) continue;
    if (override.effect === "GRANT") permissions.add(key);
    if (override.effect === "DENY") permissions.delete(key);
  }

  const [teamResult, ledTeamsResult] = await Promise.all([
    user.teamId
      ? db.from("teams").select("id, name").eq("id", user.teamId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    db.from("teams").select("id").eq("leaderId", user.id),
  ]);
  if (teamResult.error) throw new Error(`Could not load user's team: ${teamResult.error.message}`);
  if (ledTeamsResult.error) throw new Error(`Could not load teams led by user: ${ledTeamsResult.error.message}`);
  const teamIds = new Set((ledTeamsResult.data ?? []).map((team) => team.id));
  if (user.teamId) teamIds.add(user.teamId);

  if (!user.lastLoginAt || Date.now() - new Date(user.lastLoginAt).getTime() > 60 * 60_000) {
    const now = new Date().toISOString();
    const update = await db.from("users").update({ lastLoginAt: now }).eq("id", user.id);
    if (update.error) throw new Error(`Could not update last login: ${update.error.message}`);
    const audit = await db.from("audit_logs").insert({
      actorId: user.id,
      action: "auth.login",
      entityType: "user",
      entityId: user.id,
      ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    });
    if (audit.error) console.error(`Failed to write login audit log: ${audit.error.message}`);
  }

  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
    timezone: user.timezone,
    teamId: user.teamId,
    team: teamResult.data,
    roles: roleKeys.sort(),
    permissions: [...permissions].sort(),
    teamIds: [...teamIds],
  };
}

function normalizePhone(raw: unknown) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") throw { status: 400, message: "Phone number is not valid" } satisfies HttpError;
  let value = raw.trim().replace(/^p:/i, "").replace(/[^\d+]/g, "");
  if (!value) return null;
  if (value.startsWith("00")) value = `+${value.slice(2)}`;
  const country = (Deno.env.get("DEFAULT_COUNTRY") || "IN") as CountryCode;
  const parsed = parsePhoneNumberFromString(value, country);
  if (!parsed?.isValid()) throw { status: 400, message: "Phone number is not valid" } satisfies HttpError;
  return parsed.number;
}

async function updateMe(db: CrmDb, user: UserRow, request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    throw { status: 400, message: "Invalid JSON body" } satisfies HttpError;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw { status: 400, message: "Invalid request body" } satisfies HttpError;
  }
  const unknownKeys = Object.keys(body).filter((key) => key !== "phone" && key !== "timezone");
  if (unknownKeys.length) throw { status: 400, message: `Unexpected fields: ${unknownKeys.join(", ")}` } satisfies HttpError;

  const update: { phone?: string | null; timezone?: string } = {};
  if ("phone" in body) update.phone = normalizePhone(body.phone);
  if ("timezone" in body && body.timezone !== undefined) {
    if (typeof body.timezone !== "string" || body.timezone.length > 64) {
      throw { status: 400, message: "Timezone is invalid" } satisfies HttpError;
    }
    if (body.timezone) update.timezone = body.timezone;
  }
  if (!Object.keys(update).length) return { ok: true };

  const result = await db.from("users").update(update).eq("id", user.id);
  if (result.error) throw new Error(`Could not update profile: ${result.error.message}`);
  return { ok: true };
}

async function handle(request: Request) {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const path = new URL(request.url).pathname.replace(/^\/functions\/v1\/crm/, "") || "/";
  if (path !== "/auth/me" || !["GET", "PATCH"].includes(request.method)) {
    return errorResponse(404, "Not found");
  }

  const authorization = request.headers.get("authorization");
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return errorResponse(401, "Not signed in");

  try {
    const { authClient, db } = getClients();
    const { data, error } = await authClient.auth.getUser(token);
    if (error || !data.user) return errorResponse(401, "Session expired. Please sign in again.");
    const user = await getCrmUser(db, data.user);
    const result = request.method === "GET"
      ? await getMe(db, user, request)
      : await updateMe(db, user, request);
    return response(result);
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && "message" in error) {
      const httpError = error as HttpError;
      return errorResponse(httpError.status, httpError.message);
    }
    console.error("Supabase CRM function failed", error);
    return errorResponse(500, "Internal server error");
  }
}

Deno.serve((request) => handle(request));

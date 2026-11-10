const BASE = '/api/v1';
const EDGE_AUTH_ENABLED = import.meta.env.VITE_SUPABASE_EDGE_AUTH === 'true';
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

/** Access tokens are short-lived, so each request asks for a current one. */
let getToken: () => Promise<string | null> = async () => null;
export const setTokenGetter = (fn: () => Promise<string | null>) => { getToken = fn; };

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined | null | string[]>;

export function qs(q?: Query) {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

const baseHeaders = async (): Promise<Record<string, string>> => {
  const token = await getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

/** Hosted API requests are limited to about 4.5 MB, so larger files go straight to storage. */
const DIRECT_UPLOAD_BYTES = 3 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  const isForm = body instanceof FormData;
  const useEdgeAuth = EDGE_AUTH_ENABLED && path === '/auth/me';
  let url = BASE + path + qs(query);
  const extraHeaders: Record<string, string> = {};
  if (useEdgeAuth) {
    if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
      throw new ApiError(500, 'Supabase URL and publishable key are required for Edge Function auth');
    }
    url = `${SUPABASE_URL}/functions/v1/crm${path}${qs(query)}`;
    extraHeaders.apikey = SUPABASE_PUBLISHABLE_KEY;
  }
  const res = await fetch(url, {
    method,
    headers: {
      ...(await baseHeaders()),
      ...extraHeaders,
      ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  if (res.status === 401 && path !== '/auth/me') window.dispatchEvent(new Event('prisim:logout'));
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : undefined;
  if (!res.ok) {
    const msg = Array.isArray(data?.message) ? data.message.join(', ') : data?.message || res.statusText;
    throw new ApiError(res.status, msg, data);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', path, undefined, query),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  del: <T>(path: string) => request<T>('DELETE', path),
  upload: async <T>(path: string, file: File, field = 'file') => {
    if (file.size > MAX_UPLOAD_BYTES) throw new ApiError(400, 'File is larger than 25 MB');
    if (file.size > DIRECT_UPLOAD_BYTES) {
      const slot = await request<{ url: string | null; key?: string }>('POST', '/uploads/sign', {});
      if (slot.url) {
        const put = await fetch(slot.url, { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
        if (!put.ok) throw new ApiError(put.status, 'The file could not be uploaded');
        return request<T>('POST', path, {}, { staged: slot.key, name: file.name, type: file.type });
      }
    }
    const fd = new FormData();
    fd.append(field, file);
    return request<T>('POST', path, fd);
  },
  /** Fetches a protected file and returns an object URL (audio players can't send auth headers). */
  blobUrl: async (path: string) => {
    const res = await fetch(BASE + path, { headers: await baseHeaders() });
    if (!res.ok) {
      const t = await res.text();
      throw new ApiError(res.status, (() => { try { return JSON.parse(t).message; } catch { return res.statusText; } })());
    }
    // Hosted files come from a short-lived storage link rather than the API reply.
    const location = res.headers.get('x-file-location');
    const file = location ? await fetch(location) : res;
    if (!file.ok) throw new ApiError(file.status, 'The file could not be opened');
    return URL.createObjectURL(await file.blob());
  },
  download: async (path: string, query?: Query, fallbackName = 'download') => {
    const res = await fetch(BASE + path + qs(query), { headers: await baseHeaders() });
    if (!res.ok) throw new ApiError(res.status, 'Download failed');
    const name = res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? fallbackName;
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  },
};

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

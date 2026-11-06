const BASE = '/api/v1';

/** Clerk session tokens are short-lived, so each request asks Clerk for a current one. */
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

/** Sent on every request. The skip header stops ngrok's free-plan warning page from replacing API replies. */
const baseHeaders = async (): Promise<Record<string, string>> => {
  const token = await getToken();
  return { 'ngrok-skip-browser-warning': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
};

async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(BASE + path + qs(query), {
    method,
    headers: {
      ...(await baseHeaders()),
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
  upload: <T>(path: string, file: File, field = 'file') => {
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
    return URL.createObjectURL(await res.blob());
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

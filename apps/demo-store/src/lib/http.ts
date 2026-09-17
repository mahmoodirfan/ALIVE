export class ApiError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(typeof body === 'object' && body !== null && 'message' in body ? String((body as { message: unknown }).message) : `Request failed with ${status}`);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await response.json()) as unknown;
  if (!response.ok) throw new ApiError(response.status, body);
  return body as T;
}

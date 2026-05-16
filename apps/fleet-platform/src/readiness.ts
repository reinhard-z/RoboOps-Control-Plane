const defaultReadinessTimeoutMs = 2_000;

/** Stable label for the repository read check used by HTTP and CLI readiness paths. */
export const repositoryReadinessCheckName = "repository.read";

/** Default readiness timeout shared by HTTP health and manual validation commands. */
export const readinessRepositoryReadTimeoutMs = defaultReadinessTimeoutMs;

/** Runs a bounded readiness read so unavailable backing services fail fast. */
export async function runRepositoryReadinessCheck(
  readOperation: () => Promise<unknown>,
  timeoutMs: number = readinessRepositoryReadTimeoutMs
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      readOperation(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new ReadinessTimeoutError(timeoutMs));
        }, timeoutMs);
        timeout.unref();
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

/** Classifies readiness failures without exposing raw driver text or connection details. */
export function classifyReadinessError(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) {
    return safeErrorName(error.name);
  }
  return typeof error;
}

/** Keeps error type labels useful while rejecting values that look like payload text. */
function safeErrorName(name: string): string {
  if (/^[A-Za-z][A-Za-z0-9_.-]{0,80}$/.test(name)) {
    return name;
  }
  return "Error";
}

/** Internal readiness sentinel that avoids exposing raw repository error text. */
export class ReadinessTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`repository readiness check exceeded ${timeoutMs}ms`);
    this.name = "ReadinessTimeoutError";
  }
}

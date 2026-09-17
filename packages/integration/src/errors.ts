export type AliveIntegrationErrorCode = 'ALIVE_INVALID_API_CONTRACT';

export class AliveIntegrationError extends Error {
  readonly code: AliveIntegrationErrorCode;

  constructor(code: AliveIntegrationErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'AliveIntegrationError';
    this.code = code;
  }
}

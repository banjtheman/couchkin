// Fixed vocabularies keep server-provided strings and request content out of diagnostics.
const kinds = ['api_error', 'socket_error', 'unexpected_close', 'handshake_error'] as const;
const outgoingTypes = [
  'session.start',
  'session.close',
  'session.thinking.append',
  'session.commentary.append',
  'session.instructions.append',
  'session.input_audio.mute',
  'session.input_audio.unmute',
  'response.item.create',
  'response.create',
] as const;
const apiCodes = [
  'invalid_request_error',
  'invalid_api_key',
  'authentication_error',
  'permission_denied',
  'access_denied',
  'model_not_found',
  'rate_limit_exceeded',
  'insufficient_quota',
  'billing_not_active',
  'server_error',
  'internal_error',
  'service_unavailable',
  'context_injection_incomplete',
  'responses_validation_failed',
  'context_length_exceeded',
  'invalid_value',
  'invalid_type',
  'missing_required_parameter',
  'unknown_parameter',
  'unsupported_parameter',
  'unsupported_value',
] as const;
const apiTypes = [
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'rate_limit_error',
  'server_error',
  'api_error',
] as const;
const apiParams = [
  'type',
  'audio',
  'content',
  'delegation_id',
  'model',
  'instructions',
  'tools',
  'session',
  'session.model',
  'session.instructions',
  'session.input',
  'session.store',
  'session.audio',
  'session.audio.format',
  'session.audio.format.type',
  'session.audio.format.rate',
  'session.audio.output.voice',
  'session.delegation',
  'session.delegation.type',
  'session.delegation.acknowledgement_delay_ms',
  'session.delegation.responses',
  'session.delegation.responses.model',
  'session.delegation.responses.instructions',
  'session.delegation.responses.tools',
  'session.delegation.responses.tool_choice',
  'session.delegation.responses.parallel_tool_calls',
  'session.delegation.responses.max_output_tokens',
  'item',
  'item.type',
  'item.role',
  'item.content',
  'item.call_id',
  'item.output',
  'response',
] as const;
const socketCodes = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ECONNABORTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'WS_ERR_UNEXPECTED_RSV_1',
  'WS_ERR_UNEXPECTED_RSV_2_3',
  'WS_ERR_INVALID_OPCODE',
  'WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH',
  'WS_ERR_UNEXPECTED_MASK',
  'WS_ERR_EXPECTED_MASK',
  'WS_ERR_INVALID_UTF8',
  'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH',
  'WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH',
] as const;

export type LiveDiagnosticOutgoingType = (typeof outgoingTypes)[number];
export interface LiveTransportDiagnostic {
  kind: (typeof kinds)[number];
  sessionElapsedMs: number;
  lastReceivedAgeMs: number | null;
  bufferedBytes: number;
  pendingToolCount: number;
  pendingContextCount: number;
  outgoingEventType?: LiveDiagnosticOutgoingType;
  apiErrorCode?: (typeof apiCodes)[number] | 'unknown';
  apiErrorType?: (typeof apiTypes)[number] | 'unknown';
  apiErrorParam?: (typeof apiParams)[number] | 'unknown';
  socketErrorCode?: (typeof socketCodes)[number] | 'unknown';
  closeCode?: number;
  httpStatus?: number;
}

function member<T extends readonly string[]>(value: unknown, allowed: T): T[number] | undefined {
  return typeof value === 'string' && allowed.includes(value) ? value : undefined;
}
function category<T extends readonly string[]>(value: unknown, allowed: T) {
  return typeof value === 'string' ? (member(value, allowed) ?? 'unknown') : undefined;
}
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value)))
    : 0;
}
export function diagnosticOutgoingType(value: unknown): LiveDiagnosticOutgoingType | undefined {
  return member(value, outgoingTypes);
}

/** Rebuild from an allowlist; never spread raw errors or caller-supplied extra properties. */
export function sanitizeLiveTransportDiagnostic(value: unknown): LiveTransportDiagnostic | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const kind = member(raw.kind, kinds);
  if (!kind) return null;
  const result: LiveTransportDiagnostic = {
    kind,
    sessionElapsedMs: count(raw.sessionElapsedMs),
    lastReceivedAgeMs: raw.lastReceivedAgeMs == null ? null : count(raw.lastReceivedAgeMs),
    bufferedBytes: count(raw.bufferedBytes),
    pendingToolCount: count(raw.pendingToolCount),
    pendingContextCount: count(raw.pendingContextCount),
  };
  const outgoingEventType = diagnosticOutgoingType(raw.outgoingEventType);
  const apiErrorCode = category(raw.apiErrorCode, apiCodes);
  const apiErrorType = category(raw.apiErrorType, apiTypes);
  const apiErrorParam = category(raw.apiErrorParam, apiParams);
  const socketErrorCode = category(raw.socketErrorCode, socketCodes);
  if (outgoingEventType) result.outgoingEventType = outgoingEventType;
  if (apiErrorCode) result.apiErrorCode = apiErrorCode;
  if (apiErrorType) result.apiErrorType = apiErrorType;
  if (apiErrorParam) result.apiErrorParam = apiErrorParam;
  if (socketErrorCode) result.socketErrorCode = socketErrorCode;
  if (
    Number.isInteger(raw.closeCode) &&
    Number(raw.closeCode) >= 1000 &&
    Number(raw.closeCode) <= 4999
  )
    result.closeCode = Number(raw.closeCode);
  if (
    Number.isInteger(raw.httpStatus) &&
    Number(raw.httpStatus) >= 100 &&
    Number(raw.httpStatus) <= 599
  )
    result.httpStatus = Number(raw.httpStatus);
  return result;
}

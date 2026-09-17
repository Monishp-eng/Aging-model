export type GenerationStatus =
  | "queued"
  | "processing"
  | "succeeded"
  | "failed"
  | "canceled"
  | "expired";

export type CreditTransactionType =
  | "purchase"
  | "reservation"
  | "consumption"
  | "refund"
  | "adjustment";

export type WebhookProvider = "stripe" | "replicate" | "supabase";

export type WebhookStatus =
  | "received"
  | "processing"
  | "processed"
  | "failed"
  | "ignored";

export type DeletionStatus = "active" | "pending" | "deleted";

export interface User {
  id: string;
  auth_provider_user_id: string;
  email: string;
  name: string | null;
  image: string | null;
  stripe_customer_id: string | null;
  credits_balance: number;
  deletion_requested_at: string | null;
  deletion_status: DeletionStatus;
  deleted_at?: string | null;
  deletion_error?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Generation {
  id: string;
  user_id: string;
  status: GenerationStatus;
  input_path: string;
  output_path: string | null;
  replicate_prediction_id: string | null;
  credits_reserved: number;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  expires_at?: string | null;
  cleaned_up_at?: string | null;
  delete_attempts?: number;
  last_delete_error?: string | null;
  attempt_count?: number;
  processing_started_at?: string | null;
  last_reconciled_at?: string | null;
  client_idempotency_key?: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreditLedgerEntry {
  id: string;
  user_id: string;
  generation_id: string | null;
  stripe_event_id: string | null;
  type: CreditTransactionType;
  amount: number; // Signed integer: +100 for purchase, -10 for reservation, +10 for refund
  metadata: string | null;
  created_at: string;
}

export interface WebhookEvent {
  id: string;
  provider: WebhookProvider;
  external_event_id: string;
  event_type: string;
  payload_hash: string | null;
  status: WebhookStatus;
  received_at: string;
  processed_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface Product {
  id: string;
  stripe_product_id: string;
  name: string;
  description: string | null;
  active: number; // 0 or 1
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

export interface Price {
  id: string;
  stripe_price_id: string;
  product_id: string;
  unit_amount: number; // in cents, e.g. 900 for $9.00
  currency: string;
  active: number; // 0 or 1
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProductWithPrice {
  id: string;
  price_id: string;
  name: string;
  description: string;
  price: number; // in dollars, e.g. 9.00
  credits: number;
}

// Domain Errors
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class NotFoundError extends DomainError {}
export class ConflictError extends DomainError {}
export class ValidationError extends DomainError {}
export class InsufficientCreditsError extends DomainError {
  constructor(public required: number, public available: number) {
    super(`Insufficient credits: requires ${required}, available: ${available}`);
  }
}
export class InvalidStateTransitionError extends DomainError {
  constructor(public currentStatus: GenerationStatus, public targetStatus: GenerationStatus) {
    super(`Invalid generation state transition from '${currentStatus}' to '${targetStatus}'`);
  }
}
export class DuplicateRefundError extends DomainError {
  constructor(public generationId: string) {
    super(`Generation '${generationId}' has already been refunded`);
  }
}
export class DuplicateReservationError extends DomainError {
  constructor(public generationId: string) {
    super(`Generation '${generationId}' already has credits reserved`);
  }
}

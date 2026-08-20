export interface ProtectedExposure {
  contract_id: string;
  quantity: number;
  stop_distance_ticks: number;
  tick_value: number;
  fees_usd: number;
  slippage_ticks: number;
}

export interface PortfolioAdmissionInput {
  hard_loss_buffer_usd: number;
  existing: readonly ProtectedExposure[];
  pending: readonly ProtectedExposure[];
  candidate: ProtectedExposure;
  simultaneous_exposure_enabled: boolean;
  /** Foreign exposure the caller observed but could not price; keeps the gate honest. */
  foreign_exposure_present?: boolean;
  unprotected_existing_exposure?: boolean;
}

export interface PortfolioAdmissionResult {
  allowed: boolean;
  code: "ok" | "simultaneous_exposure_disabled" | "portfolio_hard_loss_floor_breach" | "portfolio_protection_unproven";
  protected_downside_usd: number;
  remaining_buffer_usd: number;
}

export function protectedExposureUsd(exposure: ProtectedExposure): number {
  if (!Number.isInteger(exposure.quantity) || exposure.quantity < 1) {
    throw new Error("portfolio_quantity_invalid");
  }
  const values = [
    exposure.stop_distance_ticks,
    exposure.tick_value,
    exposure.fees_usd,
    exposure.slippage_ticks,
  ];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("portfolio_exposure_invalid");
  }
  return exposure.quantity * (
    exposure.stop_distance_ticks * exposure.tick_value
    + exposure.slippage_ticks * exposure.tick_value
    + exposure.fees_usd
  );
}

export function evaluatePortfolioAdmission(input: PortfolioAdmissionInput): PortfolioAdmissionResult {
  const foreignOpen = input.foreign_exposure_present === true
    || [...input.existing, ...input.pending]
      .some((row) => row.contract_id !== input.candidate.contract_id);
  const protectedDownsideUsd = [...input.existing, ...input.pending, input.candidate]
    .reduce((total, row) => total + protectedExposureUsd(row), 0);
  const remainingBufferUsd = input.hard_loss_buffer_usd - protectedDownsideUsd;
  if (foreignOpen && !input.simultaneous_exposure_enabled) {
    return {
      allowed: false,
      code: "simultaneous_exposure_disabled",
      protected_downside_usd: protectedDownsideUsd,
      remaining_buffer_usd: remainingBufferUsd,
    };
  }
  if (input.unprotected_existing_exposure) {
    return {
      allowed: false,
      code: "portfolio_protection_unproven",
      protected_downside_usd: protectedDownsideUsd,
      remaining_buffer_usd: remainingBufferUsd,
    };
  }
  if (remainingBufferUsd <= 0) {
    return {
      allowed: false,
      code: "portfolio_hard_loss_floor_breach",
      protected_downside_usd: protectedDownsideUsd,
      remaining_buffer_usd: remainingBufferUsd,
    };
  }
  return {
    allowed: true,
    code: "ok",
    protected_downside_usd: protectedDownsideUsd,
    remaining_buffer_usd: remainingBufferUsd,
  };
}

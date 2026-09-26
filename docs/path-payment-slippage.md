# Path Payment and Slippage Guide

Path payments let users fund an escrow with one asset while the recipient or
contract receives another. The route depends on Stellar liquidity and oracle
guardrails.

## How It Works

1. User selects source asset, destination asset, and amount.
2. Backend estimates available paths and expected destination amount.
3. Client displays quote, route, fee, and slippage tolerance.
4. User signs the transaction before the quote expires.
5. Monitor verifies final delivered amount against escrow policy.

## Slippage Settings

- Default tolerance should be conservative for stable pairs.
- High-volatility pairs should require explicit user confirmation.
- Quotes must include expiry time and minimum received amount.
- Transactions below minimum received should fail rather than silently underpay.

## Oracle Dependencies

Oracle prices are used for risk checks and display estimates. They should not be
treated as a guarantee of executable liquidity. If oracle data is stale, the UI
must block route confirmation or label the quote as unavailable.

## User Risks

- The route can expire before signing.
- Liquidity can move between quote and ledger close.
- Destination amount can be lower than the estimate but not below the protected
  minimum.
- Unsupported assets may require trustline setup before payment.

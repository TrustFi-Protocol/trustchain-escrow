# Testnet Deployment Guide for Trustchain Escrow

This guide provides step-by-step instructions for deploying and testing the Trustchain Escrow smart contracts on the Stellar testnet.

## Prerequisites

### Required Software
- **Stellar CLI**: `sudo apt-get install stellar-cli` (or use [official installation](https://developers.stellar.org/docs/build/guides/cli))
- **Soroban CLI**: `cargo install soroban-cli` (requires Rust)
- **Rust**: Install from [https://rustup.rs/](https://rustup.rs/)
- **Node.js**: v20 or higher (for backend services)
- **Docker** (optional): For running local services

### Verify Installation
```bash
stellar version
soroban --version
cargo --version
node --version
```

## Step 1: Fund Your Testnet Account

### 1.1 Create an Account
If you don't have a Stellar testnet account, create one:

```bash
# Generate a new keypair
soroban config keypair generate testnet-key --network testnet

# View your public key
soroban config keypair show testnet-key
```

### 1.2 Fund the Account
Use the [Stellar Friendbot](https://developers.stellar.org/docs/build/guides/network#testnet) to fund your testnet account:

```bash
ACCOUNT_ID=$(soroban config keypair show testnet-key)
curl "https://friendbot.stellar.org?addr=$ACCOUNT_ID"

# Verify funding
soroban config network show testnet
```

## Step 2: Set Up the Project

### 2.1 Clone the Repository
```bash
git clone https://github.com/TrustFi-Protocol/trustchain-escrow.git
cd trustchain-escrow
```

### 2.2 Install Dependencies
```bash
# Install Rust dependencies
cargo build --release

# Install Node.js dependencies (for backend)
npm install
```

## Step 3: Build the Smart Contracts

### 3.1 Build Escrow Contract
```bash
cd contracts/escrow_contract
cargo build --target wasm32-unknown-unknown --release
```

### 3.2 Build Shared Library
```bash
cd contracts/shared
cargo build --target wasm32-unknown-unknown --release
```

### 3.3 Verify Build Artifacts
```bash
ls -lah target/wasm32-unknown-unknown/release/*.wasm
```

## Step 4: Deploy Smart Contracts to Testnet

### 4.1 Deploy Escrow Contract
```bash
# Set network to testnet
soroban config network add testnet \
  --rpc-url https://soroban-testnet.stellar.org:443 \
  --network-passphrase "Test SDF Network ; September 2015"

# Deploy the escrow contract
soroban contract deploy \
  --wasm contracts/escrow_contract/target/wasm32-unknown-unknown/release/escrow_contract.wasm \
  --source testnet-key \
  --network testnet
```

This will output a **Contract ID** (looks like `CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`).
Save this for later use.

### 4.2 Deploy Shared Contract
```bash
soroban contract deploy \
  --wasm contracts/shared/target/wasm32-unknown-unknown/release/shared.wasm \
  --source testnet-key \
  --network testnet
```

### 4.3 Store Contract IDs
```bash
# Save for use in environment variables
export ESCROW_CONTRACT_ID="C..."  # Replace with deployed ID
export SHARED_CONTRACT_ID="C..."  # Replace with deployed ID
```

## Step 5: Initialize the Contract

### 5.1 Call Initialize Function
```bash
soroban contract invoke \
  --id $ESCROW_CONTRACT_ID \
  --source testnet-key \
  --network testnet \
  -- \
  initialize \
  --admin <YOUR_ACCOUNT_ID>
```

## Step 6: Configure REST API (Backend)

### 6.1 Set Environment Variables
```bash
cat > .env << EOL
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org:443
STELLAR_NETWORK=testnet
STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
ESCROW_CONTRACT_ID=$ESCROW_CONTRACT_ID
ADMIN_SECRET_KEY=$(soroban config keypair show testnet-key --private)
REDIS_URL=redis://localhost:6379
DATABASE_URL=postgresql://user:password@localhost/trustchain
EOL
```

### 6.2 Start Backend Services
```bash
# Start Redis (required for caching)
docker run -d -p 6379:6379 redis:latest

# Start the backend API
npm run start:backend
```

### 6.3 Verify API is Running
```bash
curl http://localhost:3000/health
# Expected response: { "status": "ok" }
```

## Step 7: Test Contract Invocations

### 7.1 Create an Escrow
```bash
CLIENT_ACCOUNT=$(soroban config keypair show testnet-key)
CONTRACTOR="GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
USDC="CBBD47AB434DF7399F4EF6F02A131F643987AAFC439D5DB53353C8414B5C86F1"

soroban contract invoke \
  --id $ESCROW_CONTRACT_ID \
  --source testnet-key \
  --network testnet \
  -- \
  create_escrow \
  --client $CLIENT_ACCOUNT \
  --contractor $CONTRACTOR \
  --token $USDC \
  --amount 1000000000 \
  --description "Test Escrow" \
  --dispute_timeout 604800
```

### 7.2 Add a Milestone
```bash
ESCROW_ID="0"  # ID from previous call

soroban contract invoke \
  --id $ESCROW_CONTRACT_ID \
  --source testnet-key \
  --network testnet \
  -- \
  add_milestone \
  --escrow_id $ESCROW_ID \
  --amount 500000000 \
  --description "Phase 1 Completion"
```

### 7.3 Submit a Milestone (as Contractor)
```bash
soroban contract invoke \
  --id $ESCROW_CONTRACT_ID \
  --source testnet-key \
  --network testnet \
  -- \
  submit_milestone \
  --escrow_id $ESCROW_ID \
  --milestone_index 0
```

### 7.4 Approve a Milestone (as Client)
```bash
soroban contract invoke \
  --id $ESCROW_CONTRACT_ID \
  --source testnet-key \
  --network testnet \
  -- \
  approve_milestone \
  --escrow_id $ESCROW_ID \
  --milestone_index 0
```

### 7.5 Release Funds
```bash
soroban contract invoke \
  --id $ESCROW_CONTRACT_ID \
  --source testnet-key \
  --network testnet \
  -- \
  release_funds \
  --escrow_id $ESCROW_ID \
  --milestone_index 0
```

## Step 8: Monitor Escrow State

### 8.1 Query Escrow Details
```bash
soroban contract invoke \
  --id $ESCROW_CONTRACT_ID \
  --source testnet-key \
  --network testnet \
  -- \
  get_escrow \
  --escrow_id $ESCROW_ID
```

### 8.2 Check Reputation Score
```bash
soroban contract invoke \
  --id $ESCROW_CONTRACT_ID \
  --source testnet-key \
  --network testnet \
  -- \
  get_reputation \
  --address $CONTRACTOR
```

## Step 9: Run Integration Tests

### 9.1 Backend Tests
```bash
npm run test
```

### 9.2 Contract Tests
```bash
cd contracts/escrow_contract
cargo test --target wasm32-unknown-unknown
```

## Troubleshooting

### Common Issues

#### 1. **Contract Deployment Fails**
- Ensure your account has sufficient XLM for fees
- Check Soroban RPC URL is accessible
- Verify WASM binary was built successfully

#### 2. **Invocation Returns "Source Account Sequence Invalid"**
```bash
# Reset sequence number by querying latest state
soroban config network show testnet
```

#### 3. **Redis Connection Issues**
- Verify Redis is running: `docker ps`
- Check Redis URL in `.env`
- Test connection: `redis-cli ping`

#### 4. **Contract Invocation Times Out**
- Increase timeout: `--timeout-seconds 60`
- Check network status at [Stellar Dashboard](https://testnet.stellar.expert/)

## Additional Resources

- **Soroban Documentation**: https://developers.stellar.org/docs/smart-contracts
- **Stellar Testnet**: https://testnet.stellar.org/
- **Trustchain Repository**: https://github.com/TrustFi-Protocol/trustchain-escrow
- **Discord Community**: https://discord.gg/trustfi

## Next Steps

1. Deploy frontend to testnet
2. Configure webhook endpoints for contract events
3. Set up monitoring and alerting
4. Conduct user acceptance testing (UAT)

---

For questions or issues, open an issue on GitHub: https://github.com/TrustFi-Protocol/trustchain-escrow/issues

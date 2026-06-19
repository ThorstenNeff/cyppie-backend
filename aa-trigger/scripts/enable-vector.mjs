import { hashChainSessions, getPermissionId, SmartSessionMode, SMART_SESSIONS_ADDRESS } from '@rhinestone/module-sdk';
import { hashTypedData } from 'viem';

// ── The EIP-712 type table for the Smart Sessions ENABLE digest (extracted from module-sdk 0.3.1) ──
const TYPES = {
  PolicyData: [{ name: 'policy', type: 'address' }, { name: 'initData', type: 'bytes' }],
  ActionData: [
    { name: 'actionTargetSelector', type: 'bytes4' },
    { name: 'actionTarget', type: 'address' },
    { name: 'actionPolicies', type: 'PolicyData[]' },
  ],
  ERC7739Context: [{ name: 'appDomainSeparator', type: 'bytes32' }, { name: 'contentName', type: 'string[]' }],
  ERC7739Data: [
    { name: 'allowedERC7739Content', type: 'ERC7739Context[]' },
    { name: 'erc1271Policies', type: 'PolicyData[]' },
  ],
  SignedPermissions: [
    { name: 'permitGenericPolicy', type: 'bool' },
    { name: 'permitAdminAccess', type: 'bool' },
    { name: 'ignoreSecurityAttestations', type: 'bool' },
    { name: 'permitERC4337Paymaster', type: 'bool' },
    { name: 'userOpPolicies', type: 'PolicyData[]' },
    { name: 'erc7739Policies', type: 'ERC7739Data' },
    { name: 'actions', type: 'ActionData[]' },
  ],
  SignedSession: [
    { name: 'account', type: 'address' },
    { name: 'permissions', type: 'SignedPermissions' },
    { name: 'sessionValidator', type: 'address' },
    { name: 'sessionValidatorInitData', type: 'bytes' },
    { name: 'salt', type: 'bytes32' },
    { name: 'smartSession', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
  ChainSession: [{ name: 'chainId', type: 'uint64' }, { name: 'session', type: 'SignedSession' }],
  MultiChainSession: [{ name: 'sessionsAndChainIds', type: 'ChainSession[]' }],
};
const DOMAIN = { name: 'SmartSession', version: '1' };  // NB: NO chainId, NO verifyingContract

// Independent recompute (only viem + the type table) — what Dev-2 will do on-device:
const rawHash = (chainSessions) =>
  hashTypedData({ domain: DOMAIN, types: TYPES, primaryType: 'MultiChainSession',
                  message: { sessionsAndChainIds: chainSessions } });

// Fixed, fully-literal inputs (well-known Hardhat acct0 = the SCA owner/account for the vector).
const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const SESSION_VALIDATOR = '0x0000000000000000000000000000000000000777'; // session-key validator (fixed)
const SESSION_KEY_INITDATA = '0x000000000000000000000000cafecafecafecafecafecafecafecafecafecafe';
const SALT = '0x0000000000000000000000000000000000000000000000000000000000000001';
const NONCE = 0n;

// permitERC4337Paymaster: MUST be true for a Pimlico-sponsored DCA op (the session has to permit a
// paymaster, else the sponsored userOp is rejected at session validation). erc7739Policies: empty for DCA
// (no ERC-1271/ERC-7739 content-signing in the session). BOTH are in the signed digest — disclose+map them.
function buildSession(actions, userOpPolicies, permitERC4337Paymaster = false) {
  return {
    account: ACCOUNT,
    permissions: {
      permitGenericPolicy: false, permitAdminAccess: false,
      ignoreSecurityAttestations: false, permitERC4337Paymaster,
      userOpPolicies, erc7739Policies: { allowedERC7739Content: [], erc1271Policies: [] }, actions,
    },
    sessionValidator: SESSION_VALIDATOR,
    sessionValidatorInitData: SESSION_KEY_INITDATA,
    salt: SALT,
    smartSession: SMART_SESSIONS_ADDRESS,
    nonce: NONCE,
  };
}

// Vector A — minimal (no policies, no actions): isolates the typed-data encoding.
const sessionA = buildSession([], []);
// Vector B — realistic DCA: one spending-limit userOpPolicy + one swap action with a time-frame action-policy.
const SPENDING_LIMIT_POLICY = '0x0000000000000000000000000000000000000511';
const TIMEFRAME_POLICY = '0x0000000000000000000000000000000000000522';
const DEX_ROUTER = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'; // Uniswap V3 router (example target)
const SWAP_SELECTOR = '0x5ae401dc'; // multicall(uint256,bytes[])
const dcaActions = [{ actionTargetSelector: SWAP_SELECTOR, actionTarget: DEX_ROUTER,
     actionPolicies: [{ policy: TIMEFRAME_POLICY, initData: '0x00000000000000000000000000000000000000000000000000000000683f9e8000000000000000000000000000000000000000000000000000000000687a4f00' }] }];
const dcaUserOpPolicies = [{ policy: SPENDING_LIMIT_POLICY, initData: '0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4800000000000000000000000000000000000000000000000000000000000f4240' }];
const sessionB = buildSession(dcaActions, dcaUserOpPolicies, false);
// Vector C — DCA SPONSORED: identical to B but permitERC4337Paymaster=true (the real DCA enable w/ Pimlico).
const sessionC = buildSession(dcaActions, dcaUserOpPolicies, true);

for (const [name, session] of [['A-minimal', sessionA], ['B-dca (paymaster=false)', sessionB], ['C-dca-sponsored (paymaster=true)', sessionC]]) {
  console.log(`\n──────── Vector ${name} ────────`);
  console.log('permissionId =', getPermissionId({ session }));
  for (const chainId of [1n, 8453n]) {
    const chainSessions = [{ chainId, session }];
    const sdk = hashChainSessions(chainSessions);
    const raw = rawHash(chainSessions);
    const match = sdk === raw ? 'MATCH ✓' : 'MISMATCH ✗';
    console.log(`  chainId=${chainId}: digestToSign = ${sdk}   (sdk vs raw-viem: ${match})`);
  }
}
console.log('\nmode(ENABLE) =', SmartSessionMode.ENABLE, '| smartSession(verifyingContract field) =', SMART_SESSIONS_ADDRESS);

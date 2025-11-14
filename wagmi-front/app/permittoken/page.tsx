'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  useAccount,
  useBalance,
  useChainId,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
  useSignTypedData,
  usePublicClient,
} from 'wagmi';
import {
  isAddress,
  parseUnits,
  formatUnits,
  BaseError,
  verifyTypedData,
  type Address,
  type Hex,
} from 'viem';

import permitTokenAbi from '../contracts/PermitToken.json';
import bankAbi from '../contracts/PermitTokenBank.json';

// ===== Config =====
const PERMIT_TOKEN_ADDRESS = '0x042eB0c69FC25678B0d399984c17959875f7018c' as Address;
const BANK_CONTRACT_ADDRESS = '0xA09A259Bd1516E1848337A592f19Ba08870f8FD2' as Address;
const EXPECTED_CHAIN_ID: number | undefined = 11155111;

// ===== Helpers =====
function explorerBaseFromChainId(chainId?: number) {
  switch (chainId) {
    case 1: return 'https://etherscan.io';
    case 11155111: return 'https://sepolia.etherscan.io';
    case 10: return 'https://optimistic.etherscan.io';
    case 8453: return 'https://basescan.org';
    case 42161: return 'https://arbiscan.io';
    case 137: return 'https://polygonscan.com';
    default: return undefined;
  }
}

// 解析 0x{r}{s}{v} 签名；并兼容 y-parity 0/1 → 27/28
function splitSig(signature: Hex) {
  const sig = signature.slice(2);
  const r = ('0x' + sig.slice(0, 64)) as Hex;
  const s = ('0x' + sig.slice(64, 128)) as Hex;
  let v = Number('0x' + sig.slice(128, 130));
  if (v === 0 || v === 1) v += 27;
  return { v, r, s };
}

export default function PermitTokenPage() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const explorerBase = explorerBaseFromChainId(chainId);
  const correctNetwork = EXPECTED_CHAIN_ID ? chainId === EXPECTED_CHAIN_ID : true;

  const { writeContractAsync, isPending: isWritePending, error: writeError } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();

  // Inputs
  const [depositAmount, setDepositAmount] = useState('');

  // Tx hash for receipt tracking
  const [hash, setHash] = useState<`0x${string}` | undefined>(undefined);

  // Token metadata
  const { data: tokenName } = useReadContract({
    address: PERMIT_TOKEN_ADDRESS,
    abi: permitTokenAbi,
    functionName: 'name',
  });
  const { data: tokenSymbol } = useReadContract({
    address: PERMIT_TOKEN_ADDRESS,
    abi: permitTokenAbi,
    functionName: 'symbol',
  });
  const { data: tokenDecimalsData } = useReadContract({
    address: PERMIT_TOKEN_ADDRESS,
    abi: permitTokenAbi,
    functionName: 'decimals',
  });
  const decimals =
    typeof tokenDecimalsData === 'number'
      ? tokenDecimalsData
      : Number(tokenDecimalsData ?? 18);

  // Balances
  const { data: tokenBalanceData, refetch: refetchTokenBalance } = useBalance({
    address,
    token: PERMIT_TOKEN_ADDRESS,
    chainId,
    // @ts-expect-error wagmi typings may vary
    query: { enabled: isConnected },
  });

  // Bank deposit
  const { data: bankDepositRaw, refetch: refetchBankDeposit } = useReadContract({
    address: BANK_CONTRACT_ADDRESS,
    abi: bankAbi,
    functionName: 'balanceOf',
    args: [address as Address],
    // @ts-expect-error
    query: { enabled: Boolean(address) },
  });

  // EIP-2612 nonces(owner)
  const { data: nonces, refetch: refetchNonces } = useReadContract({
    address: PERMIT_TOKEN_ADDRESS,
    abi: permitTokenAbi,
    functionName: 'nonces',
    args: [address ?? '0x0000000000000000000000000000000000000000'],
    // @ts-expect-error
    query: { enabled: Boolean(address) },
  });

  // Receipt tracking
  const {
    isLoading: isConfirming,
    isSuccess: isConfirmed,
    error: receiptError,
  } = useWaitForTransactionReceipt({ hash });

  // ===== Derived =====
  const formattedTokenBalance = tokenBalanceData
    ? `${tokenBalanceData.formatted} ${tokenBalanceData.symbol}`
    : '—';

  const formattedBankDeposit = useMemo(() => {
    if (bankDepositRaw == null) return '—';
    try {
      return `${formatUnits(bankDepositRaw as bigint, decimals)} ${tokenSymbol ?? ''}`.trim();
    } catch {
      return bankDepositRaw.toString();
    }
  }, [bankDepositRaw, decimals, tokenSymbol]);

  const depositAmountBigInt = useMemo(() => {
    if (!depositAmount) return undefined;
    try {
      return parseUnits(depositAmount, decimals);
    } catch {
      return undefined;
    }
  }, [depositAmount, decimals]);

  const depositAmountError = useMemo(() => {
    if (!depositAmount) return '';
    if (depositAmountBigInt == null) return 'Invalid amount format';
    if (depositAmountBigInt <= 0n) return 'Amount must be greater than 0';
    if (tokenBalanceData && depositAmountBigInt > tokenBalanceData.value) return 'Insufficient balance';
    return '';
  }, [depositAmount, depositAmountBigInt, tokenBalanceData]);

  const baseGuard =
    isConnected &&
    correctNetwork &&
    !isWritePending &&
    !isConfirming;

  const canDeposit =
    baseGuard &&
    !!depositAmountBigInt &&
    !depositAmountError;

  // ===== Effects =====
  const refetchAll = () => {
    refetchTokenBalance();
    refetchBankDeposit();
    refetchNonces();
  };

  useEffect(() => {
    if (address && chainId) refetchAll();
  }, [address, chainId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isConfirmed) refetchAll();
  }, [isConfirmed]); // eslint-disable-line react-hooks/exhaustive-deps

  const transactionStatus =
    isConfirming
      ? 'Confirming transaction…'
      : isConfirmed
      ? 'Transaction successful!'
      : writeError
      ? `Transaction Error: ${writeError instanceof BaseError ? (writeError.shortMessage ?? writeError.message) : writeError.message}`
      : receiptError
      ? `Receipt Error: ${receiptError instanceof BaseError ? (receiptError.shortMessage ?? receiptError.message) : (receiptError as Error).message}`
      : '';

  // ===== Actions =====
  const signPermit = async (value: bigint) => {
    // 最新 nonce
    const latest = await refetchNonces();
    const nonce = (latest.data as bigint) ?? (nonces as bigint) ?? 0n;
    const nowSec = Math.floor(Date.now() / 1000);
    const deadline = BigInt(nowSec + 60 * 20); // 20 分钟

    // 用链上 name、当前链 ID、合约地址构造 domain
    const currentChainId = await publicClient.getChainId();
    const domain = {
      name: (tokenName as string) || 'PermitToken',
      version: '1',
      chainId: currentChainId,
      verifyingContract: PERMIT_TOKEN_ADDRESS,
    } as const;

    const types = {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    } as const;

    const message = {
      owner: address as Address,
      spender: BANK_CONTRACT_ADDRESS,
      value,
      nonce,
      deadline,
    } as const;

    // 显式指定 account，避免用错地址签名
    const signature = (await signTypedDataAsync({
      account: address as Address,
      domain,
      types,
      primaryType: 'Permit',
      message,
    })) as Hex;

    // 本地先验签，避免把无效签名送上链（会触发 ERC2612InvalidSigner）
    const ok = await verifyTypedData({
      address: address as Address, // 期望的 signer
      domain,
      types,
      primaryType: 'Permit',
      message,
      signature,
    });
    if (!ok) {
      throw new Error('Local signature verification failed: signer != owner (ERC2612InvalidSigner)');
    }

    return { signature, deadline };
  };

  const handleDepositWithPermit = async () => {
    if (!canDeposit || !depositAmountBigInt) return;
    try {
      const { signature, deadline } = await signPermit(depositAmountBigInt);
      const { v, r, s } = splitSig(signature);

      // 先 simulate，获取正确 gas 等参数
      const { request } = await publicClient.simulateContract({
        address: BANK_CONTRACT_ADDRESS,
        abi: bankAbi,
        functionName: 'depositWithPermit',
        args: [depositAmountBigInt, deadline, v, r, s],
        account: address as Address,
      });

      const txHash = await writeContractAsync(request);
      setHash(txHash);
    } catch (e: any) {
      const msg =
        e instanceof BaseError
          ? (e.shortMessage ?? e.message)
          : (e?.message ?? String(e));
      console.error(e);
      alert(msg);
    }
  };

  // ===== UI =====
  return (
    <div className="mx-auto max-w-xl p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold">Permit &amp; Deposit</h1>
      </div>
      <p className="text-sm text-gray-600 mb-6">
        使用 EIP-2612 对 Bank 合约离线授权（免 on-chain approve），随后执行存款。
      </p>

      {!isConnected && (
        <div className="rounded-2xl border border-gray-200 p-4 text-sm text-gray-600 mb-6">
          未连接钱包。请在应用的全局入口处连接后再试。
        </div>
      )}

      {isConnected && !correctNetwork && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-amber-800 mb-6 text-sm">
          当前 Chain ID: {chainId}。此页面仅在 Chain ID {EXPECTED_CHAIN_ID} 上可交互。
        </div>
      )}

      {isConnected && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-2xl border border-gray-200 p-4">
              <div className="text-xs text-gray-500">Token</div>
              <div className="text-base font-medium">
                {(tokenName as string) || '—'} {tokenSymbol ? `(${tokenSymbol})` : ''}
              </div>
            </div>
            <div className="rounded-2xl border border-gray-200 p-4">
              <div className="text-xs text-gray-500">Your Balance</div>
              <div className="text-base font-medium">{formattedTokenBalance}</div>
            </div>
          </div>

          <div className="rounded-2xl border border-gray-200 p-4">
            <div className="text-xs text-gray-500 mb-1">Your Bank Deposit</div>
            <div className="text-base font-medium">{formattedBankDeposit}</div>
          </div>

          {/* Deposit with Permit */}
          <div className="rounded-2xl border border-gray-200 p-5">
            <h2 className="text-lg font-semibold mb-3">Deposit with Permit</h2>

            <label className="text-sm font-medium">Amount to Deposit</label>
            <input
              className={`mt-1 w-full rounded-xl border p-3 text-sm outline-none transition
                ${depositAmountError ? 'border-red-400 focus:ring-2 focus:ring-red-200' : 'border-gray-200 focus:ring-2 focus:ring-gray-200'}`}
              placeholder="e.g., 1.23"
              inputMode="decimal"
              value={depositAmount}
              onChange={(e) => setDepositAmount(e.target.value.trim())}
              onBlur={(e) => {
                const v = e.target.value.replace(/\.$/, '');
                if (v !== e.target.value) setDepositAmount(v);
              }}
              disabled={!correctNetwork}
            />
            {depositAmountError && <div className="text-xs text-red-500 mt-2">{depositAmountError}</div>}

            <button
              onClick={handleDepositWithPermit}
              disabled={!canDeposit}
              className={`mt-4 w-full rounded-xl px-4 py-3 text-sm font-medium transition
                ${canDeposit ? 'bg-black text-white hover:opacity-90' : 'bg-gray-200 text-gray-500 cursor-not-allowed'}`}
            >
              {isWritePending ? 'Check Wallet…' : isConfirming ? 'Processing…' : 'Deposit with Permit'}
            </button>
          </div>

          {/* Status + Explorer */}
          {(transactionStatus || (isConfirmed && hash && explorerBase)) && (
            <div className="rounded-2xl border border-gray-200 p-4">
              {transactionStatus && <p className="text-sm">Status: {transactionStatus}</p>}
              {isConfirmed && hash && explorerBase && (
                <p className="text-sm mt-2">
                  <a
                    className="underline text-blue-600"
                    href={`${explorerBase}/tx/${hash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View on explorer
                  </a>
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

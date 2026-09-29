import {
  appendTransactionMessageInstructions,
  assertIsSendableTransaction,
  assertIsTransactionWithBlockhashLifetime,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Commitment,
  type Instruction,
  type Rpc,
  type RpcSubscriptions,
  type Signature,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
  type TransactionSigner,
} from "@solana/kit";

export type SolanaConnection = {
  rpc: Rpc<SolanaRpcApi>;
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
};

/** WebSocket URL defaults to the RPC URL with `http` replaced by `ws`. */
export function createConnection(rpcUrl: string, wsUrl?: string): SolanaConnection {
  return {
    rpc: createSolanaRpc(rpcUrl),
    rpcSubscriptions: createSolanaRpcSubscriptions(wsUrl ?? rpcUrl.replace(/^http/, "ws")),
  };
}

/**
 * Builds, signs (with the fee payer and every signer attached to the instructions), sends and
 * confirms one transaction. Returns its signature; throws if it fails or expires.
 */
export async function sendInstructions(
  connection: SolanaConnection,
  feePayer: TransactionSigner,
  instructions: Instruction[],
  options: { commitment?: Commitment; abortSignal?: AbortSignal } = {},
): Promise<Signature> {
  const commitment = options.commitment ?? "confirmed";
  const { value: blockhash } = await connection.rpc
    .getLatestBlockhash({ commitment })
    .send(options.abortSignal ? { abortSignal: options.abortSignal } : undefined);
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  assertIsSendableTransaction(transaction);
  assertIsTransactionWithBlockhashLifetime(transaction);
  await sendAndConfirmTransactionFactory(connection)(transaction, {
    commitment,
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
  });
  return getSignatureFromTransaction(transaction);
}

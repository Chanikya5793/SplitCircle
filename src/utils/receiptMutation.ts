import type { ReceiptMetadata } from '@/models/expense';

export const receiptObjectPath = (groupId: string, expenseId: string, fileName: string): string =>
  `groups/${groupId}/expenses/${expenseId}/${fileName}`;

export function planReceiptUpload(args: {
  groupId: string;
  expenseId: string;
  current?: ReceiptMetadata;
  fileUri: string;
  originalFileName?: string;
  uniqueId: string;
}): { fileName: string; uploadPath: string; oldPath?: string } {
  const extensionSource = args.originalFileName?.includes('.') ? args.originalFileName : args.fileUri;
  const candidateExtension = extensionSource.split('.').pop()?.split('?')[0] || 'jpg';
  const extension = /^[a-z0-9]{1,8}$/i.test(candidateExtension) ? candidateExtension.toLowerCase() : 'jpg';
  const safeId = args.uniqueId.replace(/[^a-z0-9-]/gi, '').slice(0, 64) || 'new';
  const fileName = `receipt-${safeId}.${extension}`;
  return {
    fileName,
    uploadPath: receiptObjectPath(args.groupId, args.expenseId, fileName),
    oldPath: args.current?.url
      ? receiptObjectPath(args.groupId, args.expenseId, args.current.fileName || 'receipt.jpg')
      : undefined,
  };
}

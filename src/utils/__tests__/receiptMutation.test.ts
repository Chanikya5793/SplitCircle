import { describe, expect, it } from 'vitest';
import { planReceiptUpload, receiptObjectPath } from '../receiptMutation';

describe('receipt mutation planning', () => {
  it('uses a unique path even when the replacement has the same original name', () => {
    const plan = planReceiptUpload({
      groupId: 'g1',
      expenseId: 'e1',
      current: { url: 'https://old', fileName: 'receipt.jpg' },
      fileUri: 'file:///tmp/receipt.jpg',
      originalFileName: 'receipt.jpg',
      uniqueId: 'new-id',
    });
    expect(plan.oldPath).toBe('groups/g1/expenses/e1/receipt.jpg');
    expect(plan.uploadPath).toBe('groups/g1/expenses/e1/receipt-new-id.jpg');
    expect(plan.uploadPath).not.toBe(plan.oldPath);
  });

  it('falls back to the legacy receipt path when old metadata lacks a filename', () => {
    const plan = planReceiptUpload({
      groupId: 'g1', expenseId: 'e1', current: { url: 'https://old' },
      fileUri: 'file:///tmp/new.png', uniqueId: 'next',
    });
    expect(plan.oldPath).toBe('groups/g1/expenses/e1/receipt.jpg');
  });

  it('sanitizes unsafe ids and extensions before building a storage path', () => {
    const plan = planReceiptUpload({
      groupId: 'g1', expenseId: 'e1', fileUri: 'file:///tmp/nope.bad/ext',
      originalFileName: 'receipt.../../secret', uniqueId: '../unsafe id',
    });
    expect(plan.fileName).toBe('receipt-unsafeid.jpg');
    expect(plan.uploadPath).toBe(receiptObjectPath('g1', 'e1', plan.fileName));
    expect(plan.uploadPath).not.toContain('..');
  });

  it('does not schedule deletion when the current receipt has no stored object', () => {
    const plan = planReceiptUpload({
      groupId: 'g1', expenseId: 'e1', current: { insights: {} },
      fileUri: 'file:///tmp/new.heic', uniqueId: 'next',
    });
    expect(plan.oldPath).toBeUndefined();
    expect(plan.fileName).toBe('receipt-next.heic');
  });

  it('uses the URI extension when the display name has no extension', () => {
    const plan = planReceiptUpload({
      groupId: 'g1', expenseId: 'e1', fileUri: 'file:///tmp/photo.PNG?size=2',
      originalFileName: 'Receipt photo', uniqueId: 'next',
    });
    expect(plan.fileName).toBe('receipt-next.png');
  });
});

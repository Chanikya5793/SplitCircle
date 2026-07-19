/**
 * metaCommands.test.ts — chat-control / social messages must be caught BEFORE
 * the expense pipeline so "Clear the chat" never returns a spend total and
 * "Hello" never dumps a settle-up plan (doc-17 failures #1, #2).
 */

import { describe, expect, it } from 'vitest';
import { detectMetaCommand } from '../assistantChat';

describe('detectMetaCommand', () => {
  it('detects clear-chat phrasings', () => {
    for (const s of ['clear the chat', 'Clear chat', 'reset conversation', 'start over', 'wipe history', 'new conversation']) {
      expect(detectMetaCommand(s)).toBe('clear_chat');
    }
  });

  it('detects greetings', () => {
    for (const s of ['Hello', 'hi', 'hey!', 'yo', 'good morning', 'Namaste']) {
      expect(detectMetaCommand(s)).toBe('greeting');
    }
  });

  it('detects help / capabilities', () => {
    expect(detectMetaCommand('what can you do?')).toBe('help');
    expect(detectMetaCommand('help')).toBe('help');
  });

  it('detects thanks and goodbye', () => {
    expect(detectMetaCommand('thanks!')).toBe('thanks');
    expect(detectMetaCommand('bye')).toBe('goodbye');
  });

  it('does NOT capture real expense questions', () => {
    for (const s of ['how much did I spend on food?', 'settle up with Sam', 'add $20 lunch', 'what were our biggest expenses?']) {
      expect(detectMetaCommand(s)).toBeNull();
    }
  });

  it('does not mistake "hi" inside a word for a greeting', () => {
    expect(detectMetaCommand('history of my spending')).not.toBe('greeting');
  });
});

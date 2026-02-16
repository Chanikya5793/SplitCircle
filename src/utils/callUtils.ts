import type { CallSession } from '@/models';

/**
 * Determines if a call was missed by the specified user
 */
export const isMissedCall = (call: CallSession, currentUserId: string): boolean => {
  const isOutgoing = call.initiatorId === currentUserId;
  return call.status === 'missed' || (call.status === 'ended' && !call.connectedAt && !isOutgoing);
};

/**
 * Formats call duration in seconds to a readable string
 */
export const formatCallDuration = (seconds?: number): string => {
  if (!seconds || seconds === 0) return 'Not connected';
  
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  
  if (mins === 0) return `${secs}s`;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

/**
 * Gets the appropriate icon and color for a call based on its status
 */
export const getCallStatusIcon = (call: CallSession, currentUserId: string): { icon: string; color: string } => {
  const isOutgoing = call.initiatorId === currentUserId;
  
  if (isMissedCall(call, currentUserId)) {
    return { icon: 'phone-missed', color: '#E03C31' };
  }
  
  if (call.status === 'rejected') {
    return { icon: 'phone-hangup', color: '#E03C31' };
  }
  
  if (isOutgoing) {
    return { icon: 'phone-outgoing', color: '#2BB673' };
  }
  
  return { icon: 'phone-incoming', color: '#58A6FF' };
};

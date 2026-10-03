import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@expo/vector-icons/Ionicons', () => ({ default: () => null }));
import { CallControls } from '../CallControls';

afterEach(cleanup);

describe('responsive call controls', () => {
  it('keeps each video action wired to its own handler', () => {
    const handlers = {
      onToggleMic: vi.fn(), onToggleCamera: vi.fn(), onToggleSpeaker: vi.fn(),
      onFlipCamera: vi.fn(), onHangUp: vi.fn(),
    };
    render(<CallControls micEnabled cameraEnabled {...handlers} />);
    for (const name of ['Mute microphone', 'Turn camera off', 'Speaker off. Long-press to choose output', 'Flip camera', 'End call']) {
      fireEvent.click(screen.getByRole('button', { name }));
    }
    for (const handler of Object.values(handlers)) expect(handler).toHaveBeenCalledTimes(1);
  });

  it('preserves audio controls without offering unavailable video actions', () => {
    const onHangUp = vi.fn();
    const onToggleMic = vi.fn();
    const onAudioRoute = vi.fn();
    render(<CallControls micEnabled={false} cameraEnabled={false} onToggleMic={onToggleMic} onAudioRoute={onAudioRoute} onHangUp={onHangUp} />);
    expect(screen.queryByRole('button', { name: /camera/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Unmute microphone' }));
    fireEvent.click(screen.getByRole('button', { name: 'Speaker off. Long-press to choose output' }));
    fireEvent.click(screen.getByRole('button', { name: 'End call' }));
    expect(onToggleMic).toHaveBeenCalledTimes(1);
    expect(onAudioRoute).toHaveBeenCalledTimes(1);
    expect(onHangUp).toHaveBeenCalledTimes(1);
  });

  it('updates camera and microphone actions without losing End call', () => {
    const onToggleCamera = vi.fn();
    const onToggleMic = vi.fn();
    const view = render(<CallControls micEnabled cameraEnabled onToggleCamera={onToggleCamera} onToggleMic={onToggleMic} onHangUp={() => {}} />);
    view.rerender(<CallControls micEnabled={false} cameraEnabled={false} onToggleCamera={onToggleCamera} onToggleMic={onToggleMic} onHangUp={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Turn camera on' }));
    fireEvent.click(screen.getByRole('button', { name: 'Unmute microphone' }));
    expect(onToggleCamera).toHaveBeenCalledTimes(1);
    expect(onToggleMic).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'End call' })).toBeTruthy();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from '../EventBus';

describe('EventBus', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  describe('emit and subscribe', () => {
    it('calls subscriber when event is emitted', () => {
      const handler = vi.fn();
      eventBus.subscribe('test-event', handler);

      eventBus.emit('test-event', { data: 'test' });

      expect(handler).toHaveBeenCalledWith({ data: 'test' });
    });

    it('supports multiple subscribers for same event', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      eventBus.subscribe('test-event', handler1);
      eventBus.subscribe('test-event', handler2);

      eventBus.emit('test-event', 'payload');

      expect(handler1).toHaveBeenCalledWith('payload');
      expect(handler2).toHaveBeenCalledWith('payload');
    });

    it('does not call unsubscribed handlers', () => {
      const handler = vi.fn();
      const unsubscribe = eventBus.subscribe('test-event', handler);

      unsubscribe();
      eventBus.emit('test-event', 'test');

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('once', () => {
    it('only fires handler once', () => {
      const handler = vi.fn();
      eventBus.once('test-event', handler);

      eventBus.emit('test-event', 'first');
      eventBus.emit('test-event', 'second');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith('first');
    });
  });

  describe('clear', () => {
    it('removes all handlers for specific event', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      eventBus.subscribe('event-a', handler1);
      eventBus.subscribe('event-b', handler2);

      eventBus.clear('event-a');
      eventBus.emit('event-a', 'test');
      eventBus.emit('event-b', 'test');

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it('clears all handlers when no event specified', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      eventBus.subscribe('event-a', handler1);
      eventBus.subscribe('event-b', handler2);

      eventBus.clear();
      eventBus.emit('event-a', 'test');
      eventBus.emit('event-b', 'test');

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });
  });
});

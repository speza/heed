import { describe, expect, test } from "vitest";
import { isModifiedTerminalKey, modifiedTerminalInput, type TerminalKeyboardEvent } from "./terminalKeyboard";

function keyboardEvent(overrides: Partial<TerminalKeyboardEvent> = {}): TerminalKeyboardEvent {
  return {
    altKey: false,
    ctrlKey: false,
    key: "Enter",
    metaKey: false,
    shiftKey: false,
    type: "keydown",
    ...overrides,
  };
}

describe("terminal keyboard input", () => {
  test("encodes Shift+Enter distinctly using CSI-u", () => {
    const event = keyboardEvent({ shiftKey: true });
    expect(isModifiedTerminalKey(event)).toBe(true);
    expect(modifiedTerminalInput(event)).toEqual(Uint8Array.of(0x1b, 0x5b, 0x31, 0x33, 0x3b, 0x32, 0x75));
  });

  test("does not emit the sequence twice for the follow-up keypress", () => {
    expect(modifiedTerminalInput(keyboardEvent({ shiftKey: true, type: "keypress" }))).toBeUndefined();
  });

  test("leaves ordinary and combined-modifier keys to xterm", () => {
    expect(isModifiedTerminalKey(keyboardEvent())).toBe(false);
    expect(modifiedTerminalInput(keyboardEvent({ ctrlKey: true, shiftKey: true }))).toBeUndefined();
    expect(modifiedTerminalInput(keyboardEvent({ key: "a", shiftKey: true }))).toBeUndefined();
  });
});

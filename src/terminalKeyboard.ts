export type TerminalKeyboardEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey" | "type"
>;

const SHIFT_ENTER_CSI_U = Uint8Array.of(0x1b, 0x5b, 0x31, 0x33, 0x3b, 0x32, 0x75);

export function isModifiedTerminalKey(event: TerminalKeyboardEvent): boolean {
  return event.key === "Enter" && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
}

export function modifiedTerminalInput(event: TerminalKeyboardEvent): Uint8Array | undefined {
  return event.type === "keydown" && isModifiedTerminalKey(event) ? SHIFT_ENTER_CSI_U : undefined;
}

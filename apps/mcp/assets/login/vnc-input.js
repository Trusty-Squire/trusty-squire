export function sendTextAsKeysyms(rfb, value, keysyms) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    const keysym = keysyms.lookup(codePoint);
    rfb.sendKey(keysym, null, true);
    rfb.sendKey(keysym, null, false);
  }
}

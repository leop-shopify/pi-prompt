#!/usr/bin/env node
// Raw stdin byte logger. Run it, press keys, watch the escape sequences.
// Ctrl+C (or typing the letter q alone) exits.
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");

function show(s) {
  const hex = [...s].map((c) => c.codePointAt(0).toString(16).padStart(2, "0")).join(" ");
  const printable = s
    .replace(/\x1b/g, "ESC")
    .replace(/[\x00-\x1f]/g, (c) => "^" + String.fromCharCode(c.charCodeAt(0) + 64));
  return `${JSON.stringify(s).padEnd(20)}  hex: ${hex.padEnd(28)}  ${printable}`;
}

process.stdout.write("Key logger. Press keys (try Option+Left, Option+Right, Cmd+Left...). Ctrl+C to quit.\r\n\r\n");

process.stdin.on("data", (data) => {
  if (data === "\x03") {
    process.stdout.write("\r\nbye\r\n");
    process.stdin.setRawMode?.(false);
    process.exit(0);
  }
  process.stdout.write(show(data) + "\r\n");
});
